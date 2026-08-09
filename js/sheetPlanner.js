/**
 * sheetPlanner.js
 * -----------------------------------------------------------------------------
 * Decides what goes on which page.
 *
 * Blowing a 600 × 800 snapshot up to 18 × 24 in does not make it a poster; it
 * makes a blurry 33 DPI wall covering. The honest fix is to print it *smaller* —
 * and once it is smaller, one image no longer needs a whole sheet of paper.
 *
 * So when "group low-resolution images" is on, every image whose effective DPI
 * would fall below the target is pulled out of the one-image-per-page flow and
 * laid onto shared sheets in a grid. The grid is the *coarsest* one that gets
 * every grouped image back to the target DPI — biggest possible print that is
 * still sharp, rather than the most images crammed per page.
 *
 * Nothing here touches pixels or the DOM: it returns a plan, and pdfGenerator
 * renders it.
 */

import { resolvePageSize } from './paperSizes.js';
import { analyzeImage } from './qualityAnalyzer.js';

/**
 * Grids the planner may choose from, as `[columns, rows]`.
 *
 * Both orientations of each shape are listed because the better one depends on
 * the images: four 3:2 landscapes want 2 × 2, four 2:3 portraits want the cells
 * turned the other way round.
 *
 * @type {ReadonlyArray<readonly [number, number]>}
 */
const GRIDS = Object.freeze([
  [1, 2], [2, 1],
  [2, 2],
  [2, 3], [3, 2],
  [3, 3],
  [3, 4], [4, 3],
  [4, 4],
]);

/** Blank paper left around the whole grid, in inches. */
const SHEET_MARGIN = 0.4;

/** Gap between neighbouring cells, in inches. */
const SHEET_GUTTER = 0.25;

/** A cell smaller than this in either axis is not worth printing. */
const MIN_CELL_INCHES = 1;

/** Fewer than this many low-resolution images is not worth a shared sheet. */
const MIN_GROUP_SIZE = 2;

/**
 * @typedef {Object} SheetCell
 * @property {import('./imageProcessor.js').DecodedImage} image
 * @property {import('./qualityAnalyzer.js').QualityReport} report  Analysed against the cell.
 * @property {number} x       Image left edge, inches from page left.
 * @property {number} y       Image top edge, inches from page top.
 * @property {number} width   Printed width, inches.
 * @property {number} height  Printed height, inches.
 */

/**
 * @typedef {Object} Sheet
 * @property {string} id
 * @property {number} index                Zero-based sheet number.
 * @property {{ width: number, height: number, orientation: string }} page
 * @property {{ cols: number, rows: number, cellWidth: number, cellHeight: number }} grid
 * @property {SheetCell[]} cells
 * @property {boolean} meetsTarget         False when even the finest grid falls short.
 */

/**
 * @typedef {{ type: 'single', image: import('./imageProcessor.js').DecodedImage }
 *         | { type: 'sheet', sheet: Sheet }} Job
 */

/**
 * Plan a whole batch.
 *
 * @param {import('./imageProcessor.js').DecodedImage[]} images
 * @param {import('./app.js').Settings} settings
 * @returns {{
 *   jobs: Job[],
 *   sheets: Sheet[],
 *   grouped: Map<string, { sheet: Sheet, cell: SheetCell }>,
 *   meetsTarget: boolean,
 * }}
 */
export function planBatch(images, settings) {
  const none = {
    jobs: images.map((image) => ({ type: 'single', image })),
    sheets: [],
    grouped: new Map(),
    meetsTarget: true,
  };

  if (settings.nUp !== 'auto' || images.length === 0) return none;

  const target = settings.nUpMinDpi;
  const low = images.filter((image) => analyzeImage(image, settings).effectiveDpi < target);
  if (low.length < MIN_GROUP_SIZE) return none;

  const page = choosePage(settings, low);
  const grid = chooseGrid(page, low, settings, target);
  const perSheet = grid.cols * grid.rows;

  /** @type {Sheet[]} */
  const sheets = [];
  for (let offset = 0; offset < low.length; offset += perSheet) {
    sheets.push(buildSheet(low.slice(offset, offset + perSheet), page, grid, settings, sheets.length));
  }

  // Sheets take the queue position of their first image, so the results list
  // stays in roughly the order the user dropped things in.
  const grouped = new Map();
  const jobs = [];
  const claimed = new Set();

  for (const sheet of sheets) {
    for (const cell of sheet.cells) grouped.set(cell.image.id, { sheet, cell });
  }

  for (const image of images) {
    const entry = grouped.get(image.id);
    if (!entry) {
      jobs.push({ type: 'single', image });
      continue;
    }
    if (claimed.has(entry.sheet.id)) continue;
    claimed.add(entry.sheet.id);
    jobs.push({ type: 'sheet', sheet: entry.sheet });
  }

  return { jobs, sheets, grouped, meetsTarget: grid.meetsTarget };
}

/**
 * Pick the sheet orientation.
 *
 * With an explicit orientation setting there is nothing to decide. On `auto`
 * there is no single image to follow, so the majority shape of the grouped
 * images wins — ties stay portrait, matching the per-image rule.
 *
 * @param {import('./app.js').Settings} settings
 * @param {import('./imageProcessor.js').DecodedImage[]} images
 * @returns {{ width: number, height: number, orientation: string }}
 */
function choosePage(settings, images) {
  if (settings.orientation !== 'auto') {
    return resolvePageSize(settings.paper, settings.orientation);
  }
  const landscapes = images.filter((image) => image.width > image.height).length;
  return resolvePageSize(settings.paper, landscapes > images.length / 2 ? 'landscape' : 'portrait');
}

/**
 * Choose the grid to tile every sheet with.
 *
 * Each candidate is scored by its *worst* cell: the lowest effective DPI any of
 * the grouped images ends up with. Among the grids that clear the target, the
 * winner is the one printing largest — the lowest worst-DPI that is still above
 * the line. Where two grids print the same size (a wide cell letterboxes a 4:3
 * photo to exactly what a squarer cell gives it), the one fitting more images
 * per page wins, because the extra paper bought nothing.
 *
 * @param {{ width: number, height: number }} page
 * @param {import('./imageProcessor.js').DecodedImage[]} images
 * @param {import('./app.js').Settings} settings
 * @param {number} target  Effective DPI to reach.
 * @returns {{ cols: number, rows: number, cellWidth: number, cellHeight: number, meetsTarget: boolean }}
 */
function chooseGrid(page, images, settings, target) {
  const margin = sheetMargin(settings, page);
  const meanAspect = images.reduce((total, image) => total + image.width / image.height, 0) / images.length;

  const candidates = GRIDS
    .map(([cols, rows]) => ({ cols, rows, ...cellSize(page, cols, rows, margin) }))
    .filter((grid) => (
      grid.cellWidth >= MIN_CELL_INCHES
      && grid.cellHeight >= MIN_CELL_INCHES
      // More cells than images only shrinks the print for empty squares.
      && grid.cols * grid.rows <= Math.max(2, images.length)
    ))
    .map((grid) => ({
      ...grid,
      worstDpi: Math.min(...images.map((image) => analyzeInCell(image, grid, settings).effectiveDpi)),
      aspectDistance: Math.abs(Math.log((grid.cellWidth / grid.cellHeight) / meanAspect)),
    }));

  // A page too small to hold any grid at all: fall back to a single column pair.
  if (!candidates.length) {
    return { cols: 1, rows: 2, ...cellSize(page, 1, 2, margin), meetsTarget: false };
  }

  const feasible = candidates.filter((grid) => grid.worstDpi >= target);
  if (!feasible.length) {
    // Nothing reaches the target; take the sharpest available and let the
    // caller warn rather than silently printing mush.
    const sharpest = candidates.reduce((best, grid) => (grid.worstDpi > best.worstDpi ? grid : best));
    return { ...sharpest, meetsTarget: false };
  }

  const best = feasible.reduce((winner, grid) => (printsBetter(grid, winner) ? grid : winner));
  return { ...best, meetsTarget: true };
}

/**
 * Is `grid` the better choice than `rival`? Both are known to clear the target.
 *
 * @param {{ worstDpi: number, cols: number, rows: number, aspectDistance: number }} grid
 * @param {{ worstDpi: number, cols: number, rows: number, aspectDistance: number }} rival
 * @returns {boolean}
 */
function printsBetter(grid, rival) {
  // A lower worst-case DPI means a physically larger print. 2% of slack keeps
  // rounding noise from deciding it.
  if (grid.worstDpi < rival.worstDpi * 0.98) return true;
  if (rival.worstDpi < grid.worstDpi * 0.98) return false;

  const cells = grid.cols * grid.rows;
  const rivalCells = rival.cols * rival.rows;
  if (cells !== rivalCells) return cells > rivalCells;

  return grid.aspectDistance < rival.aspectDistance;
}

/**
 * @param {{ width: number, height: number }} page
 * @param {number} cols
 * @param {number} rows
 * @param {number} margin
 * @returns {{ cellWidth: number, cellHeight: number }}
 */
function cellSize(page, cols, rows, margin) {
  return {
    cellWidth: (page.width - margin * 2 - SHEET_GUTTER * (cols - 1)) / cols,
    cellHeight: (page.height - margin * 2 - SHEET_GUTTER * (rows - 1)) / rows,
  };
}

/**
 * Border mode's margin is a deliberate framing choice, so it is honoured on
 * shared sheets too; every other mode uses the standard trim.
 *
 * @param {import('./app.js').Settings} settings
 * @param {{ width: number, height: number }} page
 * @returns {number} Margin in inches.
 */
function sheetMargin(settings, page) {
  if (settings.fitMode !== 'border') return SHEET_MARGIN;
  const limit = Math.min(page.width, page.height) / 2 - MIN_CELL_INCHES;
  return Math.max(0, Math.min(settings.margin, limit));
}

/**
 * Analyse one image as if the cell were the page.
 *
 * Reusing `analyzeImage` — rather than repeating its arithmetic — is what keeps
 * the star rating, the advice text and the DPI on a grouped card consistent with
 * every other card in the app.
 *
 * @param {{ width: number, height: number }} image
 * @param {{ cellWidth: number, cellHeight: number }} grid
 * @param {import('./app.js').Settings} settings
 * @returns {import('./qualityAnalyzer.js').QualityReport}
 */
export function analyzeInCell(image, grid, settings) {
  return analyzeImage(image, {
    ...settings,
    paper: { id: 'cell', label: 'cell', width: grid.cellWidth, height: grid.cellHeight, group: '' },
    // The cell is already the right way round; never rotate inside it. Cells are
    // always contain-fitted, whatever the page-level fit mode says.
    orientation: 'portrait',
    fitMode: 'fit',
    margin: 0,
    keepAspect: true,
  });
}

/**
 * Lay one page of images out.
 *
 * A partly-filled last sheet is centred rather than pushed into the top-left
 * corner, which is what stops a 5-image batch on a 2 × 2 grid from looking like
 * a mistake.
 *
 * @param {import('./imageProcessor.js').DecodedImage[]} images
 * @param {{ width: number, height: number, orientation: string }} page
 * @param {{ cols: number, rows: number, cellWidth: number, cellHeight: number, meetsTarget: boolean }} grid
 * @param {import('./app.js').Settings} settings
 * @param {number} index
 * @returns {Sheet}
 */
function buildSheet(images, page, grid, settings, index) {
  const margin = sheetMargin(settings, page);
  const { cols, cellWidth, cellHeight } = grid;
  const rowsUsed = Math.ceil(images.length / cols);

  const blockHeight = rowsUsed * cellHeight + SHEET_GUTTER * (rowsUsed - 1);
  const top = (page.height - blockHeight) / 2;

  const cells = images.map((image, position) => {
    const row = Math.floor(position / cols);
    const column = position % cols;

    // Columns are counted per row so the final, shorter row centres too.
    const inRow = Math.min(cols, images.length - row * cols);
    const blockWidth = inRow * cellWidth + SHEET_GUTTER * (inRow - 1);
    const left = (page.width - blockWidth) / 2;

    const cellX = left + column * (cellWidth + SHEET_GUTTER);
    const cellY = top + row * (cellHeight + SHEET_GUTTER);

    const report = analyzeInCell(image, grid, settings);
    return {
      image,
      report,
      x: cellX + report.placement.x,
      y: cellY + report.placement.y,
      width: report.placement.width,
      height: report.placement.height,
    };
  });

  return {
    id: `sheet-${index}-${images[0].id}`,
    index,
    page,
    grid: { cols, rows: grid.rows, cellWidth, cellHeight },
    cells,
    meetsTarget: grid.meetsTarget,
  };
}
