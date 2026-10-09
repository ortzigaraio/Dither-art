// The site must work unchanged under https://<user>.github.io/<repo>/ (PLAN.md 14): every URL is relative.
import { test, expect } from '@playwright/test';
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchPage, canvasStats, loadFixture, setControl, renderCount, waitForRender, waitForCanvasData } from './helpers.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = '/Ascii-dithering-Image-to-art-/';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json',
};

let server;
let base;
const outside = [];

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(PREFIX)) {
      outside.push(url.pathname); // a root-absolute URL would land here, like on github.io/<repo>/
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let file = resolve(root, decodeURIComponent(url.pathname.slice(PREFIX.length)) || 'index.html');
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    try {
      if (statSync(file).isDirectory()) file = resolve(file, 'index.html');
      statSync(file);
    } catch {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}${PREFIX}`;
});

test.afterAll(async () => {
  await new Promise((r) => server.close(r));
});

test('works under a sub-path: hero, studio, exports and assets all resolve relatively', async ({ page }) => {
  const guard = watchPage(page);
  await page.goto(base);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction(() => !document.getElementById('hero-demo').hidden);
  await expect.poll(async () => (await canvasStats(page, '#hero-canvas')).variance).toBeGreaterThan(0);

  // logo, valla and fonts really loaded from the sub-path
  const logoOk = await page.locator('.site-header .logo:visible').evaluate((img) => img.complete && img.naturalWidth > 0);
  expect(logoOk).toBe(true);
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => f.family);
  });
  expect(fonts).toEqual(expect.arrayContaining(['Unbounded', 'Geist', 'Geist Mono']));
  const mask = await page.locator('.valla').first().evaluate((el) => getComputedStyle(el).webkitMaskImage);
  expect(mask).toContain(`${PREFIX}assets/brand/wire-valla.svg`);

  // the studio works as well
  await loadFixture(page);
  expect((await canvasStats(page)).variance).toBeGreaterThan(0);
  const n = await renderCount(page);
  await setControl(page, 'gradient', 'blocks');
  await waitForRender(page, n);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-export="txt"]')]);
  expect(dl.suggestedFilename()).toMatch(/\.txt$/);

  // theme, language and the brand icon links
  await page.selectOption('#theme-select', 'paper');
  await expect(page.locator('.site-header .logo:visible')).toHaveAttribute('src', /horain-espino\.svg$/);
  const icon = await page.locator('link[rel="icon"]').evaluate((l) => l.href);
  expect(icon).toBe(`${base}assets/brand/horain-icon.svg`);

  expect(outside, `requests outside ${PREFIX}`).toEqual([]);
  await guard.assertClean(expect);
});

test('the heavy worker and the worker-backed modes resolve relatively under a sub-path', async ({ page }) => {
  const guard = watchPage(page);
  await page.goto(base);
  await page.waitForSelector('html[data-ready="true"]');
  await loadFixture(page);
  const spawned = await page.evaluate(async (prefix) => {
    const heavy = await import(`${prefix}src/engine/heavy.js`);
    const out = await heavy.run('debug.sleep', { ms: 20, steps: 2, echo: 'from a sub-path' });
    return { echo: out.echo, stats: heavy.stats() };
  }, PREFIX);
  expect(spawned.echo).toBe('from a sub-path');
  expect(spawned.stats.hasWorker).toBe(true);
  expect(spawned.stats.workerFailed).toBe(false);

  // PETSCII at 80 columns is matched in the worker
  let n = await renderCount(page);
  await page.locator('#mode-list .mode-item[data-mode-id="petscii"]').click();
  await waitForRender(page, n);
  n = await renderCount(page);
  await setControl(page, 'grid', '80');
  await waitForCanvasData(page, 'cols', 80); // a frame of the old 40-column grid may still be in flight
  expect((await canvasStats(page)).variance).toBeGreaterThan(0);
  expect(await page.locator('#viewer-canvas').getAttribute('data-cols')).toBe('80');
  expect(await page.locator('#chip-error').isHidden()).toBe(true);
  expect(outside, `requests outside ${PREFIX}`).toEqual([]);
  await guard.assertClean(expect);
});
