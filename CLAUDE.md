# CLAUDE.md

HORAIN: a static GitHub Pages site that turns images, video and webcam input into generative art
(ASCII, dithering, Braille, halftone, plotter SVG, 3D and more). Everything runs in the browser.

**The full specification is in `PLAN.md` (in Spanish). Read it before you write any code, and work one phase at a time (PLAN.md §12).**
**The guardrails in PLAN.md §18 override everything else.**

## Hard rules
- No framework, no bundler, no build step. Use vanilla ES modules, plain CSS, WebGL2, Canvas2D and Web Workers.
- Use relative paths only (`./src/...`). The site must work both under `/<repo>/` on github.io and at the root of the custom domain.
- Third-party code is already vendored in `vendor/` (see `vendor/README.md`). Import it by relative path, because there is no import map.
  The only CDN exception is `@huggingface/transformers` inside `src/workers/depth.worker.js`, and only on user request.
- Fonts are self-hosted in `assets/fonts/fonts.css`: Unbounded for display, Geist for UI, and Geist Mono for data and the ASCII render.
- The brand logo is always one of the SVGs in `assets/brand/`. Never edit, recolor or retype it.
- Each output style is one module in `src/modes/` that implements the interface in PLAN.md §6.
  Parameter controls are generated from the mode's schema. Never hand-write them.
- Every user-visible string goes through `t()` (ES + EN dictionaries in `src/i18n/`).
- Never use `innerHTML` with user-provided text. Escape HTML/SVG exports and validate external state (PLAN.md §18.3).
- Wrap all `localStorage` access in try/catch. The app must still work when storage is blocked.
- Run heavy CPU work in `src/workers/` and make it cancellable by `jobId`.
- Never create `CNAME`, push to `main`, force-push, or touch `assets/brand/`, `assets/fonts/`, `vendor/`, `worker/counter/` or `DEPLOY.md`.

## Run & test
- Serve: `python3 -m http.server 8080` from the repo root, then open http://localhost:8080/
- Smoke tests: `cd tests && npm install && npx playwright test`. The browser is preinstalled, so never run `playwright install`.
  Launch with `executablePath: '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell'`
  (if that path is missing, check `ls /opt/pw-browsers`).
- The test Chromium can't encode H.264, so test video export with WebM and skip MP4 when `canEncodeVideo('avc')` is false.
  The sandbox also has no CDN access, which is why everything lives in `vendor/`.
- Before every commit: there must be no console errors and no CSP violations, and every registered mode must render a non-blank canvas.

## Commits
Small and focused, one per mode or feature, with English messages such as `feat(mode): add braille renderer`.
Record any departure from the plan in PLAN.md §19 "Desviaciones".
