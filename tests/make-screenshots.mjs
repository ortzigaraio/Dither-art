// README screenshots, generated with the app itself (no hand-edited images): writes docs/screenshots/*.jpg.
// Usage: cd tests && node make-screenshots.mjs   (preinstalled Chromium; serves the repo on a random port)
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRepo } from './make-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../docs/screenshots');
mkdirSync(outDir, { recursive: true });

const server = await serveRepo();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();

async function shot(name, { width = 1440, height = 900, scale = 1, theme = 'horain', lang = 'en', setup } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.addInitScript(([th, l]) => {
    localStorage.clear();
    localStorage.setItem('horain.theme', th);
    localStorage.setItem('horain.lang', l);
  }, [theme, lang]);
  await page.goto(base);
  await page.waitForSelector('html[data-ready="true"]');
  if (setup) await setup(page);
  await page.waitForTimeout(1800);
  const file = resolve(outDir, `${name}.jpg`);
  writeFileSync(file, await page.screenshot({ type: 'jpeg', quality: 74 }));
  console.log(name, Math.round(statSync(file).size / 1024), 'KB');
  await page.close();
}

const demo = async (page) => {
  await page.click('#dz-actions [data-action="demo"]');
  await page.waitForSelector('body[data-view="studio"]');
};
const mode = (id, extra) => async (page) => {
  await demo(page);
  await page.click(`#mode-list [data-mode-id="${id}"]`);
  if (extra) await extra(page);
};

try {
  await shot('home', {});
  await shot('gallery', {
    setup: async (page) => {
      await page.evaluate(() => document.getElementById('modes').scrollIntoView());
      await page.waitForFunction(() => document.querySelectorAll('.mode-card[data-thumb]').length >= 8, null, { timeout: 60_000 });
    },
  });
  await shot('studio-ascii', { setup: demo });
  await shot('studio-halftone-light', { theme: 'claro', setup: mode('halftone', (p) => p.click('#controls [data-group="presets"] [data-preset="cmyk"]')) });
  await shot('studio-crt', {
    theme: 'crt',
    setup: mode('dither1bit', async (p) => {
      await p.evaluate(() => {
        const d = document.querySelector('[data-group="postfx"]');
        d.open = true;
        const s = d.querySelector('[data-param="preset"] select');
        s.value = 'crt';
        s.dispatchEvent(new Event('change'));
        d.scrollIntoView();
      });
    }),
  });
  await shot('studio-blueprint', { theme: 'cad', setup: mode('blueprint') });
  await shot('studio-raymarch', { theme: 'amber', setup: mode('raymarch') });
  await shot('mobile', { width: 390, height: 844, scale: 2, setup: demo });
} finally {
  await browser.close();
  server.close();
}
