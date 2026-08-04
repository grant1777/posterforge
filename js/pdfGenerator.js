/**
 * pdfGenerator.js
 * -----------------------------------------------------------------------------
 * Builds genuine print-ready PDFs with pdf-lib.
 *
 * The important distinction: this does **not** wrap an image in a PDF envelope
 * and hope for the best. Every document gets a page whose MediaBox is the exact
 * physical trim size (in PDF points, 1/72 in), a background painted as a vector
 * rectangle, and an image XObject placed at an exact physical rectangle. Open
 * the result in Acrobat and Document Properties will report "8.5 × 11 in", and
 * the raster resolves at the DPI you asked for — because the embedded bitmap is
 * sized `inches × DPI` pixels.
 */

import { POINTS_PER_INCH } from './paperSizes.js';
import { analyzeImage } from './qualityAnalyzer.js';
import {
  decodeToBitmap, resampleImage, encodeCanvas, clampRenderSize,
} from './imageProcessor.js';

/** Metadata stamped into every document. */
const PRODUCER = 'PosterForge';

/**
 * @typedef {Object} PosterResult
 * @property {string} id           Matching source image id.
 * @property {string} name         Source file name.
 * @property {string} filename     Suggested download name.
 * @property {Blob}   blob         The finished PDF.
 * @property {number} bytes        Actual PDF size.
 * @property {import('./qualityAnalyzer.js').QualityReport} report
 * @property {string[]} warnings   Non-fatal notes worth surfacing.
 */

/**
 * Resolve the concrete CSS colour used to paint the page background.
 *
 * @param {import('./app.js').Settings} settings
 * @returns {string|null} A CSS colour, or null when the page stays transparent.
 */
function resolveBackground(settings) {
  switch (settings.background) {
    case 'transparent': return null;
    case 'black': return '#000000';
    case 'custom': return settings.backgroundColor;
    case 'white':
    default: return '#ffffff';
  }
}

/**
 * Convert a `#rrggbb` string to pdf-lib's 0–1 RGB triple.
 *
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number }}
 */
function hexToRgb(hex) {
  const normalized = hex.replace('#', '').trim();
  const full = normalized.length === 3
    ? normalized.split('').map((char) => char + char).join('')
    : normalized;
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return { r: 1, g: 1, b: 1 };
  return {
    r: ((value >> 16) & 0xff) / 255,
    g: ((value >> 8) & 0xff) / 255,
    b: (value & 0xff) / 255,
  };
}

/**
 * Build one poster PDF.
 *
 * @param {import('./imageProcessor.js').DecodedImage} image
 * @param {import('./app.js').Settings} settings
 * @param {(stage: string) => void} [onStage]  Fine-grained progress reporting.
 * @returns {Promise<PosterResult>}
 */
export async function generatePoster(image, settings, onStage = () => {}) {
  const { PDFDocument, rgb } = window.PDFLib;
  const warnings = [];

  // The analyser already resolved the page and the placement. Reusing its
  // result — rather than recomputing — guarantees the PDF matches the numbers
  // the preview showed, byte for byte.
  const report = analyzeImage(image, settings);
  const { page, placement } = report;

  // ── 1. Work out the raster grid ─────────────────────────────────────────────
  // The resampled bitmap covers `placement`; in Fill mode it is then cropped
  // down to the page, discarding the overhang.
  const visibleWidth = Math.min(placement.width, page.width);
  const visibleHeight = Math.min(placement.height, page.height);

  const requested = clampRenderSize(
    Math.round(placement.width * settings.dpi),
    Math.round(placement.height * settings.dpi),
  );
  if (requested.clamped) {
    warnings.push(
      `Render size exceeded this browser's canvas limit; DPI reduced to about `
      + `${Math.round(settings.dpi * requested.scale)} for this poster.`,
    );
  }

  const renderScale = requested.scale;
  const cropWidth = Math.max(1, Math.round(visibleWidth * settings.dpi * renderScale));
  const cropHeight = Math.max(1, Math.round(visibleHeight * settings.dpi * renderScale));

  // ── 2. Decode and resample ──────────────────────────────────────────────────
  onStage('Resizing');
  const bitmap = await decodeToBitmap(image.file);

  let canvas;
  try {
    canvas = await resampleImage(bitmap, {
      targetWidth: requested.width,
      targetHeight: requested.height,
      cropWidth,
      cropHeight,
      background: resolveBackground(settings),
    });
  } finally {
    bitmap.close?.();
  }

  // ── 3. Encode the raster ────────────────────────────────────────────────────
  onStage('Encoding');
  const transparent = settings.background === 'transparent';
  const { bytes, format } = await encodeCanvas(canvas, {
    transparent,
    jpegQuality: settings.jpegQuality,
  });

  // Free the (potentially enormous) backing store as soon as possible.
  canvas.width = 0;
  canvas.height = 0;

  // ── 4. Assemble the document ────────────────────────────────────────────────
  onStage('Generating PDF');
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(stripExtension(image.name));
  // Note: pdf-lib hard-codes the Producer field during save and ignores
  // `setProducer`, so the attribution goes in Creator, which does survive.
  pdfDoc.setCreator(`${PRODUCER} — local, browser-based poster generator`);
  pdfDoc.setSubject(
    `${page.width.toFixed(2)} × ${page.height.toFixed(2)} in poster at ${settings.dpi} DPI`,
  );
  pdfDoc.setKeywords([PRODUCER, `${settings.dpi}dpi`, settings.paper.id, settings.fitMode]);
  pdfDoc.setCreationDate(new Date());
  pdfDoc.setModificationDate(new Date());

  const pageWidthPt = page.width * POINTS_PER_INCH;
  const pageHeightPt = page.height * POINTS_PER_INCH;
  const pdfPage = pdfDoc.addPage([pageWidthPt, pageHeightPt]);

  const background = resolveBackground(settings);
  if (background) {
    const { r, g, b } = hexToRgb(background);
    pdfPage.drawRectangle({
      x: 0, y: 0, width: pageWidthPt, height: pageHeightPt, color: rgb(r, g, b),
    });
  }

  const embedded = format === 'png'
    ? await pdfDoc.embedPng(bytes)
    : await pdfDoc.embedJpg(bytes);

  // The visible rectangle: the whole page in Fill mode, the placement otherwise.
  const drawWidth = placement.cropped ? page.width : placement.width;
  const drawHeight = placement.cropped ? page.height : placement.height;
  const drawX = (page.width - drawWidth) / 2;
  const drawYFromTop = (page.height - drawHeight) / 2;

  pdfPage.drawImage(embedded, {
    x: drawX * POINTS_PER_INCH,
    // PDF's origin is bottom-left; our geometry is top-left.
    y: (page.height - drawYFromTop - drawHeight) * POINTS_PER_INCH,
    width: drawWidth * POINTS_PER_INCH,
    height: drawHeight * POINTS_PER_INCH,
  });

  // `updateMetadata: false` keeps the Producer/ModDate we set above; pdf-lib
  // otherwise stamps its own over them during save.
  const pdfBytes = await pdfDoc.save({ useObjectStreams: true, updateMetadata: false });
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });

  if (report.stars <= 2) {
    warnings.push(`Low effective resolution (${Math.round(report.effectiveDpi)} DPI).`);
  }
  if (placement.cropped) {
    warnings.push('Fill mode cropped the edges of this image.');
  }
  if (!settings.keepAspect) {
    warnings.push('Aspect ratio was not preserved — the image is stretched.');
  }

  return {
    id: image.id,
    name: image.name,
    filename: buildFilename(image.name, settings, page),
    blob,
    bytes: blob.size,
    report,
    warnings,
  };
}

/**
 * Generate posters for a batch, yielding each result as it completes.
 *
 * Implemented as an async generator so the caller drives the loop: the UI can
 * paint progress, and cancellation takes effect between images rather than
 * requiring the whole batch to finish.
 *
 * @param {import('./imageProcessor.js').DecodedImage[]} images
 * @param {import('./app.js').Settings} settings
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {(progress: { index: number, total: number, stage: string, name: string }) => void} [options.onProgress]
 * @yields {{ ok: true, result: PosterResult } | { ok: false, id: string, name: string, error: Error }}
 */
export async function* generatePosters(images, settings, { signal, onProgress = () => {} } = {}) {
  for (const [index, image] of images.entries()) {
    if (signal?.aborted) return;

    const report = (stage) => onProgress({ index, total: images.length, stage, name: image.name });
    report('Preparing');

    try {
      const result = await generatePoster(image, settings, report);
      yield { ok: true, result };
    } catch (error) {
      yield {
        ok: false,
        id: image.id,
        name: image.name,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }

    // Hand the main thread back so the browser can paint and stay responsive
    // even across a batch of several hundred posters.
    await nextFrame();
  }
}

/**
 * Yield to the event loop, preferring a real frame boundary.
 *
 * @returns {Promise<void>}
 */
function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * @param {string} name
 * @returns {string} File name without its final extension.
 */
function stripExtension(name) {
  return name.replace(/\.[^./\\]+$/, '') || name;
}

/**
 * Build a descriptive, filesystem-safe download name.
 *
 * @param {string} sourceName
 * @param {import('./app.js').Settings} settings
 * @param {{ orientation: string }} page
 * @returns {string}
 */
function buildFilename(sourceName, settings, page) {
  const base = stripExtension(sourceName)
    .replace(/[\\/:*?"<>|]+/g, '-')   // Characters Windows forbids.
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'poster';

  const suffix = `${settings.paper.id}-${page.orientation}-${settings.dpi}dpi`;
  return `${base}_${suffix}.pdf`;
}

/**
 * Ensure every name in a batch is unique, appending ` (2)`, ` (3)`, … as needed.
 * Two files called `photo.jpg` from different folders must not silently
 * overwrite each other inside a ZIP.
 *
 * @param {string[]} names
 * @returns {string[]}
 */
export function deduplicateFilenames(names) {
  const seen = new Map();
  return names.map((name) => {
    const key = name.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count === 0) return name;
    return name.replace(/\.pdf$/i, ` (${count + 1}).pdf`);
  });
}
