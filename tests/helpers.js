import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PNG = resolve(here, 'fixtures/fixture.png');
export const FIXTURE_WEBM = resolve(here, 'fixtures/fixture.webm');
export const SCREENSHOT_DIR = resolve(here, 'screenshots');

/**
 * Collects everything that must stay empty on a healthy page: console errors, uncaught
 * exceptions, failed same-origin requests (404...) and CSP violations.
 */
export function watchPage(page) {
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });
  return {
    problems,
    async cspViolations() {
      return page.evaluate(() => window.__csp || []);
    },
    async assertClean(expect) {
      const csp = await this.cspViolations();
      expect(csp, 'CSP violations').toEqual([]);
      expect(problems, 'console errors / failed requests').toEqual([]);
    },
  };
}

/** Wait until the app finished booting (main.js sets data-ready on <html>). */
export async function gotoApp(page, path = '/') {
  await page.goto(path);
  await page.waitForSelector('html[data-ready="true"]');
}

// ---------------------------------------------------------------------------
// Studio helpers
// ---------------------------------------------------------------------------

/** Number of frames the viewer has presented so far. */
export async function renderCount(page) {
  return page.evaluate(() => Number(document.getElementById('viewer-canvas').dataset.frame || 0));
}

/** Wait for a frame newer than `before`, then for the render loop to go quiet. */
export async function waitForRender(page, before = 0) {
  await page.waitForFunction(
    (b) => Number(document.getElementById('viewer-canvas').dataset.frame || 0) > b,
    before,
  );
  await settle(page);
}

/** Wait until the frame counter stays unchanged for ~120 ms (fonts loading can trigger a second pass). */
export async function settle(page, quietMs = 120) {
  let last = -1;
  for (let i = 0; i < 80; i++) {
    const n = await renderCount(page);
    if (n === last) return n;
    last = n;
    await page.waitForTimeout(quietMs);
  }
  return last;
}

/** Open the fixture image and wait for the first render in the studio. */
export async function loadFixture(page, file = FIXTURE_PNG) {
  await page.setInputFiles('#file-input', file);
  await page.waitForSelector('body[data-view="studio"]');
  await page.waitForFunction(() => Number(document.getElementById('viewer-canvas').dataset.frame || 0) > 0);
  await settle(page);
}

/** Pixel statistics of the viewer canvas: luma variance, mean, distinct colours and a content hash. */
export async function canvasStats(page, selector = '#viewer-canvas') {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel);
    const g = c.getContext('2d');
    const { data } = g.getImageData(0, 0, c.width, c.height);
    let sum = 0;
    let sum2 = 0;
    let h = 2166136261;
    let opaque = 0;
    const colors = new Set();
    const n = c.width * c.height;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const l = (0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]) / 255;
      sum += l;
      sum2 += l * l;
      if (data[o + 3] > 0) opaque++;
      if (colors.size < 5000) colors.add((data[o] << 16) | (data[o + 1] << 8) | data[o + 2]);
      h = Math.imul(h ^ data[o], 16777619);
      h = Math.imul(h ^ data[o + 1], 16777619);
      h = Math.imul(h ^ data[o + 2], 16777619);
      h = Math.imul(h ^ data[o + 3], 16777619);
    }
    const mean = sum / n;
    return {
      width: c.width,
      height: c.height,
      mean,
      variance: sum2 / n - mean * mean,
      colors: colors.size,
      opaque,
      hash: (h >>> 0).toString(16),
    };
  }, selector);
}

/** Set a control (found by data-param) the way a user would. */
export async function setControl(page, id, value) {
  const row = page.locator(`#controls [data-param="${id}"]`);
  await row.waitFor({ state: 'attached' });
  const cls = await row.getAttribute('class');
  if (cls.includes('ctl-range')) {
    const num = row.locator('.ctl-num');
    await num.fill(String(value));
    await num.press('Enter');
  } else if (cls.includes('ctl-toggle')) {
    const sw = row.locator('.switch');
    if ((await sw.isChecked()) !== !!value) await sw.click();
  } else if (cls.includes('ctl-select')) {
    await row.locator('select').selectOption(String(value));
  } else if (cls.includes('ctl-color')) {
    await row.locator('.swatch').evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  } else if (cls.includes('ctl-text')) {
    await row.locator('input.input').fill(String(value));
  } else {
    throw new Error(`unsupported control ${id}: ${cls}`);
  }
}

/** Current value shown by a control. */
export async function getControl(page, id) {
  const row = page.locator(`#controls [data-param="${id}"]`);
  const cls = await row.getAttribute('class');
  if (cls.includes('ctl-range')) return Number(await row.locator('.ctl-num').inputValue());
  if (cls.includes('ctl-toggle')) return row.locator('.switch').isChecked();
  if (cls.includes('ctl-select')) return row.locator('select').inputValue();
  if (cls.includes('ctl-color')) return row.locator('.swatch').inputValue();
  if (cls.includes('ctl-text')) return row.locator('input.input').inputValue();
  throw new Error(`unsupported control ${id}`);
}

/** Restore the default of every group (image, mode, color) through the ↺ buttons. */
export async function resetAll(page) {
  for (const g of ['image', 'mode', 'color']) {
    const btn = page.locator(`#controls [data-group="${g}"] .group-reset`);
    if (await btn.count()) await btn.click();
  }
  await settle(page);
}

/**
 * Run `action` (a click or key press) and return the file chooser it opens.
 * The extra round trip makes sure Playwright has switched file-chooser interception on before the action runs:
 * without it, about one run in six races the browser and the event never arrives.
 */
export async function openChooser(page, action) {
  const chooser = page.waitForEvent('filechooser', { timeout: 10_000 });
  await page.evaluate(() => 0);
  await action();
  return chooser;
}

// ---------------------------------------------------------------------------
// Video helpers (Phase 2)
// ---------------------------------------------------------------------------

/** Open the fixture video and wait for the first rendered frame (it starts playing by itself, muted). */
export async function loadVideo(page, file = FIXTURE_WEBM) {
  await page.setInputFiles('#file-input', file);
  await page.waitForSelector('body[data-view="studio"]');
  await page.waitForFunction(() => document.getElementById('transport').dataset.kind === 'video');
  await page.waitForFunction(() => Number(document.getElementById('viewer-canvas').dataset.frame || 0) > 0);
}

/** Transport state as the DOM shows it. */
export async function transportState(page) {
  return page.evaluate(() => {
    const d = document.getElementById('transport').dataset;
    return { kind: d.kind, state: d.state, time: Number(d.time || 0), recording: d.recording };
  });
}

export async function pauseVideo(page) {
  if ((await transportState(page)).state !== 'paused') await page.click('#tp-play');
  await page.waitForFunction(() => document.getElementById('transport').dataset.state === 'paused');
  await settle(page);
}

/**
 * Inspect an exported file with Mediabunny inside the page (the same library, an independent read of the bytes).
 * Returns the duration, the tracks and their sizes.
 */
export async function inspectMedia(page, bytes) {
  return page.evaluate(async (b64) => {
    const mb = await import('/vendor/mediabunny/1.59.1/mediabunny.min.mjs');
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const input = new mb.Input({ source: new mb.BlobSource(new Blob([arr])), formats: mb.ALL_FORMATS });
    try {
      const video = await input.getPrimaryVideoTrack();
      const audio = await input.getPrimaryAudioTrack();
      return {
        format: (await input.getFormat()).name,
        duration: await input.computeDuration(),
        video: video ? { codec: await video.getCodec(), width: video.displayWidth, height: video.displayHeight } : null,
        audio: audio ? { codec: await audio.getCodec(), channels: audio.numberOfChannels, rate: audio.sampleRate } : null,
      };
    } finally {
      input.dispose();
    }
  }, Buffer.from(bytes).toString('base64'));
}

/** Click a download-triggering action and return { name, bytes }. */
export async function captureDownload(page, action, timeout = 60_000) {
  const dl = page.waitForEvent('download', { timeout });
  await action();
  const download = await dl;
  const { readFileSync } = await import('node:fs');
  const path = await download.path();
  return { name: download.suggestedFilename(), bytes: readFileSync(path) };
}
