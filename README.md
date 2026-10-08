# HORAIN

Turn images into ASCII art and generative art, entirely in your browser. Nothing is uploaded: files are decoded,
processed and exported on your device.

HORAIN is a static site (no framework, no bundler, no build step): plain HTML, CSS and ES modules, served as-is
by GitHub Pages. The full specification lives in [`PLAN.md`](PLAN.md) (in Spanish); the rules for agents are in
[`CLAUDE.md`](CLAUDE.md); publishing steps are in [`DEPLOY.md`](DEPLOY.md).

## Status

Phases 0 and 1 of the plan are in place:

- Site skeleton, brand (espino logo, barbed-wire divider, the "eye"), six themes (HORAIN, CLARO, AMBER, CRT, PAPER, CAD),
  ES/EN interface and a validated dropzone (click, drag and drop anywhere, paste, demo).
- Render engine: preprocessing with CSS-filter semantics, all error-diffusion kernels, Bayer and blue-noise dithering,
  colour modes, glyph atlas with measured ink density, zoom/pan/split viewer.
- The complete **ASCII** mode with PNG, TXT, HTML, ANSI and clipboard export.

Video, webcam and the other output styles come in later phases.

## Run

```bash
python3 -m http.server 8080      # from the repo root
# open http://localhost:8080/
```

All paths are relative, so the same files work under `https://<user>.github.io/<repo>/` and at the root of a custom domain.

## Test

```bash
cd tests
npm install
npx playwright test
```

`@playwright/test` is pinned to 1.56.1 because its Chromium (revision 1194) is the one preinstalled in the development
sandbox: do not run `playwright install`. The suite serves the repo with `python3 -m http.server`, generates its own
fixtures (`tests/fixtures/`, git-ignored) and fails on any console error or CSP violation.

## Layout

```
index.html        single page, CSP in a <meta> tag
css/              tokens (6 themes), base, layout, components
src/engine/       pipeline, preprocess, analysis, dither, color, palettes, glyphs
src/modes/        one module per output style (interface in PLAN.md 6) + registry
src/ui/           header, dropzone, controls (generated from schemas), viewer, mode list, export panel, hero
src/io/           file validation by magic bytes, sources, PNG/text exports, download
src/i18n/         ES and EN dictionaries
assets/           brand logos, self-hosted fonts, icons
vendor/           third-party modules (kept local: no runtime CDN)
tests/            Playwright suite
```

## Adding an output style

Create `src/modes/<id>.js` implementing the interface of PLAN.md section 6 (parameter schema, `resolution()`,
`render()`, optional `toText()`/`toSVG()`), then import it in `src/modes/index.js`. The settings panel, the mode list,
the gallery card, the exports and the share link are all generated from that module.

## Privacy

No analytics, no cookies, no third-party requests at runtime (the optional depth-estimation model is the only planned
exception and is loaded only on request). Settings are stored in `localStorage` and a share link carries them in the
URL hash; the image itself is never stored or sent anywhere.

## Credits

Algorithms: Floyd-Steinberg, Jarvis-Judice-Ninke, Stucki, Atkinson, Burkes and Sierra error diffusion, Bayer ordered
dithering, void-and-cluster blue noise (Ulichney). Fonts (SIL OFL): Unbounded, Geist, Geist Mono, JetBrains Mono,
VT323, IBM Plex Mono, Space Mono. Licence: MIT.
