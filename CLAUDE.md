# CLAUDE.md

HORAIN: a static GitHub Pages site that turns images, video and webcam input into generative art
(ASCII, dithering, Braille, halftone, plotter SVG, 3D and more). Everything runs in the browser.

**The full specification is in `PLAN.md` (in Spanish). Read it before you write any code, and work one phase at a time (PLAN.md §12).**

## Hard rules
- No framework, no bundler, no build step. Use vanilla ES modules, plain CSS, WebGL2, Canvas2D and Web Workers.
- Use relative paths only (`./src/...`), because the site is served under `/<repo>/`.
- Load third-party code only through the import map in `index.html`, pinned to exact versions (PLAN.md §3).
  Workers don't inherit the import map, so they import from the full CDN URL.
- Each output style is one module in `src/modes/` that implements the interface in PLAN.md §6.
  Parameter controls are generated from the mode's schema. Never hand-write them.
- Every user-visible string goes through `t()` (ES + EN dictionaries in `src/i18n/`).
- Wrap all `localStorage` access in try/catch. The app must still work when storage is blocked.
- Run heavy CPU work in `src/workers/` and make it cancellable by `jobId`.

## Run & test
- Serve: `python3 -m http.server 8080` from the repo root, then open http://localhost:8080/
- Smoke tests: `cd tests && npm install && npx playwright test`. Chromium is preinstalled at `/opt/pw-browsers`,
  so never run `playwright install`.
- Before every commit: there must be no console errors, and every registered mode must render a non-blank canvas.

## Commits
Small and focused, one per mode or feature, with English messages such as `feat(mode): add braille renderer`.
