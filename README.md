<div align="center">

<img src="assets/logo.svg" width="72" height="72" alt="PosterForge logo" />

# PosterForge

**Turn any image into a print-ready PDF poster — entirely in your browser.**

No backend. No build step. No uploads. No API keys. No tracking.

[![License: MIT](https://img.shields.io/badge/License-MIT-6d5efc.svg)](LICENSE)
![No build step](https://img.shields.io/badge/build-none%20required-34d399)
![Vanilla JS](https://img.shields.io/badge/JavaScript-vanilla%20ES%20modules-fbbf24)

</div>

---

PosterForge takes the images you drop on it and produces genuine print-ready PDFs:
correct physical page dimensions, true 300 DPI raster data, Lanczos resampling,
and an honest assessment of how well each image will actually print.

Every pixel is processed on your own machine. Drop the folder on a static host
and it works — there is nothing to install, compile, or configure.

## Why it exists

Most "image to PDF" tools do the laziest possible thing: they wrap your JPEG in
a PDF envelope at whatever size it happens to be, scale it with the browser's
default bilinear filter, and tell you nothing about whether the result will look
good on paper.

PosterForge does the opposite:

- The page **MediaBox** is the exact trim size you asked for. Acrobat's Document
  Properties will read `8.5 × 11 in`, not `1024 × 768 px`.
- The embedded raster is sized `inches × DPI`, so a 24 × 36 in poster at 300 DPI
  really does contain a 7200 × 10800 pixel image.
- Resampling uses **Pica's 3-lobe Lanczos filter** in Web Workers, with gentle
  unsharp masking — not `drawImage`.
- The quality analyser reports **effective DPI derived from your original pixel
  count**, because upscaling cannot invent detail and you deserve to know that
  before you pay a print shop.

## Features

### Input
- Drag & drop, or a file picker — both accept multiple files at once
- PNG, JPEG, WEBP, BMP, GIF (first frame), AVIF, and TIFF where the browser supports it
- EXIF orientation honoured, so phone photos are never printed sideways
- Queue holds up to 500 images

### Output
- True print-ready PDFs at your chosen DPI (150 / 200 / 300 / 600 / custom)
- Twelve paper stocks out of the box; adding more is a one-line change
- Auto, portrait, or landscape orientation — *auto* matches the page to each image
- White, black, transparent, or custom background colour
- Download individually, or as a single ZIP with a plain-text manifest

### Fit modes
| Mode | What it does |
| --- | --- |
| **Fit** | Scales the image as large as possible while keeping all of it visible. Nothing is cropped; unused paper shows the background. |
| **Fill** | Covers the whole page edge to edge. Aspect ratio is preserved, so the overhanging edges are cropped. |
| **Border** | Like Fit, but inset by an even margin on all four edges — a gallery mat that leaves room for framing. |

Two switches modify all three:

- **Keep Aspect Ratio** (on by default) — images are never distorted. Turn it off
  only if you deliberately want a stretch.
- **Maximize Image** (on by default) — small images are upscaled to fill the page.
  Turn it off to print at native size and never larger.

### Quality analysis
Every image in the queue shows its resolution, aspect ratio, printed size, scale
factor, estimated output size, and a five-star print-quality rating derived from
its **effective DPI**:

| Rating | Effective DPI | Meaning |
| --- | --- | --- |
| ★★★★★ Excellent | ≥ 300 | Commercial print standard. Sharp at any viewing distance. |
| ★★★★ Good | 200–299 | Clean at normal viewing distance. |
| ★★★ Fair | 150–199 | Fine as a wall poster; soft up close. |
| ★★ Poor | 100–149 | Visible softness. |
| ★ Very Poor | < 100 | Obviously blurry. Find a larger source. |

Each card also carries a plain-English recommendation, e.g.
*"Only 84 DPI — a 3.6× upscale. Detail will be obviously blurry; find a larger
source, or print at 5.3 × 3.5 in or smaller."*

### Everything else
- Dark and light themes, following your OS preference and remembered afterwards
- Settings persisted in `localStorage`
- Cancellable batches with a live per-stage progress bar
- Keyboard navigable throughout, with ARIA labelling and a reduced-motion mode
- Fully responsive, from phone to ultrawide

## Screenshots

> Replace these placeholders with real captures before publishing.

| Dark | Light |
| --- | --- |
| ![PosterForge, dark theme](docs/screenshot-dark.png) | ![PosterForge, light theme](docs/screenshot-light.png) |

| Quality analysis | Batch export |
| --- | --- |
| ![Quality analysis cards](docs/screenshot-quality.png) | ![Batch export](docs/screenshot-batch.png) |

## Installation

There is nothing to install. Clone the repository and open it:

```bash
git clone https://github.com/yourname/PosterForge.git
cd PosterForge
```

ES modules are subject to the same-origin policy, so `file://` will not work —
you need any static file server. Pick whichever you already have:

```bash
python3 -m http.server 8080     # Python 3
npx serve .                     # Node
php -S localhost:8080           # PHP
```

Then open <http://localhost:8080>.

> **Note:** Node is used only as a convenience during local development. The
> application itself has no build step and no runtime dependency on Node.

## Deployment to GitHub Pages

1. Push the repository to GitHub.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
3. Choose your default branch and the `/ (root)` folder. Save.
4. Wait a minute, then open `https://<user>.github.io/<repo>/`.

That is the whole process. The `.nojekyll` file in the repository root stops
GitHub's Jekyll pipeline from touching anything, and every path in the project is
relative, so the app works from a subdirectory without configuration.

The same folder deploys unchanged to Netlify, Vercel, Cloudflare Pages, S3, or
any web server that can serve static files.

## Project structure

```
PosterForge/
├── index.html              # Single page; all markup lives here
├── README.md
├── LICENSE
├── .nojekyll               # Tells GitHub Pages to serve files verbatim
├── assets/
│   ├── logo.svg
│   └── favicon.png
├── css/
│   └── main.css            # Design tokens, components, themes
├── js/
│   ├── app.js              # Composition root: state and orchestration
│   ├── ui.js               # The only module that touches the DOM
│   ├── imageProcessor.js   # Decoding, thumbnails, Lanczos resampling
│   ├── pdfGenerator.js     # pdf-lib document assembly
│   ├── qualityAnalyzer.js  # Effective-DPI maths and ratings
│   ├── paperSizes.js       # Paper catalogue and page geometry
│   └── zipExporter.js      # Downloads and ZIP archives
└── libs/                   # Vendored third-party libraries
    ├── pdf-lib.min.js
    ├── pica.min.js
    ├── jszip.min.js
    └── FileSaver.min.js
```

### Architecture in one paragraph

`app.js` owns all state and calls into everything else. `ui.js` is the only
module that touches `document`; it renders state and reports intent through
callbacks. `paperSizes.js` holds the paper catalogue and the placement geometry
that both `qualityAnalyzer.js` and `pdfGenerator.js` depend on, so the numbers
shown in the preview are computed by exactly the same code that lays out the
PDF — the preview can never disagree with the output.

## Adding a paper size

One line in [`js/paperSizes.js`](js/paperSizes.js):

```js
{ id: '20x30', label: '20 × 30 in', width: 20, height: 30, group: 'Poster' },
```

Sizes are stored in portrait orientation and in inches; use the `mm()` helper for
metric stocks. The picker, the geometry, the analyser and the file names all pick
it up automatically.

## Supported browsers

| Browser | Minimum | Notes |
| --- | --- | --- |
| Chrome / Edge | 90+ | Full support, including AVIF |
| Firefox | 90+ | Full support |
| Safari | 15.4+ | Lower canvas-area limit; very large posters are auto-clamped |
| Mobile Safari / Chrome Android | Recent | Works, but large batches are memory-bound |

The app requires ES modules, `createImageBitmap`, `canvas.toBlob`,
`AbortController` and CSS custom properties. TIFF and HEIC decoding depend on the
platform — Safari decodes HEIC natively, most others do not.

Browsers cap total canvas area (Chrome around 268 Mpx, Safari far lower).
Requests beyond a safe ceiling are automatically scaled down and the affected
poster reports the DPI it actually achieved, rather than silently producing a
blank page.

## Privacy

PosterForge has no server component, makes no network requests after the page
loads, and includes no analytics, telemetry, cookies, or third-party scripts.
The libraries are vendored in `libs/`, so there is not even a CDN request. Load
the page once and it works offline.

Only two things are stored, both in `localStorage`, both on your machine: your
settings and your theme preference.

## Roadmap

- [ ] **AI upscaling** — optional in-browser super-resolution (ESRGAN via WebGPU) for low-resolution sources
- [ ] **Bleed** — configurable bleed area beyond the trim for edge-to-edge printing
- [ ] **Print marks** — crop marks, registration marks, and colour bars
- [ ] **CMYK export** — ICC-aware conversion for commercial presses
- [ ] **Poster borders** — decorative frames, gallery mats, and drop shadows
- [ ] **Gallery** — multi-image contact sheets and grid layouts on one page
- [ ] **Poster templates** — title blocks, captions, and typographic presets
- [ ] Multi-page PDFs (one document containing the whole batch)
- [ ] Tiled posters split across several sheets
- [ ] Custom paper sizes entered by hand

Ideas and pull requests for any of these are welcome.

## Contributing

Contributions are very welcome.

1. Fork the repository and create a branch: `git checkout -b feature/my-change`.
2. Make your change. Keep the constraints: **no frameworks, no build step, no
   network requests, no globals.**
3. Test in at least Chrome and Firefox, in both themes, at desktop and mobile
   widths, with a keyboard only.
4. Open a pull request describing the change and how you verified it.

### House style
- Vanilla ES modules; every module has a header comment explaining its job.
- Public functions carry JSDoc, including `@param` and `@returns`.
- Two-space indentation, single quotes, semicolons, `const` by default.
- Comments explain *why*, never *what*.
- No duplicated logic — if two modules need the same maths, it moves to a shared one.
- CSS uses the existing custom properties. New colours become tokens.

### Good first issues
- Add a paper size (see above)
- Add a fit mode
- Improve the file-size estimator's accuracy
- Add unit tests for `paperSizes.js` and `qualityAnalyzer.js` (both are pure)

## Third-party libraries

| Library | Version | Licence | Used for |
| --- | --- | --- | --- |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT | PDF assembly |
| [Pica](https://github.com/nodeca/pica) | 9.0.1 | MIT | Lanczos resampling |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | MIT / GPL-3.0 | ZIP archives |
| [FileSaver.js](https://github.com/eligrey/FileSaver.js) | 2.0.5 | MIT | Saving files |

All four are vendored in `libs/` so the application is fully self-contained.

## License

[MIT](LICENSE) © PosterForge contributors.
