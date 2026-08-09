/**
 * imageProcessor.js
 * -----------------------------------------------------------------------------
 * Everything pixel-related: decoding user files, building preview thumbnails,
 * and producing the high-quality resampled bitmap that ends up inside the PDF.
 *
 * Resampling prefers Pica (Lanczos, in Web Workers). The browser's native
 * `drawImage` scaling is bilinear-ish, unspecified, and visibly mushy at poster
 * sizes, so it is only used for 1:1 blits, the tiny preview thumbnails where
 * quality is irrelevant, and the fallback path below.
 *
 * That fallback exists because Pica needs `getImageData`, and browsers with
 * canvas-fingerprinting protection (Brave Shields, Firefox's
 * `privacy.resistFingerprinting`, several privacy extensions) perturb the pixels
 * it reads back. Pica detects the mismatch and refuses to run at all. Rather
 * than failing every poster in the batch, we resample with `createImageBitmap`'s
 * high-quality resizer — slightly softer than Lanczos, but perfectly printable.
 */

/** Lazily-created singleton Pica instance (it owns a worker pool). */
let picaInstance = null;

/** Cached result of the canvas read-back probe; null until first asked. */
let canvasReadbackOk = null;

/** Set the first time a poster falls back off Pica, for one-time UI reporting. */
let fallbackReason = null;

/**
 * @returns {any} The shared Pica instance.
 * @throws {Error} If the Pica library has not loaded.
 */
function getPica() {
  if (!picaInstance) {
    if (typeof window.pica !== 'function') {
      throw new Error('Pica failed to load. Check that libs/pica.min.js is present.');
    }
    picaInstance = window.pica({ features: ['js', 'wasm', 'ww'] });
  }
  return picaInstance;
}

/** Pica resize options — highest-quality Lanczos with mild unsharp masking. */
const RESIZE_OPTIONS = Object.freeze({
  filter: 'lanczos3',   // 3-lobe Lanczos: the sharpest general-purpose kernel.
  unsharpAmount: 55,    // Gentle; counteracts the softening any resample causes.
  unsharpRadius: 0.6,
  unsharpThreshold: 2,  // Leaves flat areas (skies, gradients) untouched.
  alpha: true,
});

/**
 * Safety valve for canvas allocation. Browsers cap total canvas *area*
 * (Chrome ≈ 268 Mpx, Safari far lower) and blow up with a blank canvas rather
 * than an exception. 24 × 36 in at 600 DPI would be 311 Mpx, so we clamp.
 */
const MAX_CANVAS_PIXELS = 80_000_000;

/** Longest edge any single canvas dimension may reach. */
const MAX_CANVAS_EDGE = 16_384;

/** File extensions accepted in addition to whatever `image/*` matches. */
const EXTRA_EXTENSIONS = ['.tif', '.tiff', '.avif', '.bmp', '.webp', '.heic', '.heif'];

/** Longest edge of a preview thumbnail, in CSS pixels (x2 for retina). */
const THUMBNAIL_EDGE = 512;

/**
 * @typedef {Object} DecodedImage
 * @property {string} id            Unique id for this entry.
 * @property {File}   file          The original File handle.
 * @property {string} name          File name.
 * @property {number} bytes         File size in bytes.
 * @property {string} type          MIME type as reported by the browser.
 * @property {number} width         Source pixel width.
 * @property {number} height        Source pixel height.
 * @property {string} thumbnailUrl  Object URL for the preview thumbnail.
 * @property {boolean} hasAlpha     Whether the source format can carry alpha.
 */

/**
 * True when a File looks like something the browser might decode as an image.
 *
 * Some formats (TIFF, HEIC) arrive with an empty or generic MIME type on
 * Windows, so extensions are consulted as a fallback. Decoding is still the
 * real test — this only avoids obviously wrong files.
 *
 * @param {File} file
 * @returns {boolean}
 */
export function isProbablyImage(file) {
  if (file.type.startsWith('image/')) return true;
  const name = file.name.toLowerCase();
  return EXTRA_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * Decode a file into an ImageBitmap-backed record with a preview thumbnail.
 *
 * Animated GIF/WEBP files decode to their first frame, which is exactly the
 * behaviour a poster generator wants.
 *
 * @param {File} file
 * @param {string} id
 * @returns {Promise<DecodedImage>}
 * @throws {Error} With a user-presentable message when decoding fails.
 */
export async function decodeImageFile(file, id) {
  const bitmap = await decodeToBitmap(file);

  try {
    const thumbnailUrl = await createThumbnail(bitmap);
    return {
      id,
      file,
      name: file.name,
      bytes: file.size,
      type: file.type || guessTypeFromName(file.name),
      width: bitmap.width,
      height: bitmap.height,
      thumbnailUrl,
      hasAlpha: /png|webp|gif|avif/i.test(file.type || file.name),
    };
  } finally {
    // The full-size bitmap is re-decoded on demand at generation time; holding
    // hundreds of them would exhaust memory long before the batch finished.
    bitmap.close?.();
  }
}

/**
 * Decode a File to an ImageBitmap, preferring `createImageBitmap` and falling
 * back to an `<img>` element for browsers/formats it refuses.
 *
 * @param {File|Blob} file
 * @returns {Promise<ImageBitmap|HTMLImageElement>}
 */
export async function decodeToBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      // `imageOrientation: 'from-image'` honours EXIF rotation, so phone photos
      // are not printed sideways.
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* Fall through to the <img> path. */
    }
  }
  return decodeViaImageElement(file);
}

/**
 * Legacy decode path via an `<img>` element and an object URL.
 *
 * @param {File|Blob} file
 * @returns {Promise<HTMLImageElement>}
 */
function decodeViaImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      URL.revokeObjectURL(url);
      if (!image.naturalWidth || !image.naturalHeight) {
        reject(new Error('Image decoded with zero dimensions.'));
        return;
      }
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This browser cannot decode that image format.'));
    };
    image.src = url;
  });
}

/**
 * Build a small preview thumbnail. Speed matters far more than quality here,
 * so this intentionally uses the native scaler.
 *
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @returns {Promise<string>} Object URL — the caller owns it and must revoke it.
 */
async function createThumbnail(bitmap) {
  const sourceWidth = bitmap.width ?? bitmap.naturalWidth;
  const sourceHeight = bitmap.height ?? bitmap.naturalHeight;
  const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(sourceWidth, sourceHeight));

  const canvas = createCanvas(
    Math.max(1, Math.round(sourceWidth * scale)),
    Math.max(1, Math.round(sourceHeight * scale)),
  );
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.82);
  return URL.createObjectURL(blob);
}

/**
 * Resample an image to an exact pixel size using Pica's Lanczos filter, then
 * crop it to the page when the placement overflows (Fill mode).
 *
 * @param {ImageBitmap|HTMLImageElement} bitmap  Source at native resolution.
 * @param {Object} spec
 * @param {number} spec.targetWidth   Resampled width, pixels.
 * @param {number} spec.targetHeight  Resampled height, pixels.
 * @param {number} [spec.cropWidth]   Final width after cropping, pixels.
 * @param {number} [spec.cropHeight]  Final height after cropping, pixels.
 * @param {string|null} spec.background  CSS colour, or null to keep alpha.
 * @returns {Promise<HTMLCanvasElement>} Canvas holding the finished artwork.
 */
export async function resampleImage(bitmap, spec) {
  const { targetWidth, targetHeight, background } = spec;

  const source = toSourceCanvas(bitmap);
  const resized = createCanvas(targetWidth, targetHeight);

  if (targetWidth === source.width && targetHeight === source.height) {
    // Already the right size: a straight blit is both faster and lossless.
    resized.getContext('2d').drawImage(source, 0, 0);
  } else if (!canReadCanvasPixels()) {
    noteFallback(
      'This browser blocks reading pixels back from a canvas (canvas '
      + 'fingerprinting protection), so Lanczos resampling was unavailable. '
      + 'Posters used the browser\'s own high-quality resizer instead.',
    );
    await resizeWithoutReadback(source, resized);
  } else {
    try {
      await getPica().resize(source, resized, RESIZE_OPTIONS);
    } catch (error) {
      noteFallback(
        `Lanczos resampling failed (${error.message}) — posters used the `
        + 'browser\'s own high-quality resizer instead.',
      );
      await resizeWithoutReadback(source, resized);
    }
  }

  const cropWidth = Math.min(spec.cropWidth ?? targetWidth, targetWidth);
  const cropHeight = Math.min(spec.cropHeight ?? targetHeight, targetHeight);
  const needsCrop = cropWidth !== targetWidth || cropHeight !== targetHeight;

  if (!needsCrop && !background) return resized;

  // Compose onto the final surface: background first (so JPEG has no black
  // fringing where alpha used to be), then the centre crop of the artwork.
  const output = createCanvas(cropWidth, cropHeight);
  const context = output.getContext('2d');

  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, cropWidth, cropHeight);
  }

  context.drawImage(
    resized,
    Math.round((targetWidth - cropWidth) / 2),
    Math.round((targetHeight - cropHeight) / 2),
    cropWidth, cropHeight,
    0, 0, cropWidth, cropHeight,
  );

  return output;
}

/**
 * Encode a canvas for embedding in a PDF.
 *
 * JPEG is used for opaque output (dramatically smaller for photographs); PNG is
 * used whenever transparency must survive.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ transparent: boolean, jpegQuality: number }} options
 * @returns {Promise<{ bytes: Uint8Array, format: 'png'|'jpeg' }>}
 */
export async function encodeCanvas(canvas, { transparent, jpegQuality }) {
  const format = transparent ? 'png' : 'jpeg';
  const blob = await canvasToBlob(canvas, `image/${format}`, jpegQuality);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, format };
}

/**
 * Clamp a requested render size to something the browser can actually allocate.
 *
 * @param {number} width
 * @param {number} height
 * @returns {{ width: number, height: number, scale: number, clamped: boolean }}
 *          `scale` is the factor applied (1 when untouched).
 */
export function clampRenderSize(width, height) {
  const edgeScale = Math.min(1, MAX_CANVAS_EDGE / Math.max(width, height));
  const areaScale = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
  const scale = Math.min(edgeScale, areaScale);

  if (scale >= 1) return { width, height, scale: 1, clamped: false };

  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
    clamped: true,
  };
}

/**
 * Probe whether pixels written to a canvas come back unchanged.
 *
 * This is the same 2×1 round-trip Pica performs internally; running it up front
 * lets us choose a working path instead of catching Pica's error per image.
 * Anti-fingerprinting features add sub-perceptual noise to `getImageData`, which
 * makes the comparison fail.
 *
 * @returns {boolean}
 */
function canReadCanvasPixels() {
  if (canvasReadbackOk !== null) return canvasReadbackOk;

  canvasReadbackOk = false;
  try {
    const context = createCanvas(2, 1).getContext('2d');
    const written = context.createImageData(2, 1);
    const sample = [12, 23, 34, 255, 45, 56, 67, 255];
    sample.forEach((value, index) => { written.data[index] = value; });
    context.putImageData(written, 0, 0);

    const read = context.getImageData(0, 0, 2, 1);
    canvasReadbackOk = sample.every((value, index) => read.data[index] === value);
  } catch {
    /* Tainted canvas, or a browser that refuses getImageData outright. */
  }
  return canvasReadbackOk;
}

/**
 * Record why Pica was bypassed, so the UI can mention it once per session
 * instead of once per poster.
 *
 * @param {string} reason
 * @returns {void}
 */
function noteFallback(reason) {
  fallbackReason ??= reason;
}

/**
 * @returns {string|null} Why resampling fell back off Pica, or null if it did not.
 */
export function getResampleFallbackReason() {
  return fallbackReason;
}

/**
 * Resample without ever reading pixels back.
 *
 * `createImageBitmap`'s `resizeQuality: 'high'` is implemented by the browser's
 * compositor (a decent multi-tap filter) and needs no pixel access. Where it is
 * missing, successive halving through `drawImage` keeps far more detail than one
 * big bilinear jump.
 *
 * @param {HTMLCanvasElement} source
 * @param {HTMLCanvasElement} target  Pre-sized destination; overwritten entirely.
 * @returns {Promise<void>}
 */
async function resizeWithoutReadback(source, target) {
  const context = target.getContext('2d');
  context.clearRect(0, 0, target.width, target.height);

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(source, {
        resizeWidth: target.width,
        resizeHeight: target.height,
        resizeQuality: 'high',
      });
      context.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      return;
    } catch {
      /* Older Safari ignores or rejects the resize options; step down instead. */
    }
  }

  drawStepped(source, target);
}

/**
 * Downscale by repeated halving, then a final draw into the target.
 *
 * @param {HTMLCanvasElement} source
 * @param {HTMLCanvasElement} target
 * @returns {void}
 */
function drawStepped(source, target) {
  let current = source;
  let width = source.width;
  let height = source.height;

  while (width > target.width * 2 || height > target.height * 2) {
    width = Math.max(target.width, Math.round(width / 2));
    height = Math.max(target.height, Math.round(height / 2));

    const step = createCanvas(width, height);
    const stepContext = step.getContext('2d');
    stepContext.imageSmoothingEnabled = true;
    stepContext.imageSmoothingQuality = 'high';
    stepContext.drawImage(current, 0, 0, width, height);

    releaseIntermediate(current, source);
    current = step;
  }

  const context = target.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(current, 0, 0, target.width, target.height);
  releaseIntermediate(current, source);
}

/**
 * Free a scratch canvas, unless it is the caller's own source.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLCanvasElement} source
 * @returns {void}
 */
function releaseIntermediate(canvas, source) {
  if (canvas === source) return;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Wrap a bitmap in a canvas, because Pica needs a canvas or image source it can
 * read pixels from.
 *
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bitmap
 * @returns {HTMLCanvasElement}
 */
function toSourceCanvas(bitmap) {
  if (bitmap instanceof HTMLCanvasElement) return bitmap;

  const width = bitmap.width ?? bitmap.naturalWidth;
  const height = bitmap.height ?? bitmap.naturalHeight;
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  return canvas;
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {HTMLCanvasElement}
 */
function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/**
 * Promise wrapper around `canvas.toBlob`.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} mimeType
 * @param {number} [quality]
 * @returns {Promise<Blob>}
 */
function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas encoding failed — the image may be too large.'))),
      mimeType,
      quality,
    );
  });
}

/**
 * Best-effort MIME type from a file name, for files the OS did not label.
 *
 * @param {string} name
 * @returns {string}
 */
function guessTypeFromName(name) {
  const extension = name.toLowerCase().split('.').pop();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
    avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  };
  return map[extension] ?? 'application/octet-stream';
}

/**
 * Release the worker pool. Called on teardown; harmless if Pica never loaded.
 *
 * @returns {void}
 */
export function releaseResources() {
  picaInstance = null;
}
