// Rasterises assets/brand/horain-icon.svg (unmodified) to the PNG sizes browsers need.
// Usage: node make-icons.mjs   (writes ../assets/icons/*.png). Uses the preinstalled Chromium.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const svg = 'data:image/svg+xml;base64,' + readFileSync(resolve(here, '../assets/brand/horain-icon.svg')).toString('base64');
const outDir = resolve(here, '../assets/icons');
mkdirSync(outDir, { recursive: true });

const sizes = [{ name: 'apple-touch-icon.png', px: 180 }];

const browser = await chromium.launch();
try {
  for (const { name, px } of sizes) {
    const page = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
    // Ink background so iOS does not paint the transparent corners black.
    await page.setContent(
      `<body style="margin:0;background:#15181E"><img src="${svg}" style="display:block;width:${px}px;height:${px}px;object-fit:cover"></body>`,
    );
    await page.waitForFunction(() => document.images[0].complete);
    writeFileSync(resolve(outDir, name), await page.screenshot({ type: 'png' }));
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('icons written to', outDir);
