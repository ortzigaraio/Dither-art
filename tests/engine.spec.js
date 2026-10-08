// Module-level tests of the engine, run inside the real browser (canvas APIs are needed).
import { test, expect } from '@playwright/test';
import { watchPage, gotoApp } from './helpers.js';

test.describe('engine', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  // ---------------------------------------------------------------------------------------------
  test('preprocess: ctx.filter fast path and the JS fallback agree with CSS filter semantics', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const pre = await import('/src/engine/preprocess.js');
      const base = {
        brightness: 100, contrast: 100, saturation: 100, hue: 0, grayscale: 0, sepia: 0, invert: 0,
        thresholdOn: false, threshold: 128, sharpness: 0, edges: 0, flipX: false,
        cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0,
      };
      // Test card: smooth colour ramps + saturated patches (exercises every matrix)
      const src = document.createElement('canvas');
      src.width = 96;
      src.height = 96;
      const sg = src.getContext('2d');
      const grad = sg.createLinearGradient(0, 0, 96, 0);
      ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff'].forEach((c, i, a) => grad.addColorStop(i / (a.length - 1), c));
      sg.fillStyle = grad;
      sg.fillRect(0, 0, 96, 48);
      const g2 = sg.createLinearGradient(0, 0, 96, 0);
      g2.addColorStop(0, '#000');
      g2.addColorStop(1, '#fff');
      sg.fillStyle = g2;
      sg.fillRect(0, 48, 96, 24);
      sg.fillStyle = '#7a4b2d';
      sg.fillRect(0, 72, 48, 24);
      sg.fillStyle = '#3c8dbc';
      sg.fillRect(48, 72, 48, 24);

      const run = (g, forceJS) => {
        const c = document.createElement('canvas');
        c.width = 96;
        c.height = 96;
        const ws = { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }), scratch: [] };
        const r = pre.preprocess(ws, src, 96, 96, g, { matte: '#000000', forceJS });
        return { data: ws.ctx.getImageData(0, 0, 96, 96).data, path: r.usedFilterPath };
      };
      const cases = {
        brightness: { brightness: 140 },
        'brightness<1': { brightness: 55 },
        contrast: { contrast: 180 },
        'contrast<1': { contrast: 40 },
        saturation: { saturation: 250 },
        'saturation<1': { saturation: 30 },
        hue: { hue: 120 },
        hue2: { hue: 275 },
        grayscale: { grayscale: 70 },
        sepia: { sepia: 80 },
        invert: { invert: 100 },
        invert40: { invert: 40 },
        combined: { brightness: 120, contrast: 130, saturation: 150, hue: 40, grayscale: 20, sepia: 30, invert: 25 },
      };
      const out = {};
      for (const [name, over] of Object.entries(cases)) {
        const g = { ...base, ...over };
        const a = run(g, false);
        const b = run(g, true);
        let max = 0;
        let sum = 0;
        for (let i = 0; i < a.data.length; i += 4) {
          for (let k = 0; k < 3; k++) {
            const d = Math.abs(a.data[i + k] - b.data[i + k]);
            if (d > max) max = d;
            sum += d;
          }
        }
        out[name] = { max, mean: sum / (96 * 96 * 3), pathA: a.path, pathB: b.path };
      }
      return { out, support: pre.supportsCtxFilter() };
    });
    expect(res.support).toBe(true);
    for (const [name, r] of Object.entries(res.out)) {
      expect(r.pathA, `${name}: fast path used`).toBe('ctx');
      expect(r.pathB, `${name}: fallback used`).toBe('js');
      expect(r.max, `${name}: max channel difference`).toBeLessThanOrEqual(3);
      expect(r.mean, `${name}: mean channel difference`).toBeLessThan(0.8);
    }
  });

  test('preprocess: unsharp, edges, threshold, crop and mirror behave', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const pre = await import('/src/engine/preprocess.js');
      const an = await import('/src/engine/analysis.js');
      const g0 = {
        brightness: 100, contrast: 100, saturation: 100, hue: 0, grayscale: 0, sepia: 0, invert: 0,
        thresholdOn: false, threshold: 128, sharpness: 0, edges: 0, flipX: false,
        cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0,
      };
      // Left half black, right half white, with a soft ramp in the middle
      const src = document.createElement('canvas');
      src.width = 64;
      src.height = 32;
      const sg = src.getContext('2d');
      const grad = sg.createLinearGradient(20, 0, 44, 0);
      grad.addColorStop(0, '#000');
      grad.addColorStop(1, '#fff');
      sg.fillStyle = grad;
      sg.fillRect(0, 0, 64, 32);
      const make = (w, h) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }), scratch: [] };
      };
      const lumaOf = (ws) => {
        const { data } = ws.ctx.getImageData(0, 0, ws.canvas.width, ws.canvas.height);
        return an.lumaFromRGBA(data, ws.canvas.width, ws.canvas.height);
      };
      const out = {};

      // threshold: only pure black / white remain
      let ws = make(64, 32);
      pre.preprocess(ws, src, 64, 32, { ...g0, thresholdOn: true, threshold: 128 }, { matte: '#000' });
      let l = lumaOf(ws);
      out.thresholdBinary = Array.from(l).every((v) => v === 0 || v === 1);
      out.thresholdMid = [l[16 * 64 + 10], l[16 * 64 + 54]];
      ws = make(64, 32);
      pre.preprocess(ws, src, 64, 32, { ...g0, thresholdOn: true, threshold: 250 }, { matte: '#000' });
      l = lumaOf(ws);
      out.thresholdHigh = l[16 * 64 + 54]; // pure white stays white; 250 cuts nearly everything else

      // sharpness widens the tonal range around a thin bar (overshoot on both sides)
      const bar = make(64, 32);
      bar.ctx.fillStyle = '#606060';
      bar.ctx.fillRect(0, 0, 64, 32);
      bar.ctx.fillStyle = '#a0a0a0';
      bar.ctx.fillRect(30, 0, 4, 32);
      const plain = make(64, 32);
      pre.preprocess(plain, bar.canvas, 64, 32, g0, { matte: '#000' });
      const sharp = make(64, 32);
      pre.preprocess(sharp, bar.canvas, 64, 32, { ...g0, sharpness: 8 }, { matte: '#000' });
      const lp = lumaOf(plain);
      const ls = lumaOf(sharp);
      out.sharpMax = [Math.max(...lp), Math.max(...ls)];
      out.sharpMin = [Math.min(...lp), Math.min(...ls)];
      out.sharpFlatUntouched = Math.abs(ls[16 * 64 + 5] - lp[16 * 64 + 5]) < 0.005;

      // edges: pushes toward white ('light') or black ('dark') where the Sobel magnitude is high
      const flat = make(64, 32);
      const fg = flat.ctx;
      fg.fillStyle = '#808080';
      fg.fillRect(0, 0, 64, 32);
      fg.fillStyle = '#fff';
      fg.fillRect(32, 0, 32, 32);
      const srcEdge = flat.canvas;
      const eLight = make(64, 32);
      pre.preprocess(eLight, srcEdge, 64, 32, { ...g0, edges: 6 }, { matte: '#000', edgeBlend: 'light' });
      const eDark = make(64, 32);
      pre.preprocess(eDark, srcEdge, 64, 32, { ...g0, edges: 6 }, { matte: '#000', edgeBlend: 'dark' });
      const base = make(64, 32);
      pre.preprocess(base, srcEdge, 64, 32, g0, { matte: '#000' });
      const lb = lumaOf(base);
      const ll = lumaOf(eLight);
      const ld = lumaOf(eDark);
      out.edgeLight = ll[16 * 64 + 31] > lb[16 * 64 + 31] + 0.1;
      out.edgeDark = ld[16 * 64 + 31] < lb[16 * 64 + 31] - 0.1;
      out.edgeFlatUntouched = Math.abs(ll[16 * 64 + 5] - lb[16 * 64 + 5]) < 0.01;

      // crop: removing the left 50% leaves the white half
      ws = make(32, 32);
      pre.preprocess(ws, src, 64, 32, { ...g0, cropLeft: 50 }, { matte: '#000' });
      l = lumaOf(ws);
      out.cropMean = l.reduce((a, b) => a + b, 0) / l.length;

      // mirror: black half moves to the right
      ws = make(64, 32);
      pre.preprocess(ws, src, 64, 32, { ...g0, flipX: true }, { matte: '#000' });
      l = lumaOf(ws);
      out.flipLeft = l[16 * 64 + 5];
      out.flipRight = l[16 * 64 + 58];

      out.cropRect = pre.cropRect({ ...g0, cropLeft: 10, cropRight: 20, cropTop: 5, cropBottom: 5 }, 200, 100);
      out.cropRectDegenerate = pre.cropRect({ ...g0, cropLeft: 90, cropRight: 90 }, 200, 100).sw;
      return out;
    });
    expect(res.thresholdBinary).toBe(true);
    expect(res.thresholdMid).toEqual([0, 1]);
    expect(res.thresholdHigh).toBe(1);
    expect(res.sharpMax[1]).toBeGreaterThan(res.sharpMax[0] + 0.02);
    expect(res.sharpMin[1]).toBeLessThan(res.sharpMin[0] - 0.02);
    expect(res.sharpFlatUntouched).toBe(true);
    expect(res.edgeLight).toBe(true);
    expect(res.edgeDark).toBe(true);
    expect(res.edgeFlatUntouched).toBe(true);
    expect(res.cropMean).toBeGreaterThan(0.85);
    expect(res.flipLeft).toBeGreaterThan(0.95);
    expect(res.flipRight).toBeLessThan(0.05);
    expect(res.cropRect).toEqual({ sx: 20, sy: 5, sw: 140, sh: 90 });
    expect(res.cropRectDegenerate).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------------------------
  test('dither: every algorithm returns valid levels and keeps the average tone', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const d = await import('/src/engine/dither.js');
      const w = 64;
      const h = 64;
      const ramp = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ramp[y * w + x] = x / (w - 1);
      const flat = new Float32Array(w * h).fill(0.3);
      const algos = d.DITHER_OPTIONS.map((o) => o.value);
      const out = {};
      for (const a of algos) {
        const res = {};
        for (const [name, buf] of [['ramp', ramp], ['flat', flat]]) {
          for (const levels of [2, 5]) {
            const q = d.quantize(buf, w, h, levels, a, { serpentine: a !== 'none', seed: 3 });
            let valid = true;
            let sum = 0;
            for (let i = 0; i < q.length; i++) {
              if (q[i] < 0 || q[i] >= levels) valid = false;
              sum += q[i] / (levels - 1);
            }
            let inSum = 0;
            for (let i = 0; i < buf.length; i++) inSum += buf[i];
            res[`${name}${levels}`] = { valid, meanErr: Math.abs(sum - inSum) / buf.length };
          }
        }
        out[a] = res;
      }
      // determinism
      const a1 = d.quantize(flat, w, h, 2, 'random', { seed: 9 });
      const a2 = d.quantize(flat, w, h, 2, 'random', { seed: 9 });
      out.randomDeterministic = a1.every((v, i) => v === a2[i]);
      out.algos = algos;
      return out;
    });
    expect(res.algos).toHaveLength(15);
    expect(res.randomDeterministic).toBe(true);
    for (const a of res.algos) {
      for (const [k, r] of Object.entries(res[a])) {
        expect(r.valid, `${a} ${k} valid`).toBe(true);
        if (a !== 'none') {
          // dithering must preserve the mean tone. Atkinson drops 2/8 of the error and an n x n Bayer matrix
          // only has n*n + 1 tones, so both get the slack their definition implies.
          const bayer = /^bayer(\d+)$/.exec(a);
          const tol = a === 'atkinson' ? 0.08 : a === 'random' ? 0.05 : bayer ? 0.5 / (Number(bayer[1]) ** 2) + 0.01 : 0.03;
          expect(r.meanErr, `${a} ${k} mean tone`).toBeLessThan(tol);
        }
      }
    }
  });

  test('dither: Bayer matrices are permutations and blue noise is a balanced permutation', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const d = await import('/src/engine/dither.js');
      const out = {};
      for (const n of [2, 4, 8, 16]) {
        const { data, size } = d.bayerMatrix(n);
        const seen = new Set(data);
        out[`bayer${n}`] = { size, perm: seen.size === n * n && Math.max(...data) === n * n - 1 && Math.min(...data) === 0 };
      }
      out.m2 = Array.from(d.bayerMatrix(2).data);
      out.m4 = Array.from(d.bayerMatrix(4).data);
      const t0 = performance.now();
      const bn = d.blueNoise();
      out.blueMs = performance.now() - t0;
      const sorted = Array.from(bn.data).sort((a, b) => a - b);
      out.blueSize = bn.size;
      out.bluePerm = sorted.every((v, i) => Math.abs(v - (i + 0.5) / sorted.length) < 1e-6);
      // Blue noise has less low-frequency energy than white noise: compare the variance of 8x8 block means
      const blockVar = (get) => {
        const means = [];
        for (let by = 0; by < 64; by += 8) {
          for (let bx = 0; bx < 64; bx += 8) {
            let s = 0;
            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += get((by + y) * 64 + bx + x);
            means.push(s / 64);
          }
        }
        const m = means.reduce((a, b) => a + b, 0) / means.length;
        return means.reduce((a, b) => a + (b - m) ** 2, 0) / means.length;
      };
      out.blueBlockVar = blockVar((i) => bn.data[i]);
      let seed = 12345;
      const white = Array.from({ length: 4096 }, () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; });
      out.whiteBlockVar = blockVar((i) => white[i]);
      // cached: second call is free and identical
      out.blueSame = d.blueNoise() === bn;
      return out;
    });
    for (const n of [2, 4, 8, 16]) expect(res[`bayer${n}`].perm).toBe(true);
    expect(res.m2).toEqual([0, 2, 3, 1]);
    expect(res.m4).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
    expect(res.blueSize).toBe(64);
    expect(res.bluePerm).toBe(true);
    expect(res.blueBlockVar).toBeLessThan(res.whiteBlockVar / 3);
    expect(res.blueSame).toBe(true);
    expect(res.blueMs).toBeLessThan(1500);
  });

  test('dither: error diffusion kernels match PLAN.md 5.3 (weights, divisors, Atkinson spreads 6/8)', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const d = await import('/src/engine/dither.js');
      const out = {};
      for (const id of d.ERROR_DIFFUSION_IDS) {
        const k = d.getKernel(id);
        out[id] = { sum: k.taps.reduce((a, t) => a + t[2], 0), div: k.div, taps: k.taps.length, forwardOnly: k.taps.every((t) => t[1] > 0 || (t[1] === 0 && t[0] > 0)) };
      }
      out.fs = d.getKernel('floyd-steinberg').taps;
      // Uniform mid-grey must come out half on, half off with every kernel
      const probe = (algo) => {
        const buf = new Float32Array(9 * 5).fill(0.5);
        return Array.from(d.quantize(buf, 9, 5, 2, algo)).reduce((a, b) => a + b, 0) / 45;
      };
      out.flat = Object.fromEntries(d.ERROR_DIFFUSION_IDS.map((id) => [id, probe(id)]));
      return out;
    });
    const expected = {
      'floyd-steinberg': { sum: 16, div: 16, taps: 4 },
      jjn: { sum: 48, div: 48, taps: 12 },
      stucki: { sum: 42, div: 42, taps: 12 },
      atkinson: { sum: 6, div: 8, taps: 6 },
      burkes: { sum: 32, div: 32, taps: 7 },
      sierra: { sum: 32, div: 32, taps: 10 },
      sierra2: { sum: 16, div: 16, taps: 7 },
      'sierra-lite': { sum: 4, div: 4, taps: 3 },
    };
    for (const [id, e] of Object.entries(expected)) {
      expect(res[id], id).toMatchObject(e);
      expect(res[id].forwardOnly, `${id}: only pixels not yet visited`).toBe(true);
      expect(res.flat[id], `${id}: flat grey`).toBeGreaterThan(0.3);
      expect(res.flat[id], `${id}: flat grey`).toBeLessThan(0.7);
    }
    expect(res.fs).toEqual([[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]]);
  });

  test('dither: palette quantisation picks only palette colours', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const d = await import('/src/engine/dither.js');
      const w = 32;
      const h = 32;
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = (i % w) * 8;
        rgba[i * 4 + 1] = Math.floor(i / w) * 8;
        rgba[i * 4 + 2] = 128;
        rgba[i * 4 + 3] = 255;
      }
      const palette = [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 0, 255]];
      const out = {};
      for (const a of ['none', 'floyd-steinberg', 'bayer4', 'blue-noise']) {
        const q = d.quantizePalette(rgba, w, h, palette, a, { serpentine: true });
        out[a] = { ok: q.every((v) => v < palette.length), distinct: new Set(q).size };
      }
      return out;
    });
    for (const [a, r] of Object.entries(res)) {
      expect(r.ok, a).toBe(true);
      expect(r.distinct, a).toBeGreaterThan(1);
    }
  });

  // ---------------------------------------------------------------------------------------------
  test('glyphs: density measurement orders characters by ink and auto-sort fixes unsorted sets', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const gl = await import('/src/engine/glyphs.js');
      await gl.ensureFonts('geist-mono', ' .:-=+*#%@█░▒▓←↑→↓∑∏√');
      const chars = Array.from(' .:-=+*#%@');
      const dens = gl.measureDensities(chars, 'geist-mono');
      const blocks = gl.measureDensities(Array.from(' ░▒▓█'), 'geist-mono');
      const sortedMath = gl.buildGradient({ gradient: 'math', custom: '', autoSort: true, invert: false, spaceDensity: 1, fontId: 'geist-mono' });
      const unsortedMath = gl.buildGradient({ gradient: 'math', custom: '', autoSort: false, invert: false, spaceDensity: 1, fontId: 'geist-mono' });
      const arrows = gl.buildGradient({ gradient: 'arrows', custom: '', autoSort: true, invert: false, spaceDensity: 1, fontId: 'geist-mono' });
      const sp = gl.buildGradient({ gradient: 'standard', custom: '', autoSort: true, invert: false, spaceDensity: 5, fontId: 'geist-mono' });
      const inv = gl.buildGradient({ gradient: 'standard', custom: '', autoSort: true, invert: true, spaceDensity: 1, fontId: 'geist-mono' });
      const custom = gl.buildGradient({ gradient: 'custom', custom: '#.', autoSort: true, invert: false, spaceDensity: 1, fontId: 'geist-mono' });
      const nonDecreasing = (a) => a.every((v, i) => i === 0 || v >= a[i - 1] - 1e-6);
      return {
        dens: Array.from(dens),
        blocks: Array.from(blocks),
        sortedDens: nonDecreasing(Array.from(sortedMath.dens)),
        unsortedDens: nonDecreasing(Array.from(unsortedMath.dens)),
        arrowsDens: nonDecreasing(Array.from(arrows.dens)),
        spaceRepeat: sp.chars.slice(0, 6).join('|'),
        invFirst: inv.chars[0],
        invLast: inv.chars[inv.chars.length - 1],
        customChars: custom.chars,
        standardLen: gl.buildGradient({ gradient: 'standard', custom: '', autoSort: false, invert: false, spaceDensity: 1, fontId: 'geist-mono' }).chars.length,
      };
    });
    expect(res.dens[0]).toBe(0); // space
    expect(res.dens[9]).toBeGreaterThan(res.dens[1]); // '@' denser than '.'
    expect(res.dens[7]).toBeGreaterThan(res.dens[1]); // '#' denser than '.'
    expect(res.blocks[0]).toBe(0);
    expect(res.blocks[4]).toBeCloseTo(1, 1); // █ is a full cell
    expect(res.blocks[1]).toBeLessThan(res.blocks[2]);
    expect(res.blocks[2]).toBeLessThan(res.blocks[3]);
    expect(res.blocks[3]).toBeLessThan(res.blocks[4]);
    expect(res.sortedDens).toBe(true);
    expect(res.arrowsDens).toBe(true);
    expect(res.unsortedDens).toBe(false); // the math set is not ordered by itself: that is why autoSort exists
    expect(res.spaceRepeat.split('|').slice(0, 5).every((c) => c === ' ')).toBe(true);
    expect(res.spaceRepeat.split('|')[5]).not.toBe(' ');
    expect(res.invFirst).toBe('@');
    expect(res.invLast).toBe(' ');
    expect(res.customChars).toEqual([' ', '.', '#']);
    expect(res.standardLen).toBe(10);
  });

  test('color: gradient LUT, palette matching and conversions', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const c = await import('/src/engine/color.js');
      const lut = c.buildGradientLUT([[0, 0, 0], [255, 255, 255]]);
      const lut3 = c.buildGradientLUT([[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
      const match = c.makePaletteMatcher([[0, 0, 0], [255, 255, 255], [255, 0, 0]], 'lab');
      const matchRgb = c.makePaletteMatcher([[0, 0, 0], [255, 255, 255], [255, 0, 0]], 'rgb');
      const [h, s, l] = c.rgbToHsl(255, 0, 0);
      return {
        lutStart: Array.from(lut.slice(0, 3)),
        lutEnd: Array.from(lut.slice(-3)),
        lutMid: lut[128 * 3],
        lut3Mid: Array.from(lut3.slice(128 * 3, 128 * 3 + 3)),
        matches: [match(10, 10, 10), match(240, 240, 240), match(230, 30, 30), matchRgb(10, 10, 10), matchRgb(250, 20, 20)],
        hex: [c.hexToRgb('#C4F169'), c.hexToRgb('abc'), c.hexToRgb('#12345'), c.hexToRgb(null), c.normalizeHex('#ABC'), c.rgbToHex(196, 241, 105)],
        hsl: [h, s, l],
        back: c.hslToRgb(0, 1, 0.5).map(Math.round),
        lab: c.rgbToLab(255, 255, 255).map((v) => Math.round(v)),
        custom: c.parseHexList('#112233 #abc, ff00aa nope').length,
        palette: c.getPaletteRGB('horain').length,
        paletteC64: c.getPaletteRGB('c64').length,
        paletteEndesga: c.getPaletteRGB('endesga32').length,
        boost: c.boostSaturation(200, 100, 100, 0).map(Math.round),
        resolved: (() => {
          const r = c.resolveColors({ colorMode: 'gradient', ink: null, bg: null, gradStops: null, palette: 'horain', customPalette: '', colorBoost: 100, bgTransparent: false }, { ink: '#C4F169', bg: '#15181E' });
          return { mode: r.mode, ink: r.ink, bg: r.bg, stops: r.stops.length, dark: c.isDarkBackground(r) };
        })(),
      };
    });
    expect(res.lutStart).toEqual([0, 0, 0]);
    expect(res.lutEnd).toEqual([255, 255, 255]);
    expect(Math.abs(res.lutMid - 128)).toBeLessThanOrEqual(1);
    expect(res.lut3Mid[1]).toBeGreaterThan(240); // the middle of a 3-stop gradient is the middle stop (green)
    expect(res.matches).toEqual([0, 1, 2, 0, 2]);
    expect(res.hex[0]).toEqual([196, 241, 105]);
    expect(res.hex[1]).toEqual([170, 187, 204]);
    expect(res.hex[2]).toBeNull();
    expect(res.hex[3]).toBeNull();
    expect(res.hex[4]).toBe('#aabbcc');
    expect(res.hex[5]).toBe('#c4f169');
    expect(res.hsl).toEqual([0, 1, 0.5]);
    expect(res.back).toEqual([255, 0, 0]);
    expect(res.lab[0]).toBe(100);
    expect(res.custom).toBe(3);
    expect(res.palette).toBe(5);
    expect(res.paletteC64).toBe(16);
    expect(res.paletteEndesga).toBe(32);
    expect(res.boost[0]).toBe(res.boost[1]); // saturation 0 = grey
    expect(res.resolved).toEqual({ mode: 'gradient', ink: [196, 241, 105], bg: [21, 24, 30], stops: 2, dark: true });
  });

  // ---------------------------------------------------------------------------------------------
  test('validate: type comes from magic bytes, never from the extension', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const v = await import('/src/io/validate.js');
      const bytes = (...parts) => {
        const out = [];
        for (const p of parts) {
          if (typeof p === 'string') for (const ch of p) out.push(ch.charCodeAt(0));
          else out.push(...p);
        }
        while (out.length < 64) out.push(0);
        return new Uint8Array(out);
      };
      const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
      const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
      const png = (w, h) => bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], be32(13), 'IHDR', be32(w), be32(h));
      const sniff = (b) => {
        const r = v.sniffBytes(b);
        return r.kind === 'unknown' ? `unknown:${r.hint}` : `${r.kind}:${r.format}`;
      };
      const cases = {
        png: sniff(png(10, 10)),
        jpeg: sniff(bytes([0xff, 0xd8, 0xff, 0xe0])),
        gif89: sniff(bytes('GIF89a')),
        gif87: sniff(bytes('GIF87a')),
        webp: sniff(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')),
        bmp: sniff(bytes('BM', [0, 0, 0, 0], [0, 0, 0, 0], [0x36, 0, 0, 0], le32(40))),
        bmpFake: sniff(bytes('BM is the start of many words, not a bitmap')),
        avif: sniff(bytes(be32(24), 'ftypavif', [0, 0, 0, 0], 'avifmif1')),
        heic: sniff(bytes(be32(24), 'ftypheic', [0, 0, 0, 0], 'heicmif1')),
        mp4: sniff(bytes(be32(24), 'ftypisom', [0, 0, 2, 0], 'isomiso2')),
        mp4b: sniff(bytes(be32(24), 'ftypmp42', [0, 0, 0, 0], 'mp42isom')),
        mov: sniff(bytes(be32(20), 'ftypqt  ', [0, 0, 0, 0], 'qt  ')),
        movOld: sniff(bytes(be32(8), 'moov')),
        m4a: sniff(bytes(be32(24), 'ftypM4A ', [0, 0, 0, 0], 'M4A isom')),
        webm: sniff(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84], 'webm')),
        mkv: sniff(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x88], 'matroska')),
        svg: sniff(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
        svgXml: sniff(bytes('  \n<?xml version="1.0"?><svg/>')),
        pdf: sniff(bytes('%PDF-1.7')),
        text: sniff(bytes('hello, this is a plain text file')),
        empty: sniff(new Uint8Array(0)),
      };

      // Sizes read from headers
      const sizes = {
        png: v.readImageSize(png(1234, 567), 'png'),
        gif: v.readImageSize(bytes('GIF89a', [0x34, 0x12, 0x78, 0x56]), 'gif'),
        bmp: v.readImageSize(bytes('BM', [0, 0, 0, 0], [0, 0, 0, 0], [0x36, 0, 0, 0], le32(40), le32(300), le32(-200 >>> 0)), 'bmp'),
        webpX: v.readImageSize(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8X', [10, 0, 0, 0], [0, 0, 0, 0], [0x0f, 0x01, 0], [0xc7, 0x00, 0]), 'webp'),
      };

      // validateFile: extension lies, real bytes win
      const asFile = (b, name, type = 'image/png') => new File([b], name, { type });
      const jpegAsPng = await v.validateFile(asFile(bytes([0xff, 0xd8, 0xff, 0xe0]), 'photo.png'));
      const errors = {};
      const attempt = async (key, file) => {
        try { await v.validateFile(file); errors[key] = 'accepted'; } catch (e) { errors[key] = e.code || String(e); }
      };
      await attempt('textAsPng', asFile(new TextEncoder().encode('just some text, not an image at all'), 'evil.png'));
      await attempt('svgAsPng', asFile(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'), 'logo.png'));
      await attempt('empty', asFile(new Uint8Array(0), 'empty.png'));
      await attempt('huge', asFile(png(20000, 20000), 'huge.png'));
      await attempt('exact100mp', asFile(png(10000, 10000), 'ok.png'));
      const big = new Uint8Array(51 * 1024 * 1024);
      big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      await attempt('overBytes', asFile(big, 'big.png'));
      await attempt('notAFile', { size: 3 });
      const video = await v.validateFile(asFile(bytes(be32(24), 'ftypisom', [0, 0, 2, 0], 'isomiso2'), 'clip.mp4', 'video/mp4'));
      return { cases, sizes, jpegAsPng: { kind: jpegAsPng.kind, format: jpegAsPng.format }, errors, video: { kind: video.kind, format: video.format } };
    });
    expect(res.cases).toEqual({
      png: 'image:png', jpeg: 'image:jpeg', gif89: 'image:gif', gif87: 'image:gif', webp: 'image:webp', bmp: 'image:bmp',
      bmpFake: 'unknown:other', avif: 'image:avif', heic: 'unknown:heic', mp4: 'video:mp4', mp4b: 'video:mp4', mov: 'video:mov',
      movOld: 'video:mov', m4a: 'unknown:audio', webm: 'video:webm', mkv: 'unknown:matroska', svg: 'unknown:svg', svgXml: 'unknown:svg',
      pdf: 'unknown:pdf', text: 'unknown:other', empty: 'unknown:short',
    });
    expect(res.sizes.png).toEqual({ width: 1234, height: 567 });
    expect(res.sizes.gif).toEqual({ width: 0x1234, height: 0x5678 });
    expect(res.sizes.bmp).toEqual({ width: 300, height: 200 });
    expect(res.sizes.webpX).toEqual({ width: 0x10f + 1, height: 0xc7 + 1 });
    expect(res.jpegAsPng).toEqual({ kind: 'image', format: 'jpeg' });
    expect(res.errors).toEqual({
      textAsPng: 'unsupported', svgAsPng: 'unsupported', empty: 'empty', huge: 'tooManyPixels', exact100mp: 'accepted',
      overBytes: 'tooLarge', notAFile: 'unsupported',
    });
    expect(res.video).toEqual({ kind: 'video', format: 'mp4' });
  });

  test('sources: DemoSource is deterministic and animated demos change over time', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const { DemoSource } = await import('/src/io/sources.js');
      const hash = (canvas) => {
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        let h = 0;
        for (let i = 0; i < data.length; i += 7) h = (h * 31 + data[i]) >>> 0;
        return h;
      };
      const a = await DemoSource.create({ animated: false, still: 1.4 });
      const b = await DemoSource.create({ animated: false, still: 1.4 });
      const anim = await DemoSource.create({ animated: true });
      const t0 = hash(anim.frame(0));
      const t1 = hash(anim.frame(1.7));
      return { same: hash(a.frame()) === hash(b.frame()), moves: t0 !== t1, w: a.width, h: a.height, versionsDiffer: a.version !== b.version };
    });
    expect(res.same).toBe(true);
    expect(res.moves).toBe(true);
    expect(res.versionsDiffer).toBe(true);
    expect([res.w, res.h]).toEqual([960, 640]);
  });

  // ---------------------------------------------------------------------------------------------
  test('state: sanitising clamps numbers, whitelists enums and drops unknown keys', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const st = await import('/src/state.js');
      const hostile = {
        modeId: '<script>',
        global: { cols: 99999, brightness: -50, contrast: 'lots', hue: NaN, dither: 'evil', flipX: 'yes', thresholdOn: true, threshold: 300, __proto__: { polluted: 1 }, unknownKey: 5 },
        color: { colorMode: 'nope', ink: 'javascript:alert(1)', bg: '#ABCDEF', gradStops: ['#fff', 'red', 5], palette: 'c64', customPalette: 'x'.repeat(5000) },
        modes: { ascii: { gradient: '<img onerror=1>', customGradient: 'y'.repeat(3000), cellSize: 1e9, font: 'comic', spaceDensity: 2.6 }, evil: { a: 1 } },
        extra: 'ignored',
      };
      const s = st.sanitizeState(hostile);
      const clean = st.sanitizeState(null);
      const share = st.encodeShare(s);
      const back = st.decodeShareHash(`#s=${share}`);
      return {
        s,
        proto: ({}).polluted,
        keys: Object.keys(s).sort(),
        globalKeys: Object.keys(s.global).includes('unknownKey'),
        modesKeys: Object.keys(s.modes),
        roundTrip: JSON.stringify(back.global) === JSON.stringify(s.global) && JSON.stringify(back.modes.ascii) === JSON.stringify(s.modes.ascii),
        defaults: clean.global.cols,
        badHashes: [
          st.decodeShareHash('#s='),
          st.decodeShareHash('#s=@@@'),
          st.decodeShareHash('#s=' + 'A'.repeat(20000)),
          st.decodeShareHash('#s=' + btoa('not json').replace(/=/g, '')),
          st.decodeShareHash('#other'),
          st.decodeShareHash('#s=' + btoa(JSON.stringify({ v: 99 })).replace(/=/g, '')),
        ],
      };
    });
    expect(res.proto).toBeUndefined();
    expect(res.s.modeId).toBe('ascii');
    expect(res.s.global.cols).toBe(600);
    expect(res.s.global.brightness).toBe(0);
    expect(res.s.global.contrast).toBe(100);
    expect(res.s.global.hue).toBe(0);
    expect(res.s.global.dither).toBe('none');
    expect(res.s.global.flipX).toBe(false);
    expect(res.s.global.threshold).toBe(255);
    expect(res.globalKeys).toBe(false);
    expect(res.s.color.colorMode).toBe('mono');
    expect(res.s.color.ink).toBeNull();
    expect(res.s.color.bg).toBe('#abcdef');
    expect(res.s.color.gradStops).toBeNull(); // one valid colour is not enough for a gradient: back to the theme default
    expect(res.s.color.palette).toBe('c64');
    expect(res.s.color.customPalette.length).toBeLessThanOrEqual(500);
    expect(res.s.modes.ascii.gradient).toBe('standard');
    expect(res.s.modes.ascii.customGradient.length).toBeLessThanOrEqual(120);
    expect(res.s.modes.ascii.cellSize).toBe(32);
    expect(res.s.modes.ascii.font).toBe('geist-mono');
    expect(res.s.modes.ascii.spaceDensity).toBe(3);
    expect(res.modesKeys).toEqual(['ascii']);
    expect(res.roundTrip).toBe(true);
    expect(res.defaults).toBe(120);
    for (const b of res.badHashes) expect(b).toBeNull();
  });

  // ---------------------------------------------------------------------------------------------
  test('pipeline: 160 columns render fast enough for 30 fps', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const ascii = (await import('/src/modes/ascii.js')).default;
      const { DemoSource } = await import('/src/io/sources.js');
      const { ensureFonts } = await import('/src/engine/glyphs.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      await ensureFonts('geist-mono', ' .:-=+*#%@');
      const src = await DemoSource.create({ animated: true });
      const pipe = createPipeline();
      const params = {
        global: { ...defaultsOf(IMAGE_PARAMS), cols: 160 },
        color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: defaultsOf(ascii.params),
      };
      const theme = { ink: '#C4F169', bg: '#15181E' };
      const run = async (over) => {
        const p = { ...params, ...over };
        await pipe.render({ source: src, mode: ascii, params: p, time: 0.1, theme }); // warm-up
        const times = [];
        for (let i = 0; i < 40; i++) {
          // animated source: a new video-like frame every iteration (preprocess + analysis + render)
          const r = await pipe.render({ source: src, mode: ascii, params: p, time: 0.1 + i * 0.04, theme });
          times.push(r.ms);
        }
        times.sort((a, b) => a - b);
        return { median: times[20], p90: times[36], cols: params.global.cols };
      };
      const mono = await run({});
      const color = await run({ color: { ...params.color, colorMode: 'original' } });
      const dithered = await run({ global: { ...params.global, dither: 'floyd-steinberg' } });
      return { mono, color, dithered };
    });
    // 30 fps = 33 ms per frame, with margin for a slow CI machine
    expect(res.mono.median).toBeLessThan(33);
    expect(res.color.median).toBeLessThan(33);
    expect(res.dithered.median).toBeLessThan(33);
  });

  test('pipeline: draft quality, automatic quality and exports use the right working resolution', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const ascii = (await import('/src/modes/ascii.js')).default;
      const { DemoSource } = await import('/src/io/sources.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const mock = {
        id: 'mock', params: [], uses: ['image'],
        resolution: () => ({ width: 100, height: 50 }),
        render(ctx) {
          ctx.out.canvas.width = ctx.width;
          ctx.out.canvas.height = ctx.height;
          ctx.out.ctx2d.fillStyle = '#fff';
          ctx.out.ctx2d.fillRect(0, 0, ctx.width, ctx.height);
          return { quality: ctx.quality, isExport: ctx.isExport };
        },
      };
      const src = await DemoSource.create({ animated: false });
      const pipe = createPipeline();
      const base = { source: src, theme: { ink: '#fff', bg: '#000' } };
      const params = (mode) => ({ global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: mode ? defaultsOf(mode.params) : {} });
      const w = async (args, mode = mock) => (await pipe.render({ ...base, mode, params: params(mode === mock ? null : mode), ...args })).workWidth;
      return {
        full: await w({ quality: 'full' }),
        draft: await w({ quality: 'draft' }),
        auto: await w({ quality: 'full', autoScale: 0.5 }),
        draftAuto: await w({ quality: 'draft', autoScale: 0.5 }),
        exportIgnoresDraft: await w({ quality: 'draft', isExport: true, autoScale: 0.25 }),
        asciiDraft: await w({ quality: 'draft' }, ascii),
        asciiFull: await w({ quality: 'full' }, ascii),
        meta: (await pipe.render({ ...base, mode: mock, params: params(null), quality: 'draft', isExport: true })).meta,
      };
    });
    expect(res.full).toBe(100);
    expect(res.draft).toBe(50); // half resolution while a slider is being dragged (PLAN.md 4.5)
    expect(res.auto).toBe(50);
    expect(res.draftAuto).toBe(25);
    expect(res.exportIgnoresDraft).toBe(100); // exports are always full quality
    expect(res.asciiDraft).toBe(res.asciiFull); // ASCII is cheap and opts out of draft
    expect(res.meta).toEqual({ quality: 'full', isExport: true });
  });

  test('pipeline: a failing mode falls back to the source and reports the error', async ({ page }) => {
    const guard = watchPage(page);
    const res = await page.evaluate(async () => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const { DemoSource } = await import('/src/io/sources.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const broken = {
        id: 'broken', params: [], uses: ['image'],
        resolution: () => ({ width: 10, height: 10 }),
        render() { throw new Error('boom'); },
      };
      const origError = console.error;
      const logged = [];
      console.error = (...a) => logged.push(a.map(String).join(' '));
      const src = await DemoSource.create({ animated: false });
      const pipe = createPipeline();
      const r = await pipe.render({
        source: src, mode: broken, theme: { ink: '#fff', bg: '#000' },
        params: { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: {} },
      });
      console.error = origError;
      const g = r.canvas.getContext('2d');
      const px = g.getImageData(0, 0, r.canvas.width, r.canvas.height).data;
      let nonBlank = false;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 0) { nonBlank = true; break; }
      return { error: String(r.error), w: r.width, h: r.height, nonBlank, logged: logged.length };
    });
    expect(res.error).toContain('boom');
    expect(res.nonBlank).toBe(true);
    expect(res.w).toBeGreaterThan(100);
    expect(res.logged).toBe(1);
    await guard.assertClean(expect);
  });
});
