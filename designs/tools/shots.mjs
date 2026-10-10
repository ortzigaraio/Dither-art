// Screenshots of the design mockups + sanity checks (console errors, external
// requests, horizontal scroll at 390 px).
// Usage: python3 -m http.server 8090 (repo root), then
//        node designs/tools/shots.mjs [page ...]   (uses tests/node_modules)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../tests/package.json'));
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8090/designs/';
const ALL = ['index', 'hermes', 'lowtech', 'poolsuite', 'gallery', 'aquirin', 'jeenyuhs', 'schemas'];
const pages = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const browser = await chromium.launch();
for (const name of pages) {
  const problems = [];
  // 1440 CSS px wide at DPR 0.8333 -> a 1200 px wide image
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1200 / 1440 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('request', (r) => { if (!r.url().startsWith('http://localhost')) problems.push('external: ' + r.url()); });
  await page.goto(BASE + name + '.html', { waitUntil: 'networkidle' });
  // scroll through so reveal-on-scroll elements and lazy images load
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += 500) { await page.evaluate((yy) => scrollTo({ top: yy, behavior: 'instant' }), y); await page.waitForTimeout(90); }
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(here, '../screens', name + '.png'), fullPage: true });
  await ctx.close();
  const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await m.newPage();
  await mp.goto(BASE + name + '.html', { waitUntil: 'networkidle' });
  const sw = await mp.evaluate(() => document.documentElement.scrollWidth);
  if (sw > 390) problems.push('horizontal scroll at 390: ' + sw);
  if (process.env.MOBILE) await mp.screenshot({ path: path.join(process.env.MOBILE, 'm-' + name + '.png'), fullPage: true });
  await m.close();
  console.log(name, problems.length ? problems : 'ok');
}
await browser.close();
