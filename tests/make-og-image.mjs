// Generates assets/og-image.png (1200x630, Open Graph / Twitter card) with the app itself: the real engine renders
// the procedural demo in four modes, next to the official logo (unmodified SVG from assets/brand/) and the headline.
// Usage: cd tests && node make-og-image.mjs   (uses the preinstalled Chromium; no network)
import { chromium } from '@playwright/test';
import { writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRepo } from './make-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../assets/og-image.png');

const server = await serveRepo();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  await page.goto(`${base}/tests/blank.html`);
  const tiles = await page.evaluate(async () => {
    const { createPipeline } = await import('/src/engine/pipeline.js');
    const { getMode } = await import('/src/modes/index.js');
    const { defaultsOf, sanitizeParams } = await import('/src/state.js');
    const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
    const { COLOR_PARAMS } = await import('/src/engine/color.js');
    const { DemoSource } = await import('/src/io/sources.js');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/assets/fonts/fonts.css';
    document.head.appendChild(link);
    await new Promise((r) => { link.onload = r; });
    await document.fonts.load('600 64px "Unbounded"', 'turn images');
    await document.fonts.load('500 20px "Geist"', 'styles');
    await document.fonts.load('400 16px "Geist Mono"', 'dither');
    const source = await DemoSource.create({ animated: true, width: 960, height: 640 });
    const theme = { ink: '#c4f169', bg: '#15181e' };
    const looks = [
      { id: 'ascii', mode: { gradient: 'standard' }, global: { cols: 72 } },
      { id: 'halftone', preset: 'cmyk', mode: { cellSize: 10 } },
      { id: 'dither1bit', preset: 'gameboy', mode: { pixelSize: 3 } },
      { id: 'contours' },
    ];
    const urls = [];
    for (const look of looks) {
      const mode = getMode(look.id);
      const preset = look.preset ? mode.presets.find((p) => p.id === look.preset) : null;
      const params = {
        global: sanitizeParams(IMAGE_PARAMS, { ...defaultsOf(IMAGE_PARAMS), ...(look.global || {}) }),
        color: sanitizeParams(COLOR_PARAMS, { ...defaultsOf(COLOR_PARAMS), ...(preset?.color || {}) }),
        depth: {}, postfx: {},
        mode: sanitizeParams(mode.params, { ...defaultsOf(mode.params), ...(preset?.mode || {}), ...(look.mode || {}) }),
      };
      const pipe = createPipeline();
      const r = await pipe.render({ source, mode, params, time: 1.4, quality: 'full', isExport: true, outScale: 1, theme });
      const c = document.createElement('canvas');
      c.width = 560; c.height = 370; // tile 2x of its CSS box, cover-cropped
      const g = c.getContext('2d');
      g.fillStyle = theme.bg;
      g.fillRect(0, 0, c.width, c.height);
      const k = Math.max(c.width / r.width, c.height / r.height);
      g.imageSmoothingQuality = 'high';
      g.drawImage(r.canvas, (c.width - r.width * k) / 2, (c.height - r.height * k) / 2, r.width * k, r.height * k);
      urls.push({ id: look.id, url: c.toDataURL('image/png') });
      pipe.dispose();
    }
    return urls;
  });

  await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${base}/assets/fonts/fonts.css">
<style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #15181E; color: #F7F8FA; }
  body { display: grid; grid-template-columns: 560px 1fr; gap: 40px; padding: 56px 56px 48px 64px; box-sizing: border-box; font-family: Geist, sans-serif; }
  .left { display: flex; flex-direction: column; min-width: 0; }
  .lockup { display: flex; align-items: center; gap: 14px; }
  .name { font-family: Unbounded; font-weight: 600; font-size: 34px; letter-spacing: -.02em; }
  .by { font-weight: 600; font-size: 13px; letter-spacing: .1em; text-transform: uppercase; color: #A3A7AE; margin-right: 24px; }
  .lockup img { height: 40px; display: block; }
  h1 { margin: 56px 0 0; font-family: Unbounded; font-weight: 600; font-size: 60px; line-height: 1.04; letter-spacing: -.03em; }
  h1 em { font-style: normal; color: #C4F169; }
  .sub { margin: 26px 0 0; font-size: 21px; color: #A3A7AE; }
  .url { margin-top: auto; font-family: 'Geist Mono'; font-size: 18px; color: #C4F169; letter-spacing: .02em; }
  .valla { height: 12px; margin: 22px 0 0; background: #C4F169; -webkit-mask: url(${base}/assets/brand/wire-valla.svg) repeat-x left center / auto 12px; mask: url(${base}/assets/brand/wire-valla.svg) repeat-x left center / auto 12px; opacity: .9; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 14px; height: 100%; }
  .tile { position: relative; border: 1px solid #2C313A; border-radius: 12px; overflow: hidden; background: #1B1F26; }
  .tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tile span { position: absolute; left: 10px; bottom: 9px; font-family: 'Geist Mono'; font-size: 12px; padding: 3px 8px; border-radius: 999px; background: rgba(21,24,30,.82); color: #F7F8FA; border: 1px solid #2C313A; }
</style></head><body>
  <div class="left">
    <div class="lockup"><span class="name">dither</span><span class="by">by</span><img src="${base}/assets/brand/horain-espino-on-dark.svg" alt="Horain"></div>
    <h1>turn images &amp; video into <em>art</em></h1>
    <div class="valla"></div>
    <p class="sub">25 styles · 100% in your browser · nothing is uploaded</p>
    <div class="url">dither.ortzigar.org</div>
  </div>
  <div class="grid">${tiles.map((t) => `<div class="tile"><img src="${t.url}" alt=""><span>${t.id}</span></div>`).join('')}</div>
</body></html>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  writeFileSync(out, await page.screenshot({ type: 'png' }));
  console.log('written', out, Math.round(statSync(out).size / 1024), 'KB');
} finally {
  await browser.close();
  server.close();
}
