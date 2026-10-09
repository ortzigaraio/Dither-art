// Depth (PLAN.md 5.5): brightness-as-depth, per-frame caching, and the optional AI path. The sandbox has no CDN, so
// the AI path is tested with a mock worker (tests/mocks/depth.mock.worker.js, same protocol) and the REAL worker is
// loaded with a mock of the transformers.js library (tests/mocks/transformers.mock.js, the 4.x result shapes).
import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, loadFixture, renderCount, settle } from './helpers.js';

const MOCK = '/tests/mocks/depth.mock.worker.js';

/** In-page helper: render a probe mode that reads ctx.depth() twice on a black | white picture. */
async function depthProbe(page, opts) {
  return page.evaluate(async (o) => {
    const { createPipeline } = await import('/src/engine/pipeline.js');
    const { defaultsOf } = await import('/src/state.js');
    const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
    const { COLOR_PARAMS } = await import('/src/engine/color.js');
    const { depthStats } = await import('/src/engine/depth.js');
    const c = document.createElement('canvas');
    c.width = 16; c.height = 8;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 16, 8);
    g.fillStyle = '#fff'; g.fillRect(8, 0, 8, 8);
    const kind = o.kind || 'image';
    const source = { id: 'd', kind, width: 16, height: 8, version: o.version ?? 7, animated: false, frameId: kind === 'video' ? 0 : undefined, frame: () => c, dispose() {} };
    const mode = {
      id: 'dprobe', params: [], uses: ['image', 'depth'], resolution: () => ({ width: 16, height: 8 }),
      async render(ctx) {
        const a = await ctx.depth();
        const b = await ctx.depth();
        ctx.out.canvas.width = 2; ctx.out.canvas.height = 2;
        return { same: a === b, row: Array.from(a.slice(0, 16)).map((v) => Math.round(v * 100) / 100), source: a.source, ref: a };
      },
    };
    let invalidated = 0;
    const pipe = createPipeline({ onInvalidate: () => { invalidated++; } });
    const params = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: o.depth || {}, postfx: {}, mode: {} };
    const out = [];
    const b0 = depthStats();
    let prevRef = null;
    for (let i = 0; i < (o.frames || 1); i++) {
      if (kind === 'video') source.frameId = i;
      const r = await pipe.render({ source, mode, params, theme: { ink: '#fff', bg: '#000' }, isExport: !!o.isExport, time: i / 30 });
      out.push({ same: r.meta.same, row: r.meta.row, source: r.meta.source, reused: r.meta.ref === prevRef });
      prevRef = r.meta.ref;
      if (o.waitMs) await new Promise((res) => setTimeout(res, o.waitMs));
    }
    const b1 = depthStats();
    pipe.dispose();
    return { frames: out, builds: b1.brightnessBuilds - b0.brightnessBuilds, aiRuns: b1.aiRuns - b0.aiRuns, invalidated };
  }, opts);
}

test.describe('depth: brightness', () => {
  test('luma as depth, invert, smoothing, cached per frame and setting', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const plain = await depthProbe(page, { frames: 3 });
    expect(plain.frames[0].row).toEqual([...Array(8).fill(0), ...Array(8).fill(1)]);
    expect(plain.frames[0].source).toBe('brightness');
    expect(plain.frames[0].same).toBe(true); // two calls in one render: one field
    expect(plain.frames[1].reused && plain.frames[2].reused).toBe(true); // same frame re-rendered: still cached
    expect(plain.builds).toBe(1);
    const inv = await depthProbe(page, { depth: { invert: true } });
    expect(inv.frames[0].row).toEqual([...Array(8).fill(1), ...Array(8).fill(0)]);
    const soft = await depthProbe(page, { depth: { smooth: 2 } });
    const row = soft.frames[0].row;
    expect(row[7]).toBeGreaterThan(0.2);
    expect(row[8]).toBeLessThan(0.8);
    expect(row[0]).toBe(0);
    expect(row[15]).toBe(1);
    // AI requested but not loaded: brightness, nothing downloaded
    const ai = await depthProbe(page, { depth: { source: 'ai' } });
    expect(ai.frames[0].source).toBe('brightness');
    expect(ai.aiRuns).toBe(0);
    await guard.assertClean(expect);
  });
});

test.describe('depth: AI', () => {
  test('mock worker: progress, ready, AI field in exports, preview refresh, video every N frames, failure', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const load = await page.evaluate(async (url) => {
      const d = await import('/src/engine/depth.js');
      d.configureDepthAI({ workerUrl: url });
      const seen = [];
      const info = await d.loadDepthAI({ onProgress: (p) => seen.push(p) });
      return { seen, info, status: d.depthAIStatus() };
    }, MOCK);
    expect(load.status).toBe('ready');
    expect(load.info.device).toBe('mock');
    expect(load.seen.length).toBeGreaterThanOrEqual(3);
    expect(load.seen).toEqual([...load.seen].sort((a, b) => a - b));
    expect(load.seen.at(-1)).toBe(1);

    // export: waits for the model; the mock's left-to-right ramp is normalised to 0..1
    const exp = await depthProbe(page, { depth: { source: 'ai' }, isExport: true });
    expect(exp.frames[0].source).toBe('ai');
    expect(exp.frames[0].row[0]).toBe(0);
    expect(exp.frames[0].row[15]).toBe(1);
    expect(exp.frames[0].row[7]).toBeCloseTo(7 / 15, 1);
    // still preview: brightness first, then the pipeline asks for a re-render and the cached AI field is used
    const prev = await depthProbe(page, { depth: { source: 'ai' }, frames: 1 });
    expect(prev.frames[0].source).toBe('ai'); // cached by the export above (same picture, frame and size)
    await page.evaluate(async () => (await import('/src/engine/depth.js')).resetDepthAI()); // forget cached fields

    // video: the model runs at most every N frames in preview, on every frame in exports
    await page.evaluate(async (url) => {
      const d = await import('/src/engine/depth.js');
      d.configureDepthAI({ workerUrl: url });
      await d.loadDepthAI();
    }, MOCK);
    const still = await depthProbe(page, { depth: { source: 'ai' }, frames: 2, waitMs: 150 });
    expect(still.frames[0].source).toBe('brightness');
    expect(still.invalidated).toBeGreaterThanOrEqual(1);
    expect(still.frames[1].source).toBe('ai');
    const video = await depthProbe(page, { kind: 'video', depth: { source: 'ai', everyN: 6 }, frames: 12, waitMs: 40 });
    expect(video.aiRuns).toBeGreaterThanOrEqual(2);
    expect(video.aiRuns).toBeLessThanOrEqual(3);
    expect(video.frames.at(-1).source).toBe('ai');
    const videoExport = await depthProbe(page, { kind: 'video', depth: { source: 'ai', everyN: 6 }, frames: 4, isExport: true, version: 8 });
    expect(videoExport.aiRuns).toBe(4);

    // failure to load
    const failed = await page.evaluate(async (url) => {
      const d = await import('/src/engine/depth.js');
      d.configureDepthAI({ workerUrl: `${url}?fail=load` });
      try { await d.loadDepthAI(); return 'loaded'; } catch (err) { return `${d.depthAIStatus()}: ${err.message}`; }
    }, MOCK);
    expect(failed).toMatch(/^failed: mock: network unreachable/);
    await guard.assertClean(expect);
  });

  test('the real worker parses, loads a same-origin library override and normalises predicted_depth', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const r = await page.evaluate(async () => {
      const d = await import('/src/engine/depth.js');
      d.configureDepthAI({ workerUrl: null, libUrl: '/tests/mocks/transformers.mock.js' });
      const seen = [];
      const info = await d.loadDepthAI({ onProgress: (p) => seen.push(p) });
      const w = 6, h = 5;
      const rgba = new Uint8ClampedArray(w * h * 4).fill(128);
      const res = await d.estimateDepthAI(rgba, w, h);
      // a cross-origin library is refused by the worker itself, before any request
      const worker = new Worker('/src/workers/depth.worker.js', { type: 'module' });
      const refused = await new Promise((resolve) => {
        worker.onmessage = (e) => resolve(e.data);
        worker.postMessage({ type: 'load', libUrl: 'https://cdn.example.invalid/x.js' });
      });
      worker.terminate();
      d.configureDepthAI({ libUrl: null });
      return { info, seen, w: res.width, h: res.height, col: Array.from({ length: h }, (_, y) => Math.round(res.depth[y * w] * 100) / 100), refused };
    });
    expect(['wasm', 'webgpu']).toContain(r.info.device);
    expect(r.seen).toEqual(expect.arrayContaining([0.4, 1]));
    expect([r.w, r.h]).toEqual([6, 5]);
    expect(r.col).toEqual([0, 0.25, 0.5, 0.75, 1]); // raw 2..5 top to bottom -> 0..1
    expect(r.refused).toEqual({ type: 'error', message: 'library URL must be same-origin' });
    await guard.assertClean(expect);
  });
});

test.describe('depth: studio UI', () => {
  async function openHiddenwire(page) {
    await gotoApp(page);
    await loadFixture(page);
    const before = await renderCount(page);
    await page.click('#mode-list .mode-item[data-mode-id="hiddenwire"]');
    await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b, before);
    await settle(page);
  }

  test('enhance with AI: confirmation with size, cancel, download with progress, success', async ({ page }) => {
    const guard = watchPage(page);
    await openHiddenwire(page);
    await page.evaluate(async (url) => (await import('/src/engine/depth.js')).configureDepthAI({ workerUrl: `${url}?delay=250` }), MOCK);
    await expect(page.locator('[data-group="depth"]')).toBeVisible();
    await expect(page.locator('#viewer-canvas')).toHaveAttribute('data-depth', 'brightness');
    const button = page.locator('[data-group="depth"] [data-action="depthAI"]');
    await expect(button).toContainText('27–50 MB');

    await button.click();
    const dlg = page.locator('#depth-dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('27–50 MB');
    await expect(dlg).toContainText('never leaves your device');
    await dlg.locator('[data-depth-dialog="cancel"]').click();
    await expect(dlg).toHaveCount(0);
    await expect(page.locator('[data-group="depth"] [data-param="source"] select')).toHaveValue('brightness');
    expect(await page.evaluate(() => localStorage.getItem('horain.depthAI'))).toBeNull();

    await button.click();
    await page.locator('#depth-dialog [data-depth-dialog="download"]').click();
    await expect(page.locator('#viewer-busy')).toBeVisible();
    await expect(page.locator('#busy-text')).toHaveText(/downloading depth model… (25|50|75) %/);
    await expect(page.locator('.toast', { hasText: 'AI depth is ready.' })).toBeVisible();
    await expect(page.locator('#viewer-busy')).toBeHidden();
    await expect(page.locator('[data-group="depth"] [data-param="source"] select')).toHaveValue('ai');
    await expect(page.locator('#viewer-canvas')).toHaveAttribute('data-depth', 'ai', { timeout: 20_000 });
    expect(await page.evaluate(() => localStorage.getItem('horain.depthAI'))).toBe('1');
    // the enhance button hides while the AI source is on, everyN shows
    await expect(button).toBeHidden();
    await expect(page.locator('[data-group="depth"] [data-param="everyN"]')).toBeVisible();
    await guard.assertClean(expect);
  });

  test('a failed download shows a toast and falls back to brightness (consent already given: no dialog)', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => localStorage.setItem('horain.depthAI', '1'));
    await openHiddenwire(page);
    await page.evaluate(async (url) => (await import('/src/engine/depth.js')).configureDepthAI({ workerUrl: `${url}?fail=load` }), MOCK);
    await page.locator('[data-group="depth"] [data-param="source"] select').selectOption('ai');
    await expect(page.locator('.toast-error', { hasText: 'Using brightness as depth' })).toBeVisible();
    await expect(page.locator('#depth-dialog')).toHaveCount(0);
    await expect(page.locator('[data-group="depth"] [data-param="source"] select')).toHaveValue('brightness');
    await settle(page);
    await expect(page.locator('#viewer-canvas')).toHaveAttribute('data-depth', 'brightness');
    await expect(page.locator('#chip-error')).toBeHidden();
    await guard.assertClean(expect);
  });
});
