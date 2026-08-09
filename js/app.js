/**
 * app.js
 * -----------------------------------------------------------------------------
 * Composition root. Owns application state, wires the UI callbacks to the
 * processing modules, and orchestrates the batch run.
 *
 * State is a plain object held in this module's closure — no globals, no
 * framework, no observable magic. Every mutation is followed by an explicit
 * render call, which makes the data flow trivial to follow.
 */

import { initUI, defaultSettings } from './ui.js';
import { getPaperSize } from './paperSizes.js';
import {
  isProbablyImage, decodeImageFile, releaseResources, getResampleFallbackReason,
} from './imageProcessor.js';
import { generatePosters } from './pdfGenerator.js';
import { planBatch } from './sheetPlanner.js';
import { downloadBlob, downloadAllAsZip } from './zipExporter.js';

/**
 * @typedef {Object} Settings
 * @property {import('./paperSizes.js').PaperSize} paper
 * @property {'auto'|'portrait'|'landscape'} orientation
 * @property {number}  dpi
 * @property {'white'|'black'|'transparent'|'custom'} background
 * @property {string}  backgroundColor
 * @property {'fit'|'fill'|'border'} fitMode
 * @property {number}  margin       Border width, inches.
 * @property {number}  jpegQuality  0.5–1.
 * @property {boolean} keepAspect
 * @property {boolean} maximize
 * @property {'off'|'auto'} nUp        Group low-resolution images onto shared sheets.
 * @property {number}  nUpMinDpi       Effective DPI below which grouping kicks in.
 */

/** Hard ceiling on queue length, to keep the preview grid usable. */
const MAX_IMAGES = 500;

/** Repaint the results list every N completed posters (see `generate`). */
const RESULTS_RENDER_INTERVAL = 8;

/** Application state. */
const state = {
  /** @type {import('./imageProcessor.js').DecodedImage[]} */
  images: [],
  /** @type {import('./pdfGenerator.js').PosterResult[]} */
  results: [],
  /** @type {AbortController|null} */
  abortController: null,
  busy: false,
  nextId: 0,
  /** True once the "resampling fell back" notice has been shown. */
  fallbackReported: false,
};

/** @type {ReturnType<typeof initUI>} */
let ui;

/**
 * Turn the UI's raw form values into a resolved `Settings` object, with the
 * paper stock looked up once so downstream modules never touch the catalogue.
 *
 * @returns {Settings}
 */
function currentSettings() {
  const raw = ui.readSettings();
  return {
    paper: getPaperSize(raw.paperId),
    orientation: raw.orientation,
    dpi: raw.dpi,
    background: raw.background,
    backgroundColor: raw.backgroundColor,
    fitMode: raw.fitMode,
    margin: raw.margin,
    jpegQuality: raw.jpegQuality,
    keepAspect: raw.keepAspect,
    maximize: raw.maximize,
    nUp: raw.nUp,
    nUpMinDpi: raw.nUpMinDpi,
  };
}

/** Re-render everything that depends on the queue or the settings. */
function render() {
  const settings = currentSettings();
  ui.renderPreview(state.images, settings);
  ui.setSummary(describeSettings(settings));
}

/**
 * Coalesce renders into one per frame.
 *
 * Range inputs fire `input` continuously while dragging, and each render
 * rebuilds every preview card. With a few hundred images in the queue that is
 * the difference between a smooth slider and a locked-up tab.
 *
 * @returns {void}
 */
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

/**
 * One-line plain-English description of the current settings, shown next to the
 * Generate button so nobody has to re-read the whole panel.
 *
 * @param {Settings} settings
 * @returns {string}
 */
function describeSettings(settings) {
  const { paper, dpi, fitMode, orientation } = settings;
  const modeText = { fit: 'fitted', fill: 'filled (edges cropped)', border: `bordered ${settings.margin.toFixed(2)}″` }[fitMode];
  const count = state.images.length;
  const noun = count === 1 ? 'poster' : 'posters';
  const target = count ? `${count} ${noun}` : 'Nothing queued';
  const grouping = settings.nUp === 'auto'
    ? ` · grouping anything under ${settings.nUpMinDpi} DPI`
    : '';
  return `${target} · ${paper.label.split('—')[0].trim()} · ${orientation} · ${dpi} DPI · ${modeText}${grouping}`;
}

/* ══════════════════════════════════════════════════════════════════════════
   Queue management
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Decode and enqueue dropped or picked files.
 *
 * Files are decoded concurrently in small batches: fully parallel decoding of
 * hundreds of large photographs will exhaust memory, and fully serial decoding
 * is needlessly slow.
 *
 * @param {File[]} files
 * @returns {Promise<void>}
 */
async function addFiles(files) {
  if (state.busy) {
    ui.toast('Please wait for the current batch to finish.', 'warn');
    return;
  }

  const candidates = files.filter(isProbablyImage);
  const rejected = files.length - candidates.length;
  if (rejected > 0) {
    ui.toast(`Skipped ${rejected} file${rejected === 1 ? '' : 's'} that ${rejected === 1 ? 'is' : 'are'} not an image.`, 'warn');
  }
  if (!candidates.length) return;

  const room = MAX_IMAGES - state.images.length;
  if (room <= 0) {
    ui.toast(`Queue is full (${MAX_IMAGES} images).`, 'warn');
    return;
  }

  const accepted = candidates.slice(0, room);
  if (accepted.length < candidates.length) {
    ui.toast(`Only the first ${room} image${room === 1 ? '' : 's'} were added — the queue holds ${MAX_IMAGES}.`, 'warn');
  }

  ui.showProgress();
  ui.updateProgress(0, `Reading ${accepted.length} image${accepted.length === 1 ? '' : 's'}…`);

  const failures = [];
  const CONCURRENCY = 4;
  let done = 0;

  for (let offset = 0; offset < accepted.length; offset += CONCURRENCY) {
    const slice = accepted.slice(offset, offset + CONCURRENCY);

    const decoded = await Promise.all(slice.map(async (file) => {
      try {
        return await decodeImageFile(file, `img-${state.nextId++}`);
      } catch (error) {
        failures.push(`${file.name}: ${error.message}`);
        return null;
      }
    }));

    for (const image of decoded) if (image) state.images.push(image);

    done += slice.length;
    ui.updateProgress((done / accepted.length) * 100, `Reading images… ${done} of ${accepted.length}`);
    render();
  }

  ui.hideProgress();

  if (failures.length) {
    ui.toast(`Could not read ${failures.length} file${failures.length === 1 ? '' : 's'}. ${failures[0]}`, 'error');
  }
  const added = accepted.length - failures.length;
  if (added > 0) {
    ui.toast(`Added ${added} image${added === 1 ? '' : 's'}.`, 'success');
  }
}

/**
 * Remove one image from the queue and release its thumbnail.
 *
 * @param {string} id
 * @returns {void}
 */
function removeImage(id) {
  const index = state.images.findIndex((image) => image.id === id);
  if (index === -1) return;

  URL.revokeObjectURL(state.images[index].thumbnailUrl);
  state.images.splice(index, 1);
  render();
}

/** Empty the queue and the results list. */
function clearAll() {
  for (const image of state.images) URL.revokeObjectURL(image.thumbnailUrl);
  state.images = [];
  state.results = [];
  ui.clearResults();
  render();
}

/* ══════════════════════════════════════════════════════════════════════════
   Generation
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Run the batch, streaming progress into the UI.
 *
 * @returns {Promise<void>}
 */
async function generate() {
  if (state.busy || !state.images.length) return;
  if (!window.PDFLib) {
    ui.toast('pdf-lib failed to load. Check that libs/pdf-lib.min.js is present.', 'error');
    return;
  }

  const settings = currentSettings();
  state.busy = true;
  state.results = [];
  state.abortController = new AbortController();

  ui.clearResults();
  ui.setBusy(true);
  ui.showProgress();

  // The plan decides what becomes its own poster and what gets grouped onto a
  // shared sheet, so the progress total counts *pages*, not queued images.
  const plan = planBatch(state.images, settings);
  const total = plan.jobs.length;
  const failures = [];
  const startedAt = performance.now();

  if (plan.sheets.length) {
    const count = plan.grouped.size;
    ui.toast(
      `${count} low-resolution image${count === 1 ? '' : 's'} grouped onto `
      + `${plan.sheets.length} shared sheet${plan.sheets.length === 1 ? '' : 's'}.`,
      'info',
    );
  }

  try {
    const batch = generatePosters(plan.jobs, settings, {
      signal: state.abortController.signal,
      onProgress: ({ index, stage, name }) => {
        // The bar tracks completed posters; the label tracks the live stage.
        ui.updateProgress((index / total) * 100, `${stage} ${index + 1} of ${total} — ${name}`);
      },
    });

    for await (const outcome of batch) {
      if (outcome.ok) {
        state.results.push(outcome.result);
      } else {
        failures.push(`${outcome.name}: ${outcome.error.message}`);
      }
      ui.updateProgress(
        ((state.results.length + failures.length) / total) * 100,
        `Generated ${state.results.length} of ${total}`,
      );

      // Rebuilding the whole list per poster is quadratic; on a 500-image batch
      // that dominates the run. Refresh periodically, and once more at the end.
      if (state.results.length % RESULTS_RENDER_INTERVAL === 0) {
        ui.renderResults(state.results);
      }
    }

    const cancelled = state.abortController.signal.aborted;
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);

    if (cancelled) {
      ui.updateProgress(100, `Cancelled — ${state.results.length} poster${state.results.length === 1 ? '' : 's'} kept.`);
      ui.toast('Generation cancelled. Completed posters are still available.', 'warn');
    } else {
      ui.updateProgress(100, `Finished — ${state.results.length} poster${state.results.length === 1 ? '' : 's'} in ${seconds}s.`);
      if (state.results.length) {
        ui.toast(`Generated ${state.results.length} poster${state.results.length === 1 ? '' : 's'} in ${seconds}s.`, 'success');
      }
    }

    if (failures.length) {
      ui.toast(`${failures.length} poster${failures.length === 1 ? '' : 's'} failed. ${failures[0]}`, 'error');
    }

    // Mentioned once per session, not once per poster.
    const fallbackReason = getResampleFallbackReason();
    if (fallbackReason && !state.fallbackReported) {
      state.fallbackReported = true;
      ui.toast(fallbackReason, 'warn');
    }
  } catch (error) {
    ui.updateProgress(100, 'Failed.');
    ui.toast(`Generation failed: ${error.message}`, 'error');
  } finally {
    state.busy = false;
    state.abortController = null;
    ui.setBusy(false);
    ui.renderResults(state.results);
  }
}

/** Abort the running batch after the current poster finishes. */
function cancel() {
  if (!state.abortController) {
    ui.hideProgress();
    return;
  }
  state.abortController.abort();
  ui.updateProgress(100, 'Cancelling…');
}

/* ══════════════════════════════════════════════════════════════════════════
   Downloads
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {string} id
 * @returns {void}
 */
function downloadOne(id) {
  const result = state.results.find((candidate) => candidate.id === id);
  if (!result) return;
  downloadBlob(result.blob, result.filename);
}

/** Bundle every finished poster into a ZIP. */
async function downloadZip() {
  if (!state.results.length) {
    ui.toast('Generate some posters first.', 'warn');
    return;
  }

  // A single PDF does not need an archive around it.
  if (state.results.length === 1) {
    downloadOne(state.results[0].id);
    return;
  }

  ui.showProgress();
  try {
    const { filename, bytes } = await downloadAllAsZip(state.results, {
      onProgress: ({ percent, stage }) => ui.updateProgress(percent, `${stage}… ${Math.round(percent)}%`),
    });
    ui.updateProgress(100, 'Finished.');
    ui.toast(`Saved ${filename} (${(bytes / 1024 / 1024).toFixed(1)} MB).`, 'success');
  } catch (error) {
    ui.toast(`Could not build the archive: ${error.message}`, 'error');
  } finally {
    setTimeout(() => ui.hideProgress(), 1200);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Bootstrap
   ══════════════════════════════════════════════════════════════════════════ */

/** Wire everything up. */
function main() {
  ui = initUI({
    onFilesAdded: (files) => { addFiles(files); },
    onRemoveImage: removeImage,
    onClearAll: clearAll,
    onGenerate: () => { generate(); },
    onCancel: cancel,
    onDownloadZip: () => { downloadZip(); },
    onDownloadOne: downloadOne,
    onSettingsChange: () => {
      ui.persistSettings(ui.readSettings());
      scheduleRender();
    },
  });

  render();

  // Warn before navigating away mid-batch or with unsaved posters.
  window.addEventListener('beforeunload', (event) => {
    if (!state.busy && !state.results.length) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // Release thumbnail object URLs and Pica's worker pool on teardown.
  window.addEventListener('pagehide', () => {
    for (const image of state.images) URL.revokeObjectURL(image.thumbnailUrl);
    releaseResources();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main, { once: true });
} else {
  main();
}

// Exported for tests and for the browser console; `defaultSettings` is
// re-exported so tooling can import the whole surface from one module.
export { state, defaultSettings };
