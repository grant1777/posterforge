/**
 * ui.js
 * -----------------------------------------------------------------------------
 * The entire DOM layer. Nothing else in the project touches `document`.
 *
 * `initUI()` wires the markup up to a set of callbacks and hands back a small
 * controller object. Application state lives in app.js; this module only ever
 * *renders* state and *reports* intent, which keeps both halves testable and
 * makes it obvious where a change belongs.
 */

import { getGroupedPaperSizes, getPaperSize, formatInches, DEFAULT_PAPER_ID } from './paperSizes.js';
import {
  analyzeImage, estimateFileSize, formatStars, formatBytes, formatAspectRatio,
} from './qualityAnalyzer.js';

/** localStorage keys. */
const STORAGE = Object.freeze({ settings: 'posterforge.settings.v1', theme: 'posterforge.theme' });

/** How long a toast stays on screen, in milliseconds. */
const TOAST_DURATION = 5000;

/**
 * Default settings. Also used by "Reset to defaults".
 *
 * @returns {Object} Raw (serialisable) settings — see app.js `Settings`.
 */
export function defaultSettings() {
  return {
    paperId: DEFAULT_PAPER_ID,
    orientation: 'auto',
    dpi: 300,
    background: 'white',
    backgroundColor: '#f2f2f2',
    fitMode: 'fit',
    margin: 0.5,
    jpegQuality: 0.92,
    keepAspect: true,
    maximize: true,
  };
}

/**
 * Collect every element the UI needs, once.
 *
 * @returns {Record<string, HTMLElement>}
 */
function queryElements() {
  const byId = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`PosterForge: missing #${id} in index.html`);
    return element;
  };

  return {
    dropzone: byId('dropzone'),
    fileInput: byId('fileInput'),
    chooseFilesBtn: byId('chooseFilesBtn'),

    paperSize: byId('paperSize'),
    paperSizeHint: byId('paperSizeHint'),
    orientation: byId('orientation'),
    dpi: byId('dpi'),
    dpiCustom: byId('dpiCustom'),
    background: byId('background'),
    bgCustomRow: byId('bgCustomRow'),
    backgroundColor: byId('backgroundColor'),
    backgroundColorValue: byId('backgroundColorValue'),
    marginField: byId('marginField'),
    margin: byId('margin'),
    marginValue: byId('marginValue'),
    jpegQuality: byId('jpegQuality'),
    jpegQualityValue: byId('jpegQualityValue'),
    keepAspect: byId('keepAspect'),
    maximize: byId('maximize'),
    resetSettingsBtn: byId('resetSettingsBtn'),
    settingsSummary: byId('settingsSummary'),

    generateBtn: byId('generateBtn'),
    clearAllBtn: byId('clearAllBtn'),

    progressPanel: byId('progressPanel'),
    progressBar: byId('progressBar'),
    progressFill: byId('progressFill'),
    progressStatus: byId('progressStatus'),
    cancelBtn: byId('cancelBtn'),

    resultsPanel: byId('resultsPanel'),
    resultsList: byId('resultsList'),
    resultsCount: byId('resultsCount'),
    downloadZipBtn: byId('downloadZipBtn'),

    previewPanel: byId('previewPanel'),
    previewGrid: byId('previewGrid'),
    previewCount: byId('previewCount'),
    previewMeta: byId('previewMeta'),
    emptyState: byId('emptyState'),

    themeToggle: byId('themeToggle'),
    toasts: byId('toasts'),
    cardTemplate: byId('previewCardTemplate'),
  };
}

/**
 * @typedef {Object} UIHandlers
 * @property {(files: File[]) => void}  onFilesAdded
 * @property {(id: string) => void}     onRemoveImage
 * @property {() => void}               onClearAll
 * @property {() => void}               onGenerate
 * @property {() => void}               onCancel
 * @property {() => void}               onDownloadZip
 * @property {(id: string) => void}     onDownloadOne
 * @property {() => void}               onSettingsChange
 */

/**
 * Build the UI controller.
 *
 * @param {UIHandlers} handlers
 * @returns {Object} Controller used by app.js.
 */
export function initUI(handlers) {
  const elements = queryElements();

  populatePaperSizes(elements.paperSize);
  initTheme(elements.themeToggle);
  applySettings(elements, loadSettings());
  bindEvents(elements, handlers);
  syncConditionalFields(elements);

  return {
    readSettings: () => readSettings(elements),
    resetSettings() {
      applySettings(elements, defaultSettings());
      syncConditionalFields(elements);
      persistSettings(readSettings(elements));
    },
    persistSettings: (settings) => persistSettings(settings),
    renderPreview: (images, settings) => renderPreview(elements, handlers, images, settings),
    renderResults: (results) => renderResults(elements, handlers, results),
    clearResults: () => clearResults(elements),
    setSummary: (text) => { elements.settingsSummary.textContent = text; },
    setBusy: (busy) => setBusy(elements, busy),
    showProgress: () => showProgress(elements),
    hideProgress: () => hideProgress(elements),
    updateProgress: (percent, status) => updateProgress(elements, percent, status),
    toast: (message, tone) => toast(elements, message, tone),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Settings
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Fill the paper-size picker from the catalogue, grouped by family.
 *
 * @param {HTMLSelectElement} select
 * @returns {void}
 */
function populatePaperSizes(select) {
  for (const { group, sizes } of getGroupedPaperSizes()) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group;
    for (const size of sizes) {
      const option = document.createElement('option');
      option.value = size.id;
      option.textContent = size.label;
      optgroup.append(option);
    }
    select.append(optgroup);
  }
  select.value = DEFAULT_PAPER_ID;
}

/**
 * Read the current form state into a raw settings object.
 *
 * @param {Record<string, HTMLElement>} elements
 * @returns {Object}
 */
function readSettings(elements) {
  const dpiChoice = elements.dpi.value;
  const dpi = dpiChoice === 'custom'
    ? clamp(Number(elements.dpiCustom.value) || 300, 72, 1200)
    : Number(dpiChoice);

  return {
    paperId: elements.paperSize.value,
    orientation: elements.orientation.value,
    dpi,
    dpiChoice,
    background: elements.background.value,
    backgroundColor: elements.backgroundColor.value,
    fitMode: document.querySelector('input[name="fitMode"]:checked')?.value ?? 'fit',
    margin: Number(elements.margin.value),
    jpegQuality: Number(elements.jpegQuality.value),
    keepAspect: elements.keepAspect.checked,
    maximize: elements.maximize.checked,
  };
}

/**
 * Push a settings object into the form controls.
 *
 * @param {Record<string, HTMLElement>} elements
 * @param {Object} settings
 * @returns {void}
 */
function applySettings(elements, settings) {
  const merged = { ...defaultSettings(), ...settings };

  elements.paperSize.value = getPaperSize(merged.paperId).id;
  elements.orientation.value = merged.orientation;

  const presetDpis = ['150', '200', '300', '600'];
  const dpiString = String(merged.dpi);
  if (presetDpis.includes(dpiString)) {
    elements.dpi.value = dpiString;
  } else {
    elements.dpi.value = 'custom';
    elements.dpiCustom.value = merged.dpi;
  }

  elements.background.value = merged.background;
  elements.backgroundColor.value = merged.backgroundColor;
  elements.margin.value = merged.margin;
  elements.jpegQuality.value = merged.jpegQuality;
  elements.keepAspect.checked = merged.keepAspect;
  elements.maximize.checked = merged.maximize;

  const radio = document.querySelector(`input[name="fitMode"][value="${merged.fitMode}"]`);
  if (radio) radio.checked = true;
}

/**
 * Show or hide the controls that only apply to certain choices, and refresh the
 * little value read-outs beside the sliders.
 *
 * @param {Record<string, HTMLElement>} elements
 * @returns {void}
 */
function syncConditionalFields(elements) {
  const settings = readSettings(elements);

  elements.dpiCustom.classList.toggle('is-hidden', settings.dpiChoice !== 'custom');
  elements.bgCustomRow.classList.toggle('is-hidden', settings.background !== 'custom');
  elements.marginField.hidden = settings.fitMode !== 'border';

  elements.marginValue.value = `${settings.margin.toFixed(2)}″`;
  elements.jpegQualityValue.value = `${Math.round(settings.jpegQuality * 100)}%`;
  elements.backgroundColorValue.textContent = settings.backgroundColor.toUpperCase();

  const paper = getPaperSize(settings.paperId);
  elements.paperSizeHint.textContent =
    `${formatInches(paper.width, paper.height, 2)} · `
    + `${Math.round(paper.width * settings.dpi)} × ${Math.round(paper.height * settings.dpi)} px at ${settings.dpi} DPI`;
}

/**
 * @returns {Object} Settings from localStorage, or the defaults.
 */
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE.settings);
    return raw ? { ...defaultSettings(), ...JSON.parse(raw) } : defaultSettings();
  } catch {
    return defaultSettings();
  }
}

/**
 * @param {Object} settings
 * @returns {void}
 */
function persistSettings(settings) {
  try {
    localStorage.setItem(STORAGE.settings, JSON.stringify(settings));
  } catch {
    /* Private browsing or a full quota — settings simply will not persist. */
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Events
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {Record<string, HTMLElement>} elements
 * @param {UIHandlers} handlers
 * @returns {void}
 */
function bindEvents(elements, handlers) {
  // ── File input & dropzone ────────────────────────────────────────────────
  elements.chooseFilesBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    elements.fileInput.click();
  });

  elements.fileInput.addEventListener('change', () => {
    handlers.onFilesAdded([...elements.fileInput.files]);
    // Reset so re-picking the same file still fires `change`.
    elements.fileInput.value = '';
  });

  // The hidden input lives inside the dropzone, and `input.click()` dispatches a
  // *bubbling* click — without this the dropzone handler would re-trigger itself
  // forever.
  elements.fileInput.addEventListener('click', (event) => event.stopPropagation());

  elements.dropzone.addEventListener('click', () => elements.fileInput.click());
  elements.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      elements.fileInput.click();
    }
  });

  let dragDepth = 0;
  const setDragging = (dragging) => elements.dropzone.classList.toggle('is-dragging', dragging);

  // Suppress the browser's default "open the dropped file" behaviour everywhere,
  // so a near-miss drop does not navigate away and lose the queue.
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (event) => event.preventDefault());
  }

  elements.dropzone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    setDragging(true);
  });
  elements.dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  elements.dropzone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragging(false);
  });
  elements.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    setDragging(false);
    handlers.onFilesAdded(collectDroppedFiles(event.dataTransfer));
  });

  // ── Settings ─────────────────────────────────────────────────────────────
  const settingsInputs = [
    elements.paperSize, elements.orientation, elements.dpi, elements.dpiCustom,
    elements.background, elements.backgroundColor, elements.margin,
    elements.jpegQuality, elements.keepAspect, elements.maximize,
    ...document.querySelectorAll('input[name="fitMode"]'),
  ];

  for (const input of settingsInputs) {
    input.addEventListener('input', () => {
      syncConditionalFields(elements);
      handlers.onSettingsChange();
    });
  }

  elements.resetSettingsBtn.addEventListener('click', () => {
    applySettings(elements, defaultSettings());
    syncConditionalFields(elements);
    handlers.onSettingsChange();
  });

  // ── Actions ──────────────────────────────────────────────────────────────
  elements.generateBtn.addEventListener('click', () => handlers.onGenerate());
  elements.clearAllBtn.addEventListener('click', () => handlers.onClearAll());
  elements.cancelBtn.addEventListener('click', () => handlers.onCancel());
  elements.downloadZipBtn.addEventListener('click', () => handlers.onDownloadZip());

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === 'Enter' && !elements.generateBtn.disabled) {
      event.preventDefault();
      handlers.onGenerate();
    }
  });
}

/**
 * Extract Files from a drop, walking directories when the browser exposes the
 * (non-standard but universally supported) entries API.
 *
 * @param {DataTransfer} dataTransfer
 * @returns {File[]}
 */
function collectDroppedFiles(dataTransfer) {
  if (dataTransfer?.files?.length) return [...dataTransfer.files];
  return [...(dataTransfer?.items ?? [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

/* ══════════════════════════════════════════════════════════════════════════
   Preview grid
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Render the preview cards for the current queue.
 *
 * @param {Record<string, HTMLElement>} elements
 * @param {UIHandlers} handlers
 * @param {import('./imageProcessor.js').DecodedImage[]} images
 * @param {import('./app.js').Settings} settings
 * @returns {void}
 */
function renderPreview(elements, handlers, images, settings) {
  const hasImages = images.length > 0;
  elements.previewPanel.hidden = !hasImages;
  elements.emptyState.hidden = hasImages;
  elements.generateBtn.disabled = !hasImages;
  elements.clearAllBtn.disabled = !hasImages;
  elements.previewCount.textContent = String(images.length);

  const fragment = document.createDocumentFragment();
  let estimatedTotal = 0;

  for (const image of images) {
    const report = analyzeImage(image, settings);
    const estimate = estimateFileSize(report, settings);
    estimatedTotal += estimate;
    fragment.append(buildCard(elements, handlers, image, report, estimate));
  }

  elements.previewGrid.replaceChildren(fragment);

  const sourceBytes = images.reduce((total, image) => total + image.bytes, 0);
  elements.previewMeta.textContent = hasImages
    ? `${formatBytes(sourceBytes)} of source images · about ${formatBytes(estimatedTotal)} of PDF output`
    : '';
}

/**
 * Clone and populate one preview card.
 *
 * @param {Record<string, HTMLElement>} elements
 * @param {UIHandlers} handlers
 * @param {import('./imageProcessor.js').DecodedImage} image
 * @param {import('./qualityAnalyzer.js').QualityReport} report
 * @param {number} estimate
 * @returns {DocumentFragment}
 */
function buildCard(elements, handlers, image, report, estimate) {
  const card = elements.cardTemplate.content.cloneNode(true);
  const root = card.querySelector('.card');
  const set = (selector, value) => { card.querySelector(selector).textContent = value; };

  root.dataset.id = image.id;

  const thumbnail = card.querySelector('.card__thumb img');
  thumbnail.src = image.thumbnailUrl;
  thumbnail.alt = `Preview of ${image.name}`;

  set('[data-name]', image.name);
  card.querySelector('[data-name]').title = image.name;

  set('[data-resolution]', `${image.width} × ${image.height} px`);
  set('[data-aspect]', formatAspectRatio(image.width, image.height));
  set('[data-printsize]', formatInches(report.printWidth, report.printHeight, 1));
  set('[data-effdpi]', `${Math.round(report.effectiveDpi)} DPI`);
  set('[data-scale]', `${report.scaleFactor.toFixed(2)}×`);
  set('[data-filesize]', `~${formatBytes(estimate)}`);

  const rating = card.querySelector('[data-rating]');
  rating.dataset.tone = report.tone;
  set('[data-stars]', formatStars(report.stars));
  set('[data-rating-label]', report.ratingLabel);
  rating.setAttribute('aria-label', `Print quality: ${report.ratingLabel}, ${report.stars} out of 5`);

  set('[data-advice]', report.advice);

  const remove = card.querySelector('.card__remove');
  remove.setAttribute('aria-label', `Remove ${image.name}`);
  remove.addEventListener('click', () => handlers.onRemoveImage(image.id));

  return card;
}

/* ══════════════════════════════════════════════════════════════════════════
   Results
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {Record<string, HTMLElement>} elements
 * @param {UIHandlers} handlers
 * @param {import('./pdfGenerator.js').PosterResult[]} results
 * @returns {void}
 */
function renderResults(elements, handlers, results) {
  elements.resultsPanel.hidden = results.length === 0;
  elements.resultsCount.textContent = String(results.length);

  const fragment = document.createDocumentFragment();

  for (const result of results) {
    const item = document.createElement('li');
    item.className = 'result';

    const info = document.createElement('div');
    info.className = 'result__info';

    const name = document.createElement('p');
    name.className = 'result__name';
    name.textContent = result.filename;
    name.title = result.filename;

    const meta = document.createElement('p');
    meta.className = 'result__meta';
    meta.textContent = [
      formatInches(result.report.page.width, result.report.page.height, 1),
      `${result.report.targetWidth} × ${result.report.targetHeight} px`,
      formatBytes(result.bytes),
      result.report.ratingLabel,
    ].join(' · ');

    info.append(name, meta);
    item.append(info);

    if (result.warnings.length) {
      const warning = document.createElement('p');
      warning.className = 'result__warning';
      warning.textContent = result.warnings.join(' ');
      info.append(warning);
    }

    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'btn btn--ghost btn--sm';
    download.textContent = 'Download';
    download.setAttribute('aria-label', `Download ${result.filename}`);
    download.addEventListener('click', () => handlers.onDownloadOne(result.id));

    item.append(download);
    fragment.append(item);
  }

  elements.resultsList.replaceChildren(fragment);
}

/**
 * @param {Record<string, HTMLElement>} elements
 * @returns {void}
 */
function clearResults(elements) {
  elements.resultsList.replaceChildren();
  elements.resultsPanel.hidden = true;
  elements.resultsCount.textContent = '0';
}

/* ══════════════════════════════════════════════════════════════════════════
   Progress, busy state, toasts, theme
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {Record<string, HTMLElement>} elements
 * @param {boolean} busy
 * @returns {void}
 */
function setBusy(elements, busy) {
  elements.generateBtn.disabled = busy || elements.previewPanel.hidden;
  elements.generateBtn.textContent = busy ? 'Generating…' : 'Generate Posters';
  elements.clearAllBtn.disabled = busy || elements.previewPanel.hidden;
  elements.dropzone.classList.toggle('is-disabled', busy);
  document.body.classList.toggle('is-busy', busy);
}

/** @param {Record<string, HTMLElement>} elements @returns {void} */
function showProgress(elements) {
  elements.progressPanel.hidden = false;
  updateProgress(elements, 0, 'Preparing…');
  elements.progressPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** @param {Record<string, HTMLElement>} elements @returns {void} */
function hideProgress(elements) {
  elements.progressPanel.hidden = true;
}

/**
 * @param {Record<string, HTMLElement>} elements
 * @param {number} percent 0–100
 * @param {string} status
 * @returns {void}
 */
function updateProgress(elements, percent, status) {
  const value = clamp(Math.round(percent), 0, 100);
  elements.progressFill.style.width = `${value}%`;
  elements.progressBar.setAttribute('aria-valuenow', String(value));
  elements.progressStatus.textContent = status;
}

/**
 * Show a transient message.
 *
 * @param {Record<string, HTMLElement>} elements
 * @param {string} message
 * @param {'info'|'success'|'warn'|'error'} [tone='info']
 * @returns {void}
 */
function toast(elements, message, tone = 'info') {
  const node = document.createElement('div');
  node.className = `toast toast--${tone}`;
  node.textContent = message;
  elements.toasts.append(node);

  setTimeout(() => {
    node.classList.add('is-leaving');
    node.addEventListener('transitionend', () => node.remove(), { once: true });
    // Belt and braces, in case the transition never fires.
    setTimeout(() => node.remove(), 600);
  }, TOAST_DURATION);
}

/**
 * Restore the saved theme (falling back to the OS preference) and wire the
 * toggle button.
 *
 * @param {HTMLButtonElement} button
 * @returns {void}
 */
function initTheme(button) {
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  let theme;
  try {
    theme = localStorage.getItem(STORAGE.theme);
  } catch {
    theme = null;
  }
  applyTheme(button, theme ?? (prefersLight ? 'light' : 'dark'));

  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(button, next);
    try {
      localStorage.setItem(STORAGE.theme, next);
    } catch {
      /* Not persistable; the toggle still works for this session. */
    }
  });
}

/**
 * @param {HTMLButtonElement} button
 * @param {'dark'|'light'} theme
 * @returns {void}
 */
function applyTheme(button, theme) {
  document.documentElement.dataset.theme = theme;
  button.setAttribute('aria-pressed', String(theme === 'light'));
  button.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
