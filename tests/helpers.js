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

/**
 * Wait for the viewer to present a frame whose `data-<attr>` equals `value`, then for the loop to go quiet.
 * `waitForRender(page, n)` only proves that *some* frame newer than `n` arrived: a pass that was already in flight
 * with the old parameters (for example the zoom-driven re-render ~160 ms after a size change) satisfies it, and
 * a worker-backed mode finishes the new parameters later. Polling the property under test is the honest condition.
 */
export async function waitForCanvasData(page, attr, value) {
  await page.waitForFunction(
    ([a, v]) => document.getElementById('viewer-canvas').dataset[a] === String(v),
    [attr, value],
  );
  await settle(page);
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
export async function setControl(page, id, value, group = null) {
  const row = page.locator(`#controls ${group ? `[data-group="${group}"] ` : ''}[data-param="${id}"]`);
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

// ---------------------------------------------------------------------------
// Mode probes (Phase 3): render a synthetic source with any mode inside the page and read back what matters
// ---------------------------------------------------------------------------

/**
 * Render `spec.mode` once (or at several times) on a synthetic picture and return serialisable results.
 * spec: { mode, width, height, rects: [[css colour, x, y, w, h]] (pixels when spec.abs, else fractions),
 *         params: { global, color, mode }, theme, time, times, outScale, fonts: [[fontId, chars]],
 *         outputs: ['txt','html','ansi','svg','json','ans'] (text outputs, 'ans' as a byte array),
 *         colors: true (distinct colours of the output), pixels: [[fx, fy]] sampled from the output, means: [[fx0, fy0, fx1, fy1]] mean luma of regions }
 */
export async function renderMode(page, spec) {
  return page.evaluate(async (s) => {
    const { createPipeline } = await import('/src/engine/pipeline.js');
    const { getMode } = await import('/src/modes/index.js');
    const { ensureFonts } = await import('/src/engine/glyphs.js');
    const { defaultsOf } = await import('/src/state.js');
    const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
    const { COLOR_PARAMS } = await import('/src/engine/color.js');
    for (const [font, chars] of s.fonts || []) await ensureFonts(font, chars);
    if (s.faces) for (const f of s.faces) await document.fonts.load(f.css, f.text || 'M');
    const width = s.width || 300;
    const height = s.height || 200;
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    for (const [colour, x, y, w, h] of s.rects || []) {
      g.fillStyle = colour;
      if (s.abs) g.fillRect(x, y, w, h);
      else g.fillRect(x * width, y * height, w * width, h * height);
    }
    const source = {
      id: 'probe', kind: s.kind || 'image', width, height, version: Math.random(), animated: false, frame: () => c, dispose() {},
    };
    const mode = getMode(s.mode);
    const pipe = createPipeline();
    const p = s.params || {};
    const params = {
      global: { ...defaultsOf(IMAGE_PARAMS), ...(p.global || {}) },
      color: { ...defaultsOf(COLOR_PARAMS), ...(p.color || {}) },
      depth: {}, postfx: {},
      mode: { ...defaultsOf(mode.params), ...(p.mode || {}) },
    };
    const theme = s.theme || { ink: '#c4f169', bg: '#15181e' };
    const times = s.times || [s.time ?? 0];
    const frames = [];
    let last = null;
    for (const time of times) {
      last = await pipe.render({
        source, mode, params, time, theme, outScale: s.outScale || 1, isExport: !!s.isExport, quality: 'full',
      });
      const out = document.createElement('canvas');
      out.width = last.width;
      out.height = last.height;
      const og = out.getContext('2d', { willReadFrequently: true });
      og.drawImage(last.canvas, 0, 0);
      const data = og.getImageData(0, 0, out.width, out.height).data;
      let h = 2166136261;
      for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619);
      const means = (s.means || []).map(([fx0, fy0, fx1, fy1]) => {
        const x0 = Math.floor(fx0 * out.width), x1 = Math.floor(fx1 * out.width), y0 = Math.floor(fy0 * out.height), y1 = Math.floor(fy1 * out.height);
        let sum = 0, cnt = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * out.width + x) * 4; sum += (0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]) / 255; cnt++; }
        return cnt ? sum / cnt : 0;
      });
      let colors = null;
      if (s.colors) { // distinct opaque colours as #rrggbb (capped), for "only these inks appear" checks
        const set = new Set();
        for (let i = 0; i < data.length && set.size < 300; i += 4) set.add(`${data[i + 3] === 255 ? '' : 'a'}#${((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]).toString(16).padStart(6, '0')}`);
        colors = Array.from(set).sort();
      }
      let cr = 0, cg = 0, cb = 0;
      for (let i = 0; i < data.length; i += 4) { cr += data[i]; cg += data[i + 1]; cb += data[i + 2]; }
      const px = data.length / 4;
      frames.push({ hash: (h >>> 0).toString(16), means, colors, channels: [cr / px / 255, cg / px / 255, cb / px / 255], pixels: (s.pixels || []).map(([fx, fy]) => {
        const x = Math.min(out.width - 1, Math.floor(fx * out.width));
        const y = Math.min(out.height - 1, Math.floor(fy * out.height));
        return Array.from(og.getImageData(x, y, 1, 1).data);
      }) });
    }
    const state = pipe.getState(mode.id);
    const outputs = {};
    for (const f of s.outputs || []) {
      if (f === 'ans') outputs.ans = Array.from(mode.toBinary(state, 'ans'));
      else if (f === 'svg') outputs.svg = mode.toSVG(state, {});
      else if (f === 'json') outputs.json = mode.toJSON(state);
      else outputs[f] = mode.toText(state, f, s.textOpts || {});
    }
    return {
      meta: JSON.parse(JSON.stringify(last.meta || {})), width: last.width, height: last.height, error: last.error ? String(last.error) : null,
      frames, outputs,
    };
  }, spec);
}
