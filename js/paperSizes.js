/**
 * paperSizes.js
 * -----------------------------------------------------------------------------
 * Paper stock catalogue plus the page geometry maths every other module relies
 * on: resolving orientation, and placing an image rectangle on a page.
 *
 * All dimensions in this project are expressed in *inches*. Inches are the
 * lingua franca of print: DPI is per inch, PDF points are 1/72 inch, and the
 * imperial poster sizes are defined in inches to begin with. Millimetre-defined
 * stocks (the ISO A series) are converted once, here, and never again.
 *
 * Adding a new size is a one-line change to PAPER_SIZES — nothing else in the
 * codebase needs to know about it.
 */

/** Millimetres per inch. */
const MM_PER_INCH = 25.4;

/** PDF user-space units ("points") per inch. Fixed by the PDF specification. */
export const POINTS_PER_INCH = 72;

/** @param {number} mm @returns {number} inches */
const mm = (value) => value / MM_PER_INCH;

/**
 * @typedef {Object} PaperSize
 * @property {string} id       Stable machine identifier (used in saved settings).
 * @property {string} label    Human-facing name shown in the picker.
 * @property {number} width    Short-edge-agnostic width, in inches (portrait).
 * @property {number} height   Height, in inches (portrait).
 * @property {string} group    Grouping used for <optgroup> in the UI.
 */

/**
 * Catalogue of supported paper stocks, stored in portrait orientation
 * (width <= height). `resolvePageSize()` handles rotation.
 *
 * @type {ReadonlyArray<PaperSize>}
 */
export const PAPER_SIZES = Object.freeze([
  // ── North American office stock ───────────────────────────────────────────
  { id: 'letter',  label: 'Letter — 8.5 × 11 in',  width: 8.5,  height: 11,  group: 'Office' },
  { id: 'legal',   label: 'Legal — 8.5 × 14 in',   width: 8.5,  height: 14,  group: 'Office' },
  { id: 'tabloid', label: 'Tabloid — 11 × 17 in',  width: 11,   height: 17,  group: 'Office' },

  // ── ISO 216 A series ──────────────────────────────────────────────────────
  { id: 'a5', label: 'A5 — 148 × 210 mm', width: mm(148), height: mm(210), group: 'ISO A series' },
  { id: 'a4', label: 'A4 — 210 × 297 mm', width: mm(210), height: mm(297), group: 'ISO A series' },
  { id: 'a3', label: 'A3 — 297 × 420 mm', width: mm(297), height: mm(420), group: 'ISO A series' },
  { id: 'a2', label: 'A2 — 420 × 594 mm', width: mm(420), height: mm(594), group: 'ISO A series' },

  // ── Standard photo & poster trims ─────────────────────────────────────────
  { id: '11x17', label: '11 × 17 in', width: 11, height: 17, group: 'Poster' },
  { id: '12x18', label: '12 × 18 in', width: 12, height: 18, group: 'Poster' },
  { id: '16x20', label: '16 × 20 in', width: 16, height: 20, group: 'Poster' },
  { id: '18x24', label: '18 × 24 in', width: 18, height: 24, group: 'Poster' },
  { id: '24x36', label: '24 × 36 in', width: 24, height: 36, group: 'Poster' },
]);

/** Fallback stock used when a saved/unknown id cannot be resolved. */
export const DEFAULT_PAPER_ID = 'letter';

/**
 * Look up a paper stock by id.
 *
 * @param {string} id
 * @returns {PaperSize} The matching stock, or Letter if the id is unknown.
 */
export function getPaperSize(id) {
  return PAPER_SIZES.find((size) => size.id === id)
    ?? PAPER_SIZES.find((size) => size.id === DEFAULT_PAPER_ID);
}

/**
 * Paper stocks grouped for rendering inside <optgroup> elements, preserving
 * catalogue order.
 *
 * @returns {Array<{ group: string, sizes: PaperSize[] }>}
 */
export function getGroupedPaperSizes() {
  /** @type {Map<string, PaperSize[]>} */
  const groups = new Map();
  for (const size of PAPER_SIZES) {
    if (!groups.has(size.group)) groups.set(size.group, []);
    groups.get(size.group).push(size);
  }
  return [...groups].map(([group, sizes]) => ({ group, sizes }));
}

/**
 * Resolve the final page rectangle for one image, applying the orientation rule.
 *
 * `auto` matches the page to the image: a landscape image gets a landscape page.
 * Square images keep the stock's native (portrait) orientation.
 *
 * @param {PaperSize} paper
 * @param {'auto'|'portrait'|'landscape'} orientation
 * @param {number} [imageWidth]   Source pixel width  (only needed for `auto`).
 * @param {number} [imageHeight]  Source pixel height (only needed for `auto`).
 * @returns {{ width: number, height: number, orientation: 'portrait'|'landscape' }}
 *          Page size in inches.
 */
export function resolvePageSize(paper, orientation, imageWidth = 0, imageHeight = 0) {
  const portrait = { width: paper.width, height: paper.height };
  const landscape = { width: paper.height, height: paper.width };

  let wantLandscape;
  if (orientation === 'landscape') {
    wantLandscape = true;
  } else if (orientation === 'portrait') {
    wantLandscape = false;
  } else {
    // Auto: follow the image. Square (or unknown) images stay portrait.
    wantLandscape = imageWidth > imageHeight;
  }

  const page = wantLandscape ? landscape : portrait;
  return { ...page, orientation: wantLandscape ? 'landscape' : 'portrait' };
}

/**
 * @typedef {Object} PlacementOptions
 * @property {'fit'|'fill'|'border'} fitMode
 * @property {number}  margin       Border width in inches (used by `border`).
 * @property {boolean} keepAspect   False stretches the image to the box.
 * @property {boolean} maximize     False caps the image at its native print size.
 * @property {number}  dpi          Used to compute native print size.
 */

/**
 * @typedef {Object} Placement
 * @property {number} x       Left edge of the image, inches from page left.
 * @property {number} y       Top edge of the image, inches from page *top*.
 * @property {number} width   Drawn image width, in inches.
 * @property {number} height  Drawn image height, in inches.
 * @property {boolean} cropped True when the image overflows the page (Fill mode).
 * @property {number} boxWidth  Width of the placement box, in inches.
 * @property {number} boxHeight Height of the placement box, in inches.
 */

/**
 * Work out where an image lands on the page.
 *
 * The result is always centred. In `fill` mode the returned rectangle can be
 * larger than the page — that overflow is the crop, and callers are expected to
 * clip it. Every other mode returns a rectangle contained by the placement box.
 *
 * Coordinates use a top-left origin (screen convention). pdfGenerator converts
 * to PDF's bottom-left origin at the last moment.
 *
 * @param {{ width: number, height: number }} page   Page size, inches.
 * @param {number} imageWidth   Source pixel width.
 * @param {number} imageHeight  Source pixel height.
 * @param {PlacementOptions} options
 * @returns {Placement}
 */
export function computePlacement(page, imageWidth, imageHeight, options) {
  const { fitMode, margin, keepAspect, maximize, dpi } = options;

  // Border mode insets the drawable box; Fit and Fill use the full page.
  // The inset is clamped so an over-eager margin can never invert the box.
  const inset = fitMode === 'border'
    ? Math.max(0, Math.min(margin, Math.min(page.width, page.height) / 2 - 0.25))
    : 0;

  const boxWidth = page.width - inset * 2;
  const boxHeight = page.height - inset * 2;

  let width;
  let height;

  if (!keepAspect) {
    // Explicit stretch. Fill still targets the whole page rather than the box.
    width = fitMode === 'fill' ? page.width : boxWidth;
    height = fitMode === 'fill' ? page.height : boxHeight;
  } else {
    const aspect = imageWidth / imageHeight;
    const targetWidth = fitMode === 'fill' ? page.width : boxWidth;
    const targetHeight = fitMode === 'fill' ? page.height : boxHeight;

    // `contain` picks the smaller scale, `cover` the larger.
    const scaleX = targetWidth / imageWidth;
    const scaleY = targetHeight / imageHeight;
    let scale = fitMode === 'fill' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);

    if (!maximize) {
      // Never print larger than the image's native size at the chosen DPI.
      scale = Math.min(scale, 1 / dpi);
    }

    width = imageWidth * scale;
    height = imageHeight * scale;

    // Guard against floating-point drift reintroducing distortion.
    if (Math.abs(width / height - aspect) > 1e-9) height = width / aspect;
  }

  return {
    x: (page.width - width) / 2,
    y: (page.height - height) / 2,
    width,
    height,
    cropped: width > page.width + 1e-6 || height > page.height + 1e-6,
    boxWidth,
    boxHeight,
  };
}

/**
 * Format an inch measurement for display, e.g. `8.5 × 11 in`.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} [decimals=1]
 * @returns {string}
 */
export function formatInches(width, height, decimals = 1) {
  const round = (n) => Number(n.toFixed(decimals)).toString();
  return `${round(width)} × ${round(height)} in`;
}
