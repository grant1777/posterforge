/**
 * zipExporter.js
 * -----------------------------------------------------------------------------
 * Download helpers: single PDFs, and batch archives built with JSZip.
 *
 * PDFs are already compressed, so the archive is stored rather than deflated —
 * it is far faster and the size difference is negligible.
 */

import { deduplicateFilenames } from './pdfGenerator.js';

/** Timestamp used in the archive name, e.g. `20260804-1432`. */
function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * Save a single blob to disk.
 *
 * @param {Blob} blob
 * @param {string} filename
 * @returns {void}
 */
export function downloadBlob(blob, filename) {
  if (typeof window.saveAs === 'function') {
    window.saveAs(blob, filename);
    return;
  }

  // Fallback for the (unlikely) case FileSaver.js is unavailable.
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Bundle every generated poster into a single ZIP and save it.
 *
 * @param {import('./pdfGenerator.js').PosterResult[]} results
 * @param {Object} [options]
 * @param {(progress: { percent: number, stage: string }) => void} [options.onProgress]
 * @param {string} [options.archiveName]
 * @returns {Promise<{ filename: string, bytes: number }>}
 * @throws {Error} When JSZip is missing or there is nothing to export.
 */
export async function downloadAllAsZip(results, { onProgress = () => {}, archiveName } = {}) {
  if (typeof window.JSZip !== 'function') {
    throw new Error('JSZip failed to load. Check that libs/jszip.min.js is present.');
  }
  if (!results.length) {
    throw new Error('There are no posters to export yet.');
  }

  const zip = new window.JSZip();
  const names = deduplicateFilenames(results.map((result) => result.filename));

  results.forEach((result, index) => {
    zip.file(names[index], result.blob, { binary: true, compression: 'STORE' });
  });

  zip.file('README.txt', buildManifest(results, names));

  onProgress({ percent: 0, stage: 'Packing archive' });

  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'STORE', streamFiles: true },
    (metadata) => onProgress({ percent: metadata.percent, stage: 'Packing archive' }),
  );

  const filename = archiveName ?? `posterforge-${timestamp()}.zip`;
  downloadBlob(blob, filename);
  onProgress({ percent: 100, stage: 'Finished' });

  return { filename, bytes: blob.size };
}

/**
 * A plain-text manifest so the archive is self-describing months later.
 *
 * @param {import('./pdfGenerator.js').PosterResult[]} results
 * @param {string[]} names
 * @returns {string}
 */
function buildManifest(results, names) {
  const lines = [
    'PosterForge export',
    `Generated: ${new Date().toISOString()}`,
    `Posters: ${results.length}`,
    '',
    'file | source | page | effective DPI | rating',
    '-'.repeat(72),
  ];

  results.forEach((result, index) => {
    const { report } = result;
    lines.push([
      names[index],
      result.name,
      `${report.page.width.toFixed(2)}x${report.page.height.toFixed(2)}in`,
      `${Math.round(report.effectiveDpi)} DPI`,
      report.ratingLabel,
    ].join(' | '));
  });

  lines.push('', 'Generated locally in the browser. https://github.com/grant1777/posterforge');
  return lines.join('\n');
}
