import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, renderMode } from './helpers.js';

// Dithering 1-bit (PLAN.md 7.7)

/** Sixteen vertical grey bands, dark to light: a ramp that exercises every threshold. */
const RAMP = Array.from({ length: 16 }, (_, i) => {
  const v = Math.round((i / 15) * 255);
  return [`rgb(${v},${v},${v})`, i / 16, 0, 1 / 16, 1];
});

test.describe('dither1bit: threshold maps', () => {
  test('Bayer matrices are the known ones and thresholds are (M + 0.5) / n^2', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { bayerMatrix, thresholdFn } = await import('/src/engine/dither.js');
      const t4 = thresholdFn('bayer4');
      return {
        b2: Array.from(bayerMatrix(2).data),
        b4: Array.from(bayerMatrix(4).data),
        b8row0: Array.from(bayerMatrix(8).data).slice(0, 8),
        b8row1: Array.from(bayerMatrix(8).data).slice(8, 16),
        t4: [t4(0, 0), t4(1, 0), t4(2, 1), t4(3, 3), t4(4, 4), t4(5, 3)],
      };
    });
    expect(res.b2).toEqual([0, 2, 3, 1]);
    expect(res.b4).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
    expect(res.b8row0).toEqual([0, 32, 8, 40, 2, 34, 10, 42]);
    expect(res.b8row1).toEqual([48, 16, 56, 24, 50, 18, 58, 26]);
    // (x, y) -> M[y % 4][x % 4]: (0,0)=0, (1,0)=8, (2,1)=14, (3,3)=5, (4,4)=0 (wraps), (5,3)=M[3][1]=7
    const want = [0, 8, 14, 5, 0, 7].map((m) => (m + 0.5) / 16);
    res.t4.forEach((v, i) => expect(v).toBeCloseTo(want[i], 10));
  });

  test('a flat mid grey with Bayer 4x4 switches exactly half of the pixels on', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const r = await renderMode(page, {
      mode: 'dither1bit', width: 64, height: 64, rects: [['#808080', 0, 0, 1, 1]], colors: true, means: [[0, 0, 1, 1]],
      params: { mode: { algorithm: 'bayer4', pixelSize: 1, tone: 'mac' } },
    });
    expect(r.error).toBeNull();
    expect(r.width).toBe(64);
    expect(r.frames[0].colors).toEqual(['#000000', '#ffffff']);
    expect(r.frames[0].means[0]).toBeCloseTo(0.5, 6); // 8 of every 16 pixels are white
    await guard.assertClean(expect);
  });
});

test.describe('dither1bit: output', () => {
  test('every algorithm produces only the two ink colours on a ramp', async ({ page }) => {
    await gotoApp(page);
    const algos = await page.evaluate(async () => (await import('/src/engine/dither.js')).DITHER_OPTIONS.map((o) => o.value));
    expect(algos.length).toBe(15);
    for (const algorithm of algos) {
      const r = await renderMode(page, {
        mode: 'dither1bit', width: 160, height: 40, rects: RAMP, colors: true,
        params: { mode: { algorithm, pixelSize: 1, tone: 'amber' } },
      });
      expect(r.error, algorithm).toBeNull();
      expect(r.frames[0].colors, algorithm).toEqual(['#000000', '#ffb000']);
    }
  });

  test('the ink and paper presets use their documented colours', async ({ page }) => {
    await gotoApp(page);
    const want = {
      mac: ['#000000', '#ffffff'], gameboy: ['#0f380f', '#9bbc0f'], obradinn: ['#333319', '#e5ffff'],
      amber: ['#000000', '#ffb000'], phosphor: ['#000000', '#39ff6a'],
    };
    for (const [tone, colors] of Object.entries(want)) {
      const r = await renderMode(page, { mode: 'dither1bit', width: 160, height: 40, rects: RAMP, colors: true, params: { mode: { tone, pixelSize: 1 } } });
      expect(r.frames[0].colors, tone).toEqual(colors);
    }
    const custom = await renderMode(page, {
      mode: 'dither1bit', width: 160, height: 40, rects: RAMP, colors: true,
      params: { mode: { tone: 'custom', darkColor: '#102030', lightColor: '#ff8800', pixelSize: 1 } },
    });
    expect(custom.frames[0].colors).toEqual(['#102030', '#ff8800']);
  });

  test('N levels give N evenly spaced tones between the inks', async ({ page }) => {
    await gotoApp(page);
    const r = await renderMode(page, {
      mode: 'dither1bit', width: 160, height: 40, rects: RAMP, colors: true,
      params: { mode: { algorithm: 'bayer4', levels: 4, pixelSize: 1, tone: 'mac' } },
    });
    // evenly spaced between black and white: 0, 85, 170, 255
    expect(r.frames[0].colors).toEqual(['#000000', '#555555', '#aaaaaa', '#ffffff']);
  });

  test('bias lightens (positive) or darkens (negative) the result', async ({ page }) => {
    await gotoApp(page);
    const mean = async (bias) => (await renderMode(page, {
      mode: 'dither1bit', width: 64, height: 64, rects: [['#808080', 0, 0, 1, 1]], means: [[0, 0, 1, 1]],
      params: { mode: { algorithm: 'bayer4', pixelSize: 1, bias } },
    })).frames[0].means[0];
    const [dark, mid, light] = [await mean(-0.25), await mean(0), await mean(0.25)];
    expect(dark).toBeLessThan(mid);
    expect(light).toBeGreaterThan(mid);
    expect(dark).toBeCloseTo(0.25, 6); // 4 of 16 thresholds lie below 0.5 - 0.25
    expect(light).toBeCloseTo(0.75, 6);
  });

  test('pixel size = block size; the output keeps the picture size and scales with nearest neighbour', async ({ page }) => {
    await gotoApp(page);
    const base = { mode: 'dither1bit', width: 200, height: 100, rects: [['#808080', 0, 0, 1, 1]], colors: true, params: { mode: { algorithm: 'bayer4', pixelSize: 4 } } };
    const a = await renderMode(page, { ...base, outScale: 1 });
    expect([a.width, a.height]).toEqual([200, 100]); // 50 x 25 dither pixels of 4 px
    expect(a.meta.cols).toBe(50);
    const b = await renderMode(page, { ...base, outScale: 2 });
    expect([b.width, b.height]).toEqual([400, 200]);
    expect(b.frames[0].colors).toEqual(['#000000', '#ffffff']); // no smoothing between blocks
    // every 4x4 block is one colour: sample the 4 corners of block (1,1)
    const px = await renderMode(page, { ...base, pixels: [[4.2 / 200, 4.2 / 100], [7.8 / 200, 4.2 / 100], [4.2 / 200, 7.8 / 100], [7.8 / 200, 7.8 / 100]] });
    const set = new Set(px.frames[0].pixels.map((c) => c.join(',')));
    expect(set.size).toBe(1);
  });

  test('per channel RGB dithering keeps pure primaries and mixes the others', async ({ page }) => {
    await gotoApp(page);
    const r = await renderMode(page, {
      mode: 'dither1bit', width: 64, height: 64, rects: [['#ff0000', 0, 0, 0.5, 1], ['#00ffff', 0.5, 0, 0.5, 1]], colors: true,
      params: { mode: { algorithm: 'bayer4', pixelSize: 1, perChannel: true, tone: 'mac' } },
    });
    expect(r.frames[0].colors).toEqual(['#00ffff', '#ff0000']);
    const grey = await renderMode(page, {
      mode: 'dither1bit', width: 64, height: 64, rects: [['rgb(200,100,40)', 0, 0, 1, 1]], colors: true,
      params: { mode: { algorithm: 'bayer4', pixelSize: 1, perChannel: true } },
    });
    expect(grey.frames[0].colors.length).toBeGreaterThan(2);
    expect(grey.frames[0].colors.length).toBeLessThanOrEqual(8);
  });

  test('error diffusion on the worker gives the same pixels as on the main thread', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const { getMode } = await import('/src/modes/index.js');
      const heavy = await import('/src/engine/heavy.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const c = document.createElement('canvas');
      c.width = 640; c.height = 400;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 640, 400);
      grad.addColorStop(0, '#000'); grad.addColorStop(0.5, '#f80'); grad.addColorStop(1, '#fff');
      g.fillStyle = grad; g.fillRect(0, 0, 640, 400);
      const source = { id: 'p', kind: 'image', width: 640, height: 400, version: 1, animated: false, frame: () => c, dispose() {} };
      const mode = getMode('dither1bit');
      let started = 0; // 'start' messages that really reach a worker
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (m, ...rest) { if (m?.type === 'start' && m.task === 'quantize') started++; return post.call(this, m, ...rest); };
      const run = async (forceMain, algorithm) => {
        heavy.setForceMain(forceMain);
        const pipe = createPipeline();
        const before = started;
        const params = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: { ...defaultsOf(mode.params), algorithm, pixelSize: 1 } };
        const r = await pipe.render({ source, mode, params, theme: { ink: '#fff', bg: '#000' }, quality: 'full' });
        heavy.setForceMain(false);
        const d = r.canvas.getContext('2d').getImageData(0, 0, r.canvas.width, r.canvas.height).data;
        let h = 2166136261;
        for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
        return { hash: h >>> 0, jobs: started - before, error: r.error ? String(r.error) : null };
      };
      const out = {};
      for (const a of ['floyd-steinberg', 'atkinson', 'jjn']) out[a] = [await run(false, a), await run(true, a)];
      return { out, hasWorker: heavy.stats().hasWorker };
    });
    for (const a of ['floyd-steinberg', 'atkinson', 'jjn']) {
      const [w, m] = res.out[a];
      expect(w.error).toBeNull();
      expect(w.hash, a).toBe(m.hash);
    }
    expect(res.hasWorker).toBe(true);
    // the worker run sends one quantize job; the forced main-thread run sends none
    for (const a of ['floyd-steinberg', 'atkinson', 'jjn']) {
      expect(res.out[a][0].jobs, `${a} via worker`).toBe(1);
      expect(res.out[a][1].jobs, `${a} on the main thread`).toBe(0);
    }
  });
});
