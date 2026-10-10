// Generates assets/og-image.png (1200x630, Open Graph / Twitter card) in Dither's identity: black, electric blue and
// white ink, the typographic DITHER wordmark and a landing picture that Dither itself rendered (linear halftone).
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
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${base}/assets/fonts/fonts.css">
<link rel="stylesheet" href="${base}/assets/fonts/display/display.css">
<style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #050505; color: #F4F2EC; }
  body { display: grid; grid-template-columns: 1fr 470px; font-family: Geist, sans-serif; }
  .left { display: flex; flex-direction: column; padding: 48px 48px 40px 56px; min-width: 0; }
  .top { display: flex; justify-content: space-between; align-items: baseline; font-family: 'Geist Mono'; font-size: 15px; letter-spacing: .12em; text-transform: uppercase; color: #A2A2AA; }
  .mark { font-family: 'Big Shoulders Display'; font-weight: 900; font-size: 44px; letter-spacing: .06em; color: #F4F2EC; }
  h1 { margin: 34px 0 0; font-family: 'Big Shoulders Display'; font-weight: 800; font-size: 108px; line-height: .94; text-transform: uppercase; }
  h1 em { display: inline-block; line-height: .86; font-style: normal; background: #1E1EFF; color: #fff; padding: 0 .07em; }
  .foot { margin-top: auto; display: flex; justify-content: space-between; border-top: 1px solid #26262C; padding-top: 14px; font-family: 'Geist Mono'; font-size: 15px; letter-spacing: .1em; text-transform: uppercase; color: #A2A2AA; }
  .foot b { color: #8C8CFF; font-weight: 500; }
  .art { background: #1E1EFF; overflow: hidden; position: relative; }
  .art img { position: absolute; left: 50%; top: 50%; width: 100%; transform: translate(-50%, -46%) scale(1.08); display: block; }
</style></head><body>
  <div class="left">
    <div class="top"><span class="mark">DITHER</span><span>[ image &rarr; art ]</span></div>
    <h1>turn images &amp; video into <em>art</em></h1>
    <div class="foot"><span>26 styles · 100% in your browser</span><b>dither.ortzigar.org</b></div>
  </div>
  <div class="art"><img src="${base}/assets/landing/remeros-lines-1600.webp" alt=""></div>
</body></html>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await page.evaluate(async () => {
    await document.fonts.load('800 112px "Big Shoulders Display"', 'TURN');
    await document.fonts.load('400 15px "Geist Mono"', 'dither');
    await document.fonts.ready;
  });
  await page.waitForTimeout(300);
  writeFileSync(out, await page.screenshot({ type: 'png' }));
  console.log('written', out, Math.round(statSync(out).size / 1024), 'KB');
} finally {
  await browser.close();
  server.close();
}
