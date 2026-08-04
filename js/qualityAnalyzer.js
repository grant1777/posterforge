/**
 * qualityAnalyzer.js
 * -----------------------------------------------------------------------------
 * Answers the only question that matters before you spend money at a print shop:
 * *will this actually look good?*
 *
 * The maths is deliberately simple and honest. Effective DPI is the number of
 * genuine source pixels that land in each printed inch:
 *
 *     effectiveDpi = sourcePixels / printedInches
 *
 * Upscaling — however good the resampler — cannot invent detail, so the rating
 * is always derived from the *original* pixel count, never from the upscaled
 * output. A 400 × 400 image blown up to 24 × 36 is 11 effective DPI no matter
 * how many Lanczos passes it survives, and PosterForge says so.
 */

import { resolvePageSize, computePlacement, formatInches } from './paperSizes.js';

/**
 * Rating tiers, ordered best → worst. The first tier whose `min` is met wins.
 *
 * The thresholds follow standard print-industry practice: 300 DPI is the
 * commercial reference, 150 DPI is the usual floor for close viewing, and large
 * format tolerates less because you stand further away.
 *
 * @type {ReadonlyArray<{ id: string, stars: number, label: string, min: number, tone: string }>}
 */
export const QUALITY_TIERS = Object.freeze([
  { id: 'excellent', stars: 5, label: 'Excellent', min: 300, tone: 'great' },
  { id: 'good',      stars: 4, label: 'Good',      min: 200, tone: 'good' },
  { id: 'fair',      stars: 3, label: 'Fair',      min: 150, tone: 'ok' },
  { id: 'poor',      stars: 2, label: 'Poor',      min: 100, tone: 'warn' },
  { id: 'very-poor', stars: 1, label: 'Very Poor', min: 0,   tone: 'bad' },
]);

/** DPI treated as the "ideal" reference when recommending a maximum print size. */
const REFERENCE_DPI = 300;

/**
 * @typedef {Object} QualityReport
 * @property {number}  sourceWidth        Original pixel width.
 * @property {number}  sourceHeight       Original pixel height.
 * @property {number}  targetWidth        Rendered pixel width at the chosen DPI.
 * @property {number}  targetHeight       Rendered pixel height at the chosen DPI.
 * @property {number}  printWidth         Printed width, inches.
 * @property {number}  printHeight        Printed height, inches.
 * @property {number}  effectiveDpi       Real source pixels per printed inch.
 * @property {number}  scaleFactor        Linear resample factor (>1 = upscaling).
 * @property {number}  stars              1–5.
 * @property {string}  ratingId           Tier id.
 * @property {string}  ratingLabel        "Excellent", "Good", …
 * @property {string}  tone               Tier tone, for CSS.
 * @property {string}  advice             One-sentence, human recommendation.
 * @property {boolean} cropped            True when Fill mode discards edges.
 * @property {number}  maxGoodWidth       Largest sensible print width, inches.
 * @property {number}  maxGoodHeight      Largest sensible print height, inches.
 * @property {{ width: number, height: number, orientation: string }} page
 * @property {import('./paperSizes.js').Placement} placement
 */

/**
 * Analyse how one image will print with the current settings.
 *
 * @param {{ width: number, height: number }} image  Source pixel dimensions.
 * @param {import('./app.js').Settings} settings
 * @returns {QualityReport}
 */
export function analyzeImage(image, settings) {
  const page = resolvePageSize(
    settings.paper, settings.orientation, image.width, image.height,
  );

  const placement = computePlacement(page, image.width, image.height, {
    fitMode: settings.fitMode,
    margin: settings.margin,
    keepAspect: settings.keepAspect,
    maximize: settings.maximize,
    dpi: settings.dpi,
  });

  // Rendered pixel grid — what Pica is asked to produce.
  const targetWidth = Math.max(1, Math.round(placement.width * settings.dpi));
  const targetHeight = Math.max(1, Math.round(placement.height * settings.dpi));

  // Effective DPI uses the smaller of the two axes, i.e. the weakest link.
  const dpiX = image.width / placement.width;
  const dpiY = image.height / placement.height;
  const effectiveDpi = Math.min(dpiX, dpiY);

  const scaleFactor = Math.max(targetWidth / image.width, targetHeight / image.height);
  const tier = QUALITY_TIERS.find((candidate) => effectiveDpi >= candidate.min);

  // Largest print that still hits the 300 DPI reference, at the image's aspect.
  const maxGoodWidth = image.width / REFERENCE_DPI;
  const maxGoodHeight = image.height / REFERENCE_DPI;

  return {
    sourceWidth: image.width,
    sourceHeight: image.height,
    targetWidth,
    targetHeight,
    printWidth: placement.width,
    printHeight: placement.height,
    effectiveDpi,
    scaleFactor,
    stars: tier.stars,
    ratingId: tier.id,
    ratingLabel: tier.label,
    tone: tier.tone,
    advice: buildAdvice({ effectiveDpi, tier, maxGoodWidth, maxGoodHeight, placement, scaleFactor }),
    cropped: placement.cropped,
    maxGoodWidth,
    maxGoodHeight,
    page,
    placement,
  };
}

/**
 * Turn the numbers into a sentence a human can act on.
 *
 * @param {Object} input
 * @returns {string}
 */
function buildAdvice({ effectiveDpi, tier, maxGoodWidth, maxGoodHeight, placement, scaleFactor }) {
  const best = `${formatInches(maxGoodWidth, maxGoodHeight, 1)}`;
  const dpi = Math.round(effectiveDpi);

  if (tier.id === 'excellent') {
    return scaleFactor > 1.02
      ? `Sharp at this size — ${dpi} DPI of real detail, with headroom to go larger.`
      : `Sharp at this size — ${dpi} DPI of real detail, printed at native resolution.`;
  }
  if (tier.id === 'good') {
    return `${dpi} DPI. Prints cleanly at normal viewing distance; for critical detail keep it at ${best} or smaller.`;
  }
  if (tier.id === 'fair') {
    return `${dpi} DPI. Acceptable for a wall poster viewed from a few feet, but soft up close. Best printed at ${best} or smaller.`;
  }
  if (tier.id === 'poor') {
    return `Only ${dpi} DPI. Expect visible softness — this image is best printed at ${best} or smaller.`;
  }
  return `Only ${dpi} DPI — a ${scaleFactor.toFixed(1)}× upscale. Detail will be obviously blurry; find a larger source, or print at ${best} or smaller.`;
}

/**
 * Rough output file size, used for the "Est. size" line before generation.
 *
 * Real-world photographic JPEG at quality q lands around 0.08–0.35 bytes per
 * pixel; PNG is far heavier and far more variable. This is a ballpark, and the
 * UI labels it as one — actual sizes replace it once the PDFs exist.
 *
 * @param {QualityReport} report
 * @param {import('./app.js').Settings} settings
 * @returns {number} Estimated bytes.
 */
export function estimateFileSize(report, settings) {
  const pixels = report.targetWidth * report.targetHeight;

  if (settings.background === 'transparent') {
    // PNG: ~1.1 bytes/px for photographic content after deflate.
    return Math.round(pixels * 1.1 + 4096);
  }

  // Map quality 0.5 → ~0.08 B/px, 1.0 → ~0.45 B/px on a mild curve.
  const q = settings.jpegQuality;
  const bytesPerPixel = 0.05 + 0.42 * q ** 3;
  return Math.round(pixels * bytesPerPixel + 4096);
}

/**
 * Render a star bar such as `★★★★☆`.
 *
 * @param {number} stars 1–5
 * @returns {string}
 */
export function formatStars(stars) {
  return '★'.repeat(stars) + '☆'.repeat(5 - stars);
}

/**
 * Human-readable byte count.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/**
 * Reduce a pixel ratio to its simplest whole-number form (e.g. `3 : 2`).
 * Falls back to a decimal ratio when the reduction is unhelpfully large.
 *
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function formatAspectRatio(width, height) {
  const divisor = greatestCommonDivisor(width, height);
  const w = width / divisor;
  const h = height / divisor;
  if (w <= 40 && h <= 40) return `${w} : ${h}`;
  return `${(width / height).toFixed(2)} : 1`;
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function greatestCommonDivisor(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) [x, y] = [y, x % y];
  return x || 1;
}
