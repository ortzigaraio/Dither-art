// Generates the test fixtures (nothing licensed is committed). Run by global-setup.mjs when missing,
// or by hand: `node make-fixtures.mjs`. Output goes to tests/fixtures/ (gitignored).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const fixturesDir = resolve(here, 'fixtures');

/** fixture.png: gradients + shapes + text, 800x600, deterministic. */
async function makeImage(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 600;
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, 800, 600);
    bg.addColorStop(0, '#0b1d3a');
    bg.addColorStop(0.5, '#c4f169');
    bg.addColorStop(1, '#ff6b5a');
    g.fillStyle = bg;
    g.fillRect(0, 0, 800, 600);

    const rad = g.createRadialGradient(300, 260, 10, 300, 300, 190);
    rad.addColorStop(0, '#ffffff');
    rad.addColorStop(0.5, '#4a6cf7');
    rad.addColorStop(1, '#0a0f2a');
    g.fillStyle = rad;
    g.beginPath();
    g.arc(300, 300, 190, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = '#111111';
    g.fillRect(520, 90, 200, 150);
    g.fillStyle = '#f7f8fa';
    g.beginPath();
    g.moveTo(560, 400);
    g.lineTo(700, 560);
    g.lineTo(520, 560);
    g.closePath();
    g.fill();

    g.strokeStyle = '#ffffff';
    g.lineWidth = 6;
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.moveTo(40 + i * 28, 20);
      g.lineTo(120 + i * 28, 140);
      g.stroke();
    }

    g.fillStyle = '#ffffff';
    g.font = '700 84px sans-serif';
    g.textBaseline = 'alphabetic';
    g.fillText('HORAIN', 70, 560);
    g.fillStyle = '#000000';
    g.font = '700 40px monospace';
    g.fillText('ASCII 0123', 480, 330);
    return c.toDataURL('image/png');
  });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

export async function makeFixtures() {
  mkdirSync(fixturesDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    writeFileSync(resolve(fixturesDir, 'fixture.png'), await makeImage(page));
    // Phase 2 adds fixture.webm (3 s with audio, made with Mediabunny in a test page).
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await makeFixtures();
  console.log('fixtures written to', fixturesDir);
}

export const fixtureExists = (name) => existsSync(resolve(fixturesDir, name));
