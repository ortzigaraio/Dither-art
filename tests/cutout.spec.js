// Smart cut-out, noise reduction and the ASCII tone curve (engine level, in the real browser).
import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers.js';

test.describe('cutout + tone', () => {
  test.beforeEach(async ({ page }) => { await gotoApp(page); });

  test('auto cut-out flattens a noisy gradient background and keeps the subject', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { applyCutout, denoise, cutoutMask } = await import('/src/engine/cutout.js');
      const w = 120, h = 90;
      const make = () => {
        const d = new Uint8ClampedArray(w * h * 4);
        let seed = 1;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const inside = (x - 60) ** 2 + (y - 45) ** 2 < 28 * 28; // red disc
          const bgv = 200 + x * 0.15 + (rnd() - 0.5) * 16; // soft gradient + grain
          d[o] = inside ? 190 : bgv; d[o + 1] = inside ? 30 : bgv; d[o + 2] = inside ? 40 : bgv; d[o + 3] = 255;
        }
        // a stray speck in the corner region, away from the subject
        for (let y = 5; y < 8; y++) for (let x = 5; x < 8; x++) { const o = (y * w + x) * 4; d[o] = 20; d[o + 1] = 20; d[o + 2] = 20; }
        return d;
      };
      const g = { cutout: 'auto', cutoutTol: 30, cutoutConnected: true, cutoutClean: 40, cutoutSoft: 0, cutoutFill: 'white', cutoutInvert: false };
      const d = make();
      const ok = applyCutout(d, w, h, g, '#000000');
      const at = (x, y) => { const o = (y * w + x) * 4; return [d[o], d[o + 1], d[o + 2]]; };
      // fail-safe: a flat image yields no mask
      const flat = new Uint8ClampedArray(w * h * 4).fill(255);
      const none = cutoutMask(flat, w, h, { mode: 'auto', tolerance: 30, connected: true, clean: 0, soft: 0, invert: false });
      // denoise lowers the grain of a flat area
      const dn = make();
      const sd = (a) => { let m = 0, v = 0, c = 0; for (let y = 60; y < 85; y++) for (let x = 90; x < 115; x++) { m += a[(y * w + x) * 4]; c++; } m /= c; for (let y = 60; y < 85; y++) for (let x = 90; x < 115; x++) v += (a[(y * w + x) * 4] - m) ** 2; return Math.sqrt(v / c); };
      const before = sd(dn);
      denoise(dn, w, h, 6);
      return { ok, subject: at(60, 45), bg: at(100, 20), speck: at(6, 6), none, before, after: sd(dn) };
    });
    expect(r.ok).toBe(true);
    expect(r.subject[0]).toBeGreaterThan(150);
    expect(r.subject[1]).toBeLessThan(80); // still red
    expect(r.bg).toEqual([255, 255, 255]);
    expect(r.speck).toEqual([255, 255, 255]);
    expect(r.none).toBeNull();
    expect(r.after).toBeLessThan(r.before * 0.7);
  });

  test('tone helpers: auto levels, gamma and local contrast', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { autoLevels, applyGamma, localContrast } = await import('/src/engine/tone.js');
      const l = Float32Array.from({ length: 100 }, (_, i) => 0.3 + (i / 99) * 0.2);
      const rng = autoLevels(l, 0.02);
      const lo = Math.min(...l), hi = Math.max(...l);
      const g = Float32Array.from([0.25]); applyGamma(g, 2);
      const flat = new Float32Array(16).fill(0.5); localContrast(flat, 4, 4, 1);
      return { rng, lo, hi, g: g[0], flat: flat[0] };
    });
    expect(r.lo).toBeLessThan(0.02);
    expect(r.hi).toBeGreaterThan(0.98);
    expect(r.g).toBeCloseTo(0.5, 2);
    expect(r.flat).toBeCloseTo(0.5, 3);
  });

  test('the cut-out group is in the panel and its settings survive reset of the image group', async ({ page }) => {
    await expect(page.locator('details.group[data-group="cutout"]')).toHaveCount(1);
    await page.evaluate(async () => {
      const m = await import('/src/state.js');
      const s = m.createStore();
      s.set('global.cutout', 'auto');
      s.set('global.denoise', 4);
      s.resetGroup('global');
      window.__after = { cutout: s.get('global.cutout'), denoise: s.get('global.denoise') };
      s.resetGroup('cutout');
      window.__after2 = { cutout: s.get('global.cutout'), denoise: s.get('global.denoise') };
    });
    expect(await page.evaluate(() => window.__after)).toEqual({ cutout: 'auto', denoise: 4 });
    expect(await page.evaluate(() => window.__after2)).toEqual({ cutout: 'off', denoise: 0 });
  });
});
