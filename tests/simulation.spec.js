// Phase 6 (PLAN.md 7.25, 12): reaction-diffusion and cellular automata on WebGL2.
// Rule correctness against known Life patterns and a CPU reference, the strict B/S parser, Gray-Scott boundedness
// and image modulation, determinism on (seed, time) with RESET, the texture-format fallback with the extensions
// switched off, the studio controls, WebGL context loss and restore, video sources and deterministic video export.
import { test, expect } from '@playwright/test';
import {
  watchPage, gotoApp, loadFixture, loadVideo, renderCount, settle, canvasStats, setControl, getControl, renderMode,
  captureDownload, inspectMedia,
} from './helpers.js';

const MODE = 'reactiondiffusion';
const HALVES = [['#000000', 0, 0, 0.5, 1], ['#ffffff', 0.5, 0, 0.5, 1]]; // dark left half, light right half

async function pick(page, id = MODE) {
  const item = page.locator(`#mode-list .mode-item[data-mode-id="${id}"]`);
  if ((await item.getAttribute('aria-current')) === 'true') return;
  const before = await renderCount(page);
  await item.click();
  await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b, before);
}

const simTime = (page) => page.evaluate(() => Number(document.getElementById('viewer-canvas').dataset.simTime || 'NaN'));

// ---------------------------------------------------------------------------------------------------------------
test.describe('B/S rule parser', () => {
  test('accepts valid Life-like rules and normalises them', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const res = await page.evaluate(async () => {
      const { parseRule } = await import('/src/engine/sim.js');
      return ['B3/S23', 'b36/s23', 'B3678/S34678', 'B2/S', 'B/S2', '  B3/S23\t', 'B32/S32', 'B012345678/S012345678', 'B0/S8']
        .map((r) => [r, parseRule(r)]);
    });
    const byInput = Object.fromEntries(res);
    expect(byInput['B3/S23']).toEqual({ birth: [3], survive: [2, 3], bMask: 8, sMask: 12, text: 'B3/S23' });
    expect(byInput['b36/s23'].text).toBe('B36/S23');
    expect(byInput['b36/s23'].bMask).toBe((1 << 3) | (1 << 6));
    expect(byInput['B3678/S34678'].text).toBe('B3678/S34678');
    expect(byInput['B2/S']).toMatchObject({ birth: [2], survive: [], sMask: 0, text: 'B2/S' });
    expect(byInput['B/S2'].text).toBe('B/S2');
    expect(byInput['  B3/S23\t'].text).toBe('B3/S23');
    expect(byInput['B32/S32'].text).toBe('B23/S23'); // digits sorted
    expect(byInput['B012345678/S012345678'].bMask).toBe(511);
    expect(byInput['B0/S8']).toMatchObject({ bMask: 1, sMask: 256 });
  });

  test('rejects invalid and hostile input', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const bad = [
      '', ' ', 'B/S', 'B9/S23', 'B3/S29', 'B3/S23/', 'B3/S23 extra', 'S23/B3', '23/3', 'B3S23', 'B 3/S23', 'B3 /S23', 'B3/ S23',
      'B33/S23', 'B3/S223', 'B-3/S23', 'B3.5/S23', 'B３/S23', 'B3/S２3', 'B3/ß23', 'B3/S23\n', 'B3\u0000/S23',
      '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'B3/S23<b>', 'B3/S23&amp;', '${1}', 'B3/S23'.repeat(10),
      'B' + '3'.repeat(40) + '/S23', null, undefined, 42, {}, ['B3/S23'],
    ];
    const res = await page.evaluate(async (inputs) => {
      const { parseRule } = await import('/src/engine/sim.js');
      return inputs.map((r) => parseRule(r));
    }, bad);
    res.forEach((r, i) => expect(r, `rejects ${JSON.stringify(bad[i])}`).toBeNull());
  });
});

// ---------------------------------------------------------------------------------------------------------------
test.describe('cellular automaton on the GPU', () => {
  /** Run `gens` generations of `rule` from `cells` (w x h, 0/1) on a fresh WebGL2 context; returns every generation. */
  async function runCA(page, { w, h, cells, rule, gens, lock = 0, seed = 1, image = null }) {
    return page.evaluate(async ({ w, h, cells, rule, gens, lock, seed, image }) => {
      const sim = await import('/src/engine/sim.js');
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2');
      const ca = sim.createAutomaton(gl, w, h);
      const r = sim.parseRule(rule);
      if (image) ca.setImage(Uint8Array.from(image));
      ca.upload(Uint8Array.from(cells));
      const out = [Array.from(ca.read().alive)];
      for (let g = 0; g < gens; g++) {
        ca.step(1, g, { bMask: r.bMask, sMask: r.sMask, lock, seed, decay: 0.8 });
        out.push(Array.from(ca.read().alive));
      }
      ca.dispose();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return out;
    }, { w, h, cells, rule, gens, lock, seed, image });
  }
  const grid = (w, h, pts) => {
    const g = new Array(w * h).fill(0);
    for (const [x, y] of pts) g[y * w + x] = 1;
    return g;
  };
  const live = (g, w) => g.flatMap((v, i) => (v ? [[i % w, Math.floor(i / w)]] : []));

  test('a blinker oscillates with period 2 (B3/S23)', async ({ page }) => {
    const guard = watchPage(page);
    await page.goto('/tests/blank.html');
    const W = 9;
    const horizontal = [[3, 4], [4, 4], [5, 4]];
    const vertical = [[4, 3], [4, 4], [4, 5]];
    const gens = await runCA(page, { w: W, h: W, cells: grid(W, W, horizontal), rule: 'B3/S23', gens: 4 });
    expect(live(gens[0], W)).toEqual(horizontal);
    expect(live(gens[1], W).sort()).toEqual(vertical.sort());
    expect(live(gens[2], W)).toEqual(horizontal);
    expect(live(gens[3], W).sort()).toEqual(vertical.sort());
    expect(live(gens[4], W)).toEqual(horizontal);
    expect(guard.problems).toEqual([]);
  });

  test('a glider moves one cell diagonally in 4 generations', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const W = 16;
    // .#.
    // ..#
    // ###   travels towards +x, +y (down-right in the grid)
    const glider = [[5, 4], [6, 5], [4, 6], [5, 6], [6, 6]];
    const gens = await runCA(page, { w: W, h: W, cells: grid(W, W, glider), rule: 'B3/S23', gens: 8 });
    const key = (pts) => pts.map(([x, y]) => `${x},${y}`).sort();
    expect(key(live(gens[4], W))).toEqual(key(glider.map(([x, y]) => [x + 1, y + 1])));
    expect(key(live(gens[8], W))).toEqual(key(glider.map(([x, y]) => [x + 2, y + 2])));
    expect(key(live(gens[2], W))).not.toEqual(key(glider)); // it really changed shape in between
    for (const g of gens) expect(g.reduce((a, b) => a + b, 0)).toBe(5);
  });

  test('GPU generations equal the CPU reference for Life, HighLife, Day & Night and Seeds (dead borders)', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const res = await page.evaluate(async () => {
      const sim = await import('/src/engine/sim.js');
      const { rng } = await import('/src/engine/rand.js');
      const w = 40, h = 28;
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2');
      const out = {};
      for (const rule of ['B3/S23', 'B36/S23', 'B3678/S34678', 'B2/S']) {
        const r = sim.parseRule(rule);
        const rand = rng(1234);
        let cpu = new Uint8Array(w * h).map(() => (rand() < 0.4 ? 1 : 0));
        const ca = sim.createAutomaton(gl, w, h);
        ca.upload(cpu);
        let mismatches = 0;
        let changed = 0;
        for (let g = 0; g < 12; g++) {
          const next = sim.lifeStepCPU(cpu, w, h, r);
          ca.step(1, g, { bMask: r.bMask, sMask: r.sMask, lock: 0, seed: 0, decay: 0.5 });
          const gpu = ca.read().alive;
          for (let i = 0; i < w * h; i++) { if (gpu[i] !== next[i]) mismatches++; if (next[i] !== cpu[i]) changed++; }
          cpu = next;
        }
        ca.dispose();
        out[rule] = { mismatches, changed };
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return out;
    });
    for (const [rule, r] of Object.entries(res)) {
      expect(r.mismatches, `${rule}: GPU = CPU`).toBe(0);
      expect(r.changed, `${rule}: the soup evolves`).toBeGreaterThan(50);
    }
  });

  test('imageLock re-seeds cells from the picture (0 = pure rule, 1 = the picture every generation)', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const W = 24;
    const image = Array.from({ length: W * W }, (_, i) => ((i % W) < 12 ? 1 : 0)); // left half alive
    const empty = new Array(W * W).fill(0);
    const locked = await runCA(page, { w: W, h: W, cells: empty, rule: 'B3/S23', gens: 2, lock: 1, image });
    expect(locked[1]).toEqual(image);
    expect(locked[2]).toEqual(image);
    const none = await runCA(page, { w: W, h: W, cells: empty, rule: 'B3/S23', gens: 2, lock: 0, image });
    expect(none[2].reduce((a, b) => a + b, 0)).toBe(0);
    const some = await runCA(page, { w: W, h: W, cells: empty, rule: 'B3/S23', gens: 1, lock: 0.3, image, seed: 5 });
    const some2 = await runCA(page, { w: W, h: W, cells: empty, rule: 'B3/S23', gens: 1, lock: 0.3, image, seed: 5 });
    const count = some[1].reduce((a, b) => a + b, 0);
    expect(count).toBeGreaterThan(W * 12 * 0.15); // about 30 % of the picture's live cells
    expect(count).toBeLessThan(W * 12 * 0.45);
    expect(some2[1], 'deterministic for a seed').toEqual(some[1]);
    expect(some[1].every((v, i) => !v || image[i])).toBe(true); // only picture cells were seeded
  });
});

// ---------------------------------------------------------------------------------------------------------------
test.describe('Gray-Scott', () => {
  test('stays bounded with no NaN, for the presets and for extreme parameters', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const res = await page.evaluate(async () => {
      const sim = await import('/src/engine/sim.js');
      const { PATTERNS } = await import('/src/modes/reactiondiffusion.js');
      const w = 96, h = 64;
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2');
      const luma = Float32Array.from({ length: w * h }, (_, i) => (i % w) / (w - 1));
      const cases = {
        ...Object.fromEntries(Object.entries(PATTERNS).map(([k, v]) => [k, { ...v, Du: 1, Dv: 0.5, influence: 0.8 }])),
        extremeHigh: { fA: 0.1, fB: 0.1, kA: 0.03, kB: 0.03, Du: 1, Dv: 1, influence: 1 },
        extremeLow: { fA: 0.005, fB: 0.1, kA: 0.075, kB: 0.03, Du: 0.1, Dv: 0.05, influence: 1 },
      };
      const out = {};
      for (const [name, q] of Object.entries(cases)) {
        const rd = sim.createReactionDiffusion(gl, w, h);
        rd.setLuma(luma);
        rd.upload(sim.seedReactionDiffusion(w, h, 'random', 3));
        rd.step(3000, q);
        const uv = rd.read();
        let bad = 0, min = Infinity, max = -Infinity, sum = 0, sum2 = 0;
        for (let i = 0; i < uv.length; i++) {
          const v = uv[i];
          if (!Number.isFinite(v)) { bad++; continue; }
          if (v < min) min = v;
          if (v > max) max = v;
        }
        for (let i = 0; i < w * h; i++) { const v = uv[i * 2 + 1]; sum += v; sum2 += v * v; }
        const mean = sum / (w * h);
        out[name] = { bad, min, max, varV: sum2 / (w * h) - mean * mean, format: rd.format };
        rd.dispose();
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return out;
    });
    for (const [name, r] of Object.entries(res)) {
      expect(r.bad, `${name}: no NaN / Infinity`).toBe(0);
      expect(r.min, `${name}: >= 0`).toBeGreaterThanOrEqual(0);
      expect(r.max, `${name}: <= 1`).toBeLessThanOrEqual(1);
      expect(r.format).toBe('rg32f');
      if (!name.startsWith('extreme')) expect(r.varV, `${name}: a pattern formed`).toBeGreaterThan(1e-4);
    }
  });

  test('the picture modulates the pattern: dark and light halves differ statistically', async ({ page }) => {
    const guard = watchPage(page);
    await page.goto('/tests/blank.html');
    const res = await page.evaluate(async (rects) => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const { getMode } = await import('/src/modes/index.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const c = document.createElement('canvas');
      c.width = 320; c.height = 160;
      const g = c.getContext('2d');
      for (const [col, x, y, w, h] of rects) { g.fillStyle = col; g.fillRect(x * 320, y * 160, w * 320, h * 160); }
      const m = getMode('reactiondiffusion');
      const out = {};
      for (const pattern of ['coral', 'maze', 'spots']) {
        const { PATTERNS } = await import('/src/modes/reactiondiffusion.js');
        const pipe = createPipeline();
        const params = {
          global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {},
          mode: { ...defaultsOf(m.params), simScale: 0.25, seedType: 'random', pattern, ...PATTERNS[pattern] },
        };
        const r = await pipe.render({ source: { id: 's', kind: 'image', width: 320, height: 160, version: 1, animated: false, frame: () => c }, mode: m, params, time: 6, theme: { ink: '#c4f169', bg: '#15181e' }, quality: 'full', outScale: 1 });
        const st = pipe.getState('reactiondiffusion');
        const uv = st.sim.read();
        const W = st.sim.width, H = st.sim.height;
        const half = (x0, x1) => {
          let cov = 0, n = 0;
          for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) { cov += uv[(y * W + x) * 2 + 1] > 0.2 ? 1 : 0; n++; }
          return cov / n;
        };
        out[pattern] = { dark: half(4, Math.floor(W / 2) - 6), light: half(Math.floor(W / 2) + 6, W - 4), steps: r.meta.steps, error: r.error ? String(r.error) : null, W, H };
        pipe.dispose();
      }
      return out;
    }, HALVES);
    for (const [pattern, r] of Object.entries(res)) {
      expect(r.error).toBeNull();
      expect(r.steps).toBe(6 * 60 * 20);
      expect(r.light - r.dark, `${pattern}: the light half grows more pattern (${r.dark.toFixed(2)} vs ${r.light.toFixed(2)})`).toBeGreaterThan(0.15);
    }
    expect(guard.problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
test.describe('determinism and RESET', () => {
  const base = { mode: MODE, width: 300, height: 200, rects: [['#202020', 0, 0, 1, 1], ['#e0e0e0', 0.3, 0.2, 0.4, 0.6]], isExport: true };

  for (const sim of ['rd', 'ca']) {
    test(`${sim}: the same seed and time give the same picture, whatever was rendered before`, async ({ page }) => {
      const guard = watchPage(page);
      await page.goto('/tests/blank.html');
      const p = { mode: { sim, simScale: 0.25 } };
      const a = await renderMode(page, { ...base, params: p, times: [0.6, 1.5, 0.6, 2] });
      const b = await renderMode(page, { ...base, params: p, times: [1.5] });
      const c = await renderMode(page, { ...base, params: { mode: { ...p.mode, seed: 99 } }, times: [1.5] });
      const d = await renderMode(page, { ...base, params: p, isExport: false, times: [0.3, 1.5] }); // incremental vs direct
      expect(a.error).toBeNull();
      expect(a.frames[0].hash, 'going back re-simulates from the seed').toBe(a.frames[2].hash);
      expect(a.frames[1].hash, 'a later time differs').not.toBe(a.frames[0].hash);
      expect(a.frames[3].hash).not.toBe(a.frames[1].hash);
      expect(b.frames[0].hash, 'a fresh pipeline at the same time').toBe(a.frames[1].hash);
      expect(d.frames[1].hash, 'stepping 0.3 s then 1.5 s = 1.5 s at once').toBe(a.frames[1].hash);
      expect(c.frames[0].hash, 'another seed differs').not.toBe(b.frames[0].hash);
      const sps = sim === 'rd' ? 60 * 20 : 12; // steps per second: 20 per 1/60 s, or 12 generations per second
      expect(b.meta.steps).toBe(Math.floor(1.5 * sps));
      expect(b.meta.simTime).toBeCloseTo(Math.floor(1.5 * sps) / sps, 9);
      await guard.assertClean(expect);
    });
  }

  test('N(t) is capped and the live preview advances at most 60 steps per frame (PLAN.md 18.2)', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const res = await page.evaluate(async () => {
      const m = await import('/src/modes/reactiondiffusion.js');
      const rd = m.clockOf({ sim: 'rd', stepsPerFrame: 20 });
      const rdMax = m.clockOf({ sim: 'rd', stepsPerFrame: 999 });
      const ca = m.clockOf({ sim: 'ca', caRate: 12 });
      return {
        rd: [m.stepsAt(0, rd), m.stepsAt(1, rd), m.stepsAt(1e6, rd)],
        rdMax: rdMax.stepsPer,
        ca: [m.stepsAt(2.5, ca), m.stepsAt(1e9, ca)],
        caps: [m.MAX_RD_STEPS, m.MAX_CA_GENERATIONS],
      };
    });
    expect(res.rd).toEqual([0, 1200, res.caps[0]]);
    expect(res.rdMax).toBe(60);
    expect(res.ca).toEqual([30, res.caps[1]]);
    // live pipeline (the studio preview): a 10 s jump advances one budget (≤ 60 steps) and slides the clock
    const live = await page.evaluate(async () => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const { getMode } = await import('/src/modes/index.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const c = document.createElement('canvas');
      c.width = 200; c.height = 120;
      c.getContext('2d').fillRect(50, 30, 100, 60);
      const m = getMode('reactiondiffusion');
      const pipe = createPipeline({ onInvalidate: () => {} }); // progressive = the studio preview
      const params = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: { ...defaultsOf(m.params), simScale: 0.25 } };
      const source = { id: 's', kind: 'image', width: 200, height: 120, version: 1, animated: false, frame: () => c };
      const theme = { ink: '#c4f169', bg: '#15181e' };
      const steps = [];
      for (const t of [100, 110, 110.1, 130]) {
        const r = await pipe.render({ source, mode: m, params, time: t, theme, quality: 'full', outScale: 1 });
        steps.push(r.meta.steps);
      }
      // RESET: the next frame starts again from the seed
      m.onAction('restart', pipe.getState('reactiondiffusion'));
      for (const t of [131, 131.2]) {
        const r = await pipe.render({ source, mode: m, params, time: t, theme, quality: 'full', outScale: 1 });
        steps.push(r.meta.steps);
      }
      pipe.dispose();
      return steps;
    });
    expect(live[0]).toBe(0); // the preview clock starts at the first frame
    for (const i of [1, 2, 3]) {
      const d = live[i] - live[i - 1];
      expect(d, `frame ${i}: advances`).toBeGreaterThan(0);
      expect(d, `frame ${i}: at most 60 steps, not thousands`).toBeLessThanOrEqual(60);
    }
    expect(live[4]).toBe(0); // RESET
    expect(live[5]).toBeGreaterThan(0);
    expect(live[5]).toBeLessThanOrEqual(60);
  });

  test('the RESET button restarts the simulation in the studio; PNG export renders the simulated time on screen', async ({ page }) => {
    test.setTimeout(120_000);
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    await pick(page);
    await setControl(page, 'simScale', 0.25);
    await page.waitForFunction(() => Number(document.getElementById('viewer-canvas').dataset.simTime) > 1.2, null, { timeout: 60_000 });
    const label = await page.locator('#controls [data-action="restart"]').textContent();
    expect(label.trim()).toBe('Restart simulation');
    await page.click('#controls [data-action="restart"]');
    await page.waitForFunction(() => Number(document.getElementById('viewer-canvas').dataset.simTime) < 0.5, null, { timeout: 10_000 });
    expect(await simTime(page)).toBeGreaterThanOrEqual(0);

    // PNG export: a fresh export pipeline re-simulates exactly the time shown (not the page clock)
    await page.evaluate(async () => {
      const mode = (await import('/src/modes/reactiondiffusion.js')).default;
      window.__exportMeta = [];
      const render = mode.render;
      mode.render = async function (ctx, state) {
        const meta = await render.call(this, ctx, state);
        if (ctx.isExport) window.__exportMeta.push({ time: ctx.time, steps: meta.steps });
        return meta;
      };
    });
    await page.waitForFunction(() => Number(document.getElementById('viewer-canvas').dataset.simTime) > 0.5);
    const before = await simTime(page);
    const { name, bytes } = await captureDownload(page, () => page.click('[data-export="png"]'));
    const after = await simTime(page);
    expect(name).toMatch(/^dither-reactiondiffusion-\d{8}-\d{6}\.png$/);
    expect(bytes.length).toBeGreaterThan(1000);
    const meta = await page.evaluate(() => window.__exportMeta);
    expect(meta.length).toBeGreaterThanOrEqual(1);
    expect(meta[0].time).toBeGreaterThanOrEqual(before - 1e-3);
    expect(meta[0].time).toBeLessThanOrEqual(after + 1e-3);
    expect(meta[0].steps).toBe(Math.floor(meta[0].time * 1200 + 1e-6));
    expect(meta[0].time, 'not the page clock').toBeLessThan(30);
    await guard.assertClean(expect);
  });
});

// ---------------------------------------------------------------------------------------------------------------
test.describe('texture-format fallback', () => {
  test('with the float extensions switched off the simulation runs on half floats, then on packed RGBA8', async ({ page }) => {
    const guard = watchPage(page);
    await page.goto('/tests/blank.html');
    const res = await page.evaluate(async (rects) => {
      const sim = await import('/src/engine/sim.js');
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const { getMode } = await import('/src/modes/index.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const c = document.createElement('canvas');
      c.width = 320; c.height = 160;
      const g = c.getContext('2d');
      for (const [col, x, y, w, h] of rects) { g.fillStyle = col; g.fillRect(x * 320, y * 160, w * 320, h * 160); }
      const m = getMode('reactiondiffusion');
      const runs = {};
      const cases = { normal: [], half: ['EXT_color_buffer_float'], packed: ['EXT_color_buffer_float', 'EXT_color_buffer_half_float'] };
      for (const [name, off] of Object.entries(cases)) {
        sim.setDisabledExtensions(off);
        try {
          const pipe = createPipeline();
          const params = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: { ...defaultsOf(m.params), simScale: 0.25, seedType: 'random' } };
          const r = await pipe.render({ source: { id: 's', kind: 'image', width: 320, height: 160, version: 1, animated: false, frame: () => c }, mode: m, params, time: 5, theme: { ink: '#c4f169', bg: '#15181e' }, quality: 'full', outScale: 1 });
          const st = pipe.getState('reactiondiffusion');
          const uv = st.sim.read();
          const W = st.sim.width, H = st.sim.height;
          let bad = 0, lo = Infinity, hi = -Infinity;
          for (const v of uv) { if (!Number.isFinite(v)) bad++; else { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
          const half = (x0, x1) => { let s = 0, n = 0; for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) { s += uv[(y * W + x) * 2 + 1] > 0.2 ? 1 : 0; n++; } return s / n; };
          // the displayed picture is not blank
          const out = document.createElement('canvas');
          out.width = r.width; out.height = r.height;
          const og = out.getContext('2d');
          og.drawImage(r.canvas, 0, 0);
          const px = og.getImageData(0, 0, out.width, out.height).data;
          const colours = new Set();
          for (let i = 0; i < px.length && colours.size < 50; i += 4 * 97) colours.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
          runs[name] = { format: r.meta.format, error: r.error ? String(r.error) : null, bad, lo, hi, dark: half(2, W / 2 - 4), light: half(W / 2 + 4, W - 2), colours: colours.size };
          pipe.dispose();
        } finally {
          sim.setDisabledExtensions(null);
        }
      }
      // the 16-bit packing round-trips (1 / 65535 precision)
      sim.setDisabledExtensions(['EXT_color_buffer_float', 'EXT_color_buffer_half_float']);
      const cv = document.createElement('canvas');
      const gl = cv.getContext('webgl2');
      const fmt = sim.pickSimFormat(gl);
      const rd = sim.createReactionDiffusion(gl, 8, 4, fmt);
      const vals = Float32Array.from({ length: 64 }, (_, i) => i / 63);
      rd.upload(vals);
      const back = rd.read();
      let maxErr = 0;
      for (let i = 0; i < 64; i++) maxErr = Math.max(maxErr, Math.abs(back[i] - vals[i]));
      rd.dispose();
      sim.setDisabledExtensions(null);
      const fmtAfter = sim.pickSimFormat(gl).id;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return { runs, packedFmt: fmt.id, maxErr, fmtAfter };
    }, HALVES);
    expect(res.runs.normal.format).toBe('rg32f');
    expect(res.runs.half.format).toBe('rg16f');
    expect(res.runs.packed.format).toBe('rgba8');
    for (const [name, r] of Object.entries(res.runs)) {
      expect(r.error, name).toBeNull();
      expect(r.bad, `${name}: finite`).toBe(0);
      expect(r.lo).toBeGreaterThanOrEqual(0);
      expect(r.hi).toBeLessThanOrEqual(1);
      expect(r.colours, `${name}: the output is not blank`).toBeGreaterThan(2);
      expect(r.light - r.dark, `${name}: the picture still modulates the pattern`).toBeGreaterThan(0.1);
    }
    // packed fixed point is close to the float simulation (statistically, not bit for bit)
    expect(Math.abs(res.runs.packed.light - res.runs.normal.light)).toBeLessThan(0.2);
    expect(res.packedFmt).toBe('rgba8');
    expect(res.maxErr).toBeLessThanOrEqual(1 / 65535 + 1e-7);
    expect(res.fmtAfter).toBe('rg32f');
    expect(guard.problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
test.describe('studio', () => {
  test('the pattern select fills fA/fB/kA/kB, a hand edit switches it to Custom; CA rule validation and fallback', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    await pick(page);
    const patterns = await page.evaluate(async () => (await import('/src/modes/reactiondiffusion.js')).PATTERNS);
    for (const [id, v] of Object.entries(patterns)) {
      await setControl(page, 'pattern', id);
      for (const k of ['fA', 'fB', 'kA', 'kB']) expect(await getControl(page, k), `${id}.${k}`).toBeCloseTo(v[k], 6);
      expect(await getControl(page, 'pattern')).toBe(id);
    }
    // the slider shows all four decimals
    expect(await page.locator('#controls [data-param="fA"] .ctl-num').inputValue()).toBe(patterns.fingerprints.fA.toFixed(4));
    await setControl(page, 'fA', 0.0333);
    expect(await getControl(page, 'pattern')).toBe('custom');
    expect(await getControl(page, 'fA')).toBeCloseTo(0.0333, 6);
    // CA-only controls appear with the automaton
    await expect(page.locator('#controls [data-param="rule"]')).toBeHidden();
    await setControl(page, 'sim', 'ca');
    await expect(page.locator('#controls [data-param="rule"]')).toBeVisible();
    await expect(page.locator('#controls [data-param="fA"]')).toBeHidden();
    await expect(page.locator('#controls [data-param="customRule"]')).toBeHidden();
    await setControl(page, 'rule', 'custom');
    const input = page.locator('#controls [data-param="customRule"] input');
    await setControl(page, 'customRule', '<img src=x onerror=alert(1)>');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    const err = page.locator('#controls [data-param="customRule"] .ctl-error');
    await expect(err).toBeVisible();
    await expect(err).toContainText('Invalid rule');
    expect(await page.locator('#controls img').count()).toBe(0); // the text stays text
    await setControl(page, 'customRule', 'B36/S23');
    await expect(input).not.toHaveAttribute('aria-invalid', 'true');
    await expect(err).toBeHidden();
    const stats = await canvasStats(page);
    expect(stats.variance).toBeGreaterThan(0);
    await guard.assertClean(expect);
  });

  test('an invalid custom rule falls back to Life (and says so in the meta)', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const base = { mode: MODE, width: 200, height: 120, rects: [['#ffffff', 0.2, 0.2, 0.6, 0.6]], isExport: true, time: 1 };
    const bad = await renderMode(page, { ...base, params: { mode: { sim: 'ca', rule: 'custom', customRule: 'B9/S99' } } });
    const life = await renderMode(page, { ...base, params: { mode: { sim: 'ca', rule: 'life' } } });
    const high = await renderMode(page, { ...base, params: { mode: { sim: 'ca', rule: 'custom', customRule: 'b36/s23' } } });
    expect(bad.error).toBeNull();
    expect(bad.meta.rule).toBe('B3/S23');
    expect(bad.meta.ruleError).toBe(true);
    expect(bad.frames[0].hash).toBe(life.frames[0].hash);
    expect(high.meta.rule).toBe('B36/S23');
    expect(high.meta.ruleError).toBe(false);
  });

  test('every colour mode and the transparent background render', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const base = { mode: MODE, width: 240, height: 160, rects: HALVES, isExport: true, time: 2, params: {} };
    const seen = new Set();
    for (const sim of ['rd', 'ca']) {
      for (const colorMode of ['mono', 'gradient', 'palette', 'original']) {
        const r = await renderMode(page, { ...base, colors: true, params: { mode: { sim, simScale: 0.25 }, color: { colorMode, palette: 'gameboy' } } });
        expect(r.error, `${sim}/${colorMode}`).toBeNull();
        expect(r.frames[0].colors.length, `${sim}/${colorMode} colours`).toBeGreaterThan(1);
        seen.add(r.frames[0].hash);
        if (colorMode === 'palette') {
          // only Game Boy colours (and blends of them at cell edges) — the darkest and lightest are present
          expect(r.frames[0].colors).toEqual(expect.arrayContaining(sim === 'ca' ? ['#9bbc0f'] : ['#0f380f']));
        }
      }
      const tr = await renderMode(page, { ...base, colors: true, params: { mode: { sim, simScale: 0.25 }, color: { bgTransparent: true } } });
      expect(tr.meta.transparent).toBe(true);
      expect(tr.frames[0].colors.some((c) => c.startsWith('a'))).toBe(true); // some pixels are see-through
    }
    expect(seen.size).toBe(8);
  });

  test('WebGL context loss: reported, the last frame stays, then the simulation restarts and renders', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
        const c = orig.call(this, type, ...rest);
        if (type === 'webgl2' && c) (window.__gl2 = window.__gl2 || []).push(c);
        return c;
      };
    });
    await gotoApp(page);
    await loadFixture(page);
    await pick(page);
    await setControl(page, 'simScale', 0.25);
    await page.waitForFunction(() => Number(document.getElementById('viewer-canvas').dataset.simTime) > 0.8, null, { timeout: 60_000 });
    const lost = await page.evaluate(async () => {
      const liveCtx = (window.__gl2 || []).filter((g) => !g.isContextLost());
      const exts = liveCtx.map((g) => g.getExtension('WEBGL_lose_context'));
      window.__lose = liveCtx.map((g, i) => [g, exts[i]]);
      await Promise.all(liveCtx.map((g, i) => new Promise((res) => { g.canvas.addEventListener('webglcontextlost', res, { once: true }); exts[i].loseContext(); })));
      return exts.length;
    });
    expect(lost).toBeGreaterThanOrEqual(1);
    await expect(page.locator('.toast', { hasText: 'graphics context was lost' })).toBeVisible();
    const frozen = await renderCount(page);
    await page.waitForTimeout(400);
    expect(await renderCount(page), 'nothing is presented while the context is lost').toBe(frozen);
    await expect(page.locator('#chip-error')).toBeHidden();
    const shown = await canvasStats(page);
    expect(shown.variance, 'the last frame stays on screen').toBeGreaterThan(0);

    await page.evaluate(async () => {
      await Promise.all(window.__lose.map(([g, ext]) => new Promise((res) => {
        g.canvas.addEventListener('webglcontextrestored', res, { once: true });
        ext.restoreContext();
      })));
    });
    await expect(page.locator('.toast', { hasText: 'Graphics restored.' })).toBeVisible();
    // the state was rebuilt: the simulation starts again from its seed and keeps running
    await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b, frozen);
    await page.waitForFunction(() => Number(document.getElementById('viewer-canvas').dataset.simTime) > 0.3, null, { timeout: 30_000 });
    const after = await canvasStats(page);
    expect(after.variance).toBeGreaterThan(0);
    expect(after.colors).toBeGreaterThan(1);
    await expect(page.locator('#chip-error')).toBeHidden();
    // the CA sub-mode also works on the restored context
    await setControl(page, 'sim', 'ca');
    await page.waitForFunction(() => Number(document.getElementById('viewer-canvas').dataset.simTime) > 0.3, null, { timeout: 30_000 });
    expect((await canvasStats(page)).variance).toBeGreaterThan(0);
    await guard.assertClean(expect);
  });

  test('a video source modulates the simulation continuously (no restart on new frames)', async ({ page }) => {
    test.setTimeout(120_000);
    const guard = watchPage(page);
    await gotoApp(page);
    await loadVideo(page);
    await pick(page);
    await setControl(page, 'simScale', 0.25);
    // sample the video clock and the simulated time: within one pass of the 3 s video (it loops, which restarts the
    // simulation) new frames keep arriving while the simulated time only grows
    const samples = [];
    for (let i = 0; i < 12; i++) {
      // both values describe the same rendered frame: its source (video) time and its simulated time
      samples.push(await page.evaluate(() => { const d = document.getElementById('viewer-canvas').dataset; return [Number(d.srcTime || 0), Number(d.simTime)]; }));
      await page.waitForTimeout(150);
    }
    let run = 0;
    let best = 0;
    for (let i = 1; i < samples.length; i++) {
      const forward = samples[i][0] > samples[i - 1][0]; // no loop in between
      if (forward) {
        expect(samples[i][1], 'no restart while the video plays forward').toBeGreaterThanOrEqual(samples[i - 1][1]);
        run += samples[i][1] > samples[i - 1][1] ? 1 : 0;
      } else run = 0;
      best = Math.max(best, run);
    }
    expect(best, 'the simulation advanced over several video frames').toBeGreaterThanOrEqual(3);
    const stats = await canvasStats(page);
    expect(stats.variance).toBeGreaterThan(0);
    await expect(page.locator('#chip-error')).toBeHidden();
    await expect(page.locator('#controls [data-export="video"]')).toHaveCount(1);
    await guard.assertClean(expect);
  });

  test('the simulation follows the current video frame (f/k modulation by the frame, not the first picture)', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const res = await page.evaluate(async () => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const { getMode } = await import('/src/modes/index.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const c = document.createElement('canvas');
      c.width = 240; c.height = 120;
      const g = c.getContext('2d');
      const source = { id: 'v', kind: 'video', width: 240, height: 120, version: 1, animated: false, frameId: 0, frame: () => c, dispose() {} };
      const m = getMode('reactiondiffusion');
      const params = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: { ...defaultsOf(m.params), simScale: 0.25, seedType: 'random' } };
      const run = async (lightLeftAfter) => {
        const pipe = createPipeline();
        let units = [];
        for (let i = 0; i <= 50; i++) {
          // first 0.5 s: light right half; then the "video" changes to a light left half (or not)
          const flip = lightLeftAfter && i > 10;
          g.fillStyle = '#000'; g.fillRect(0, 0, 240, 120);
          g.fillStyle = '#fff'; g.fillRect(flip ? 0 : 120, 0, 120, 120);
          source.frameId++;
          const r = await pipe.render({ source, mode: m, params, time: i * 0.1, theme: { ink: '#c4f169', bg: '#15181e' }, quality: 'full', outScale: 1, isExport: true });
          units.push(r.meta.steps);
        }
        const st = pipe.getState('reactiondiffusion');
        const uv = st.sim.read();
        const W = st.sim.width, H = st.sim.height;
        const half = (x0, x1) => { let s = 0, n = 0; for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) { s += uv[(y * W + x) * 2 + 1] > 0.2 ? 1 : 0; n++; } return s / n; };
        pipe.dispose();
        return { left: half(2, W / 2 - 4), right: half(W / 2 + 4, W - 2), monotonic: units.every((u, i) => i === 0 || u >= units[i - 1]), last: units[units.length - 1] };
      };
      return { still: await run(false), moved: await run(true) };
    });
    expect(res.still.monotonic).toBe(true);
    expect(res.moved.monotonic, 'new frames never restart the simulation').toBe(true);
    expect(res.still.last).toBe(6000);
    expect(res.still.right - res.still.left).toBeGreaterThan(0.1);
    expect(res.moved.left - res.moved.right, 'the pattern followed the light half to the left').toBeGreaterThan(0.1);
  });

  test('a still picture exports to WebM with frames that depend only on the frame time', async ({ page }) => {
    test.setTimeout(240_000);
    const guard = watchPage(page);
    await gotoApp(page);
    await page.evaluate(async () => {
      const mode = (await import('/src/modes/reactiondiffusion.js')).default;
      window.__frames = [];
      const render = mode.render;
      mode.render = async function (ctx, state) {
        const meta = await render.call(this, ctx, state);
        if (ctx.isExport) {
          const gl = ctx.gl;
          const w = ctx.out.canvas.width, h = ctx.out.canvas.height;
          const d = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
          let hh = 2166136261;
          for (let i = 0; i < d.length; i += 7) hh = Math.imul(hh ^ d[i], 16777619);
          window.__frames.push({ t: ctx.time, h: hh >>> 0, steps: meta.steps });
        }
        return meta;
      };
    });
    await loadFixture(page);
    await pick(page);
    await setControl(page, 'simScale', 0.25);
    await expect(page.locator('#controls [data-export="video"]')).toHaveCount(1);
    const exportOnce = async () => {
      await page.evaluate(() => { window.__frames = []; });
      await page.locator('#controls [data-export="video"]').click();
      await page.waitForSelector('#export-dialog[open]');
      await page.waitForFunction(() => document.getElementById('vx-go') && !document.getElementById('vx-go').disabled);
      await page.selectOption('#vx-format', 'webm');
      await page.selectOption('#vx-height', '480');
      await page.selectOption('#vx-fps', '24');
      await page.locator('#vx-duration').fill('1');
      const file = await captureDownload(page, () => page.click('#vx-go'), 200_000);
      const info = await inspectMedia(page, file.bytes);
      expect(info.format).toBe('WebM');
      expect(info.duration).toBeGreaterThan(0.8);
      expect(info.duration).toBeLessThan(1.4);
      return page.evaluate(() => window.__frames.slice(-24));
    };
    const a = await exportOnce();
    const b = await exportOnce();
    expect(a.length).toBe(24);
    a.forEach((f, i) => {
      expect(f.t).toBeCloseTo(i / 24, 5);
      expect(f.steps).toBe(Math.floor((i / 24) * 1200 + 1e-6)); // simulated from the seed at t = 0
    });
    expect(b.map((f) => f.h)).toEqual(a.map((f) => f.h));
    expect(new Set(a.map((f) => f.h)).size, 'the simulation moves').toBeGreaterThan(12);
    await guard.assertClean(expect);
  });
});
