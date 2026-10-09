// Linear halftone (engraved line screen): registration, tone (line width follows the tone), angle, rings, wave and
// contour following, SVG (filled ribbons; pen strokes in plotter mode) and the studio round trip.
import { test, expect } from '@playwright/test';
import { gotoApp, watchPage, loadFixture, renderCount, waitForRender, captureDownload, canvasStats, setControl, settle } from './helpers.js';

const MONO = { ink: '#000000', paper: '#ffffff', follow: 0, wave: 0, minWidth: 0, maxWidth: 1, smooth: 0, gamma: 1 };

/** Render the mode on a synthetic picture; return pixel statistics and the SVG (plain and plotter). */
async function probe(page, { rects, mode = {}, w = 400, h = 300 }) {
  return page.evaluate(async ({ rects, mode, w, h }) => {
    const { createPipeline } = await import('/src/engine/pipeline.js');
    const { getMode } = await import('/src/modes/index.js');
    const { defaultsOf } = await import('/src/state.js');
    const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
    const { COLOR_PARAMS } = await import('/src/engine/color.js');
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    for (const [col, x, y, rw, rh] of rects) { g.fillStyle = col; g.fillRect(x * w, y * h, rw * w, rh * h); }
    const source = { id: 'lh' + Math.random(), kind: 'image', width: w, height: h, version: 1, animated: false, frame: () => c, dispose() {} };
    const m = getMode('linehalftone');
    const pipe = createPipeline();
    const params = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: { ...defaultsOf(m.params), ...mode } };
    const r = await pipe.render({ source, mode: m, params, time: 0, theme: { ink: '#ffffff', bg: '#000000' }, outScale: 1, isExport: true, quality: 'full' });
    const out = document.createElement('canvas');
    out.width = r.width; out.height = r.height;
    const og = out.getContext('2d', { willReadFrequently: true });
    og.drawImage(r.canvas, 0, 0);
    const d = og.getImageData(0, 0, out.width, out.height).data;
    const L = (x, y) => { const o = (y * out.width + x) * 4; return (0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) / 255; };
    const mean = (fx0, fy0, fx1, fy1) => {
      let s = 0, n = 0;
      for (let y = Math.floor(fy0 * out.height); y < Math.floor(fy1 * out.height); y++) for (let x = Math.floor(fx0 * out.width); x < Math.floor(fx1 * out.width); x++) { s += L(x, y); n++; }
      return s / n;
    };
    // ink/paper transitions met walking down a column vs along a row (in the middle of the picture)
    const flips = (vertical) => {
      let f = 0;
      const n = vertical ? out.height : out.width;
      let prev = null;
      for (let i = 0; i < n; i++) {
        const v = vertical ? L(Math.floor(out.width / 2), i) : L(i, Math.floor(out.height / 2));
        const b = v < 0.5;
        if (prev !== null && b !== prev) f++;
        prev = b;
      }
      return f;
    };
    let hsh = 2166136261;
    for (let i = 0; i < d.length; i += 4) hsh = Math.imul(hsh ^ d[i] ^ (d[i + 1] << 8), 16777619);
    const state = pipe.getState('linehalftone');
    const svg = m.toSVG(state, {});
    const plot = m.toSVG(state, { plotter: true });
    const ribbons = state.scene.layers[0].ribbons;
    pipe.dispose();
    return {
      error: r.error ? String(r.error) : null,
      size: [out.width, out.height],
      means: { left: mean(0.02, 0.1, 0.23, 0.9), mid: mean(0.52, 0.1, 0.73, 0.9), right: mean(0.77, 0.1, 0.98, 0.9), all: mean(0, 0, 1, 1) },
      flipsV: flips(true),
      flipsH: flips(false),
      hash: (hsh >>> 0).toString(16),
      ribbons: ribbons.length,
      maxWidth: ribbons.reduce((a, rb) => Math.max(a, ...rb.widths), 0),
      svg,
      plot,
    };
  }, { rects, mode, w, h });
}

async function inspectSVG(page, src) {
  return page.evaluate((s) => {
    const doc = new DOMParser().parseFromString(s, 'image/svg+xml');
    const INK = 'http://www.inkscape.org/namespaces/inkscape';
    const fills = new Set();
    for (const el of doc.querySelectorAll('*')) if (el.hasAttribute('fill')) fills.add(el.getAttribute('fill'));
    return {
      error: doc.querySelector('parsererror')?.textContent || null,
      layers: Array.from(doc.querySelectorAll('g')).filter((g) => g.getAttributeNS(INK, 'groupmode') === 'layer').map((g) => g.getAttributeNS(INK, 'label')),
      fills: Array.from(fills),
      subpaths: Array.from(doc.querySelectorAll('path')).reduce((n, p) => n + ((p.getAttribute('d') || '').match(/M/g) || []).length, 0),
      bad: doc.querySelectorAll('script, foreignObject, image').length,
      nan: /NaN|Infinity|undefined/.test(s),
    };
  }, src);
}

test.describe('linear halftone mode', () => {
  test('is registered as a vector mode with SVG export, right after the engraving mode', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const info = await page.evaluate(async () => {
      const { MODES, getMode } = await import('/src/modes/index.js');
      const m = getMode('linehalftone');
      const ids = MODES.map((x) => x.id);
      return {
        id: m.id, category: m.category, badges: m.badges, exports: m.exports, svgOptions: m.svgOptions,
        after: ids[ids.indexOf('linehalftone') - 1],
        params: m.params.map((p) => p.id),
        presets: m.presets.map((p) => p.id),
        name: m.name,
      };
    });
    expect(info.id).toBe('linehalftone');
    expect(info.category).toBe('vector');
    expect(info.badges).toContain('SVG');
    expect(info.exports).toEqual(['png', 'svg', 'video']);
    expect(info.svgOptions).toBe(true);
    expect(info.after).toBe('crosshatch');
    expect(info.params).toEqual(expect.arrayContaining(['pattern', 'spacing', 'angle', 'wave', 'waveLength', 'follow', 'minWidth', 'maxWidth', 'ink', 'paper']));
    expect(info.presets.length).toBeGreaterThanOrEqual(3);
    expect(info.name).toEqual({ es: 'Halftone lineal', en: 'Linear halftone' });
  });

  test('line width follows the tone: black is nearly solid ink, white is bare paper, mid grey about half', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const r = await probe(page, { rects: [['#ffffff', 0, 0, 1, 1], ['#000000', 0, 0, 0.25, 1], ['#808080', 0.5, 0, 0.25, 1]], mode: { ...MONO, spacing: 8 } });
    expect(r.error).toBeNull();
    expect(r.means.left).toBeLessThan(0.15);
    expect(r.means.right).toBeGreaterThan(0.97);
    expect(r.means.mid).toBeGreaterThan(0.3);
    expect(r.means.mid).toBeLessThan(0.75);
    // thicker spacing = thicker lines at full ink, never wider than the spacing
    expect(r.maxWidth).toBeLessThanOrEqual(8 + 1e-3);
    expect(r.maxWidth).toBeGreaterThan(6);
  });

  test('angle 0 draws horizontal lines and angle 90 vertical ones', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const grey = [['#808080', 0, 0, 1, 1]];
    const h = await probe(page, { rects: grey, mode: { ...MONO, angle: 0, spacing: 10 } });
    const v = await probe(page, { rects: grey, mode: { ...MONO, angle: 90, spacing: 10 } });
    expect(h.flipsV).toBeGreaterThan(40); // walking down crosses every line
    expect(h.flipsH).toBeLessThan(4);
    expect(v.flipsH).toBeGreaterThan(40);
    expect(v.flipsV).toBeLessThan(4);
  });

  test('rings, wave and contour following change the drawing; the same settings give the same picture', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const pic = [['#ffffff', 0, 0, 1, 1], ['#202020', 0.3, 0.2, 0.4, 0.6], ['#909090', 0.05, 0.05, 0.2, 0.3]];
    const base = await probe(page, { rects: pic, mode: { ...MONO } });
    const again = await probe(page, { rects: pic, mode: { ...MONO } });
    const rings = await probe(page, { rects: pic, mode: { ...MONO, pattern: 'circles' } });
    const wave = await probe(page, { rects: pic, mode: { ...MONO, wave: 0.8, waveLength: 60 } });
    const follow = await probe(page, { rects: pic, mode: { ...MONO, follow: 1 } });
    expect(again.hash).toBe(base.hash);
    for (const x of [rings, wave, follow]) {
      expect(x.error).toBeNull();
      expect(x.hash).not.toBe(base.hash);
      expect(x.ribbons).toBeGreaterThan(5);
    }
    // the rings are closed curves around the centre: on a flat grey, walking a row or a column both cross many of them
    const grey = await probe(page, { rects: [['#808080', 0, 0, 1, 1]], mode: { ...MONO, pattern: 'circles', spacing: 10 } });
    expect(grey.flipsH).toBeGreaterThan(40);
    expect(grey.flipsV).toBeGreaterThan(40);
    // a minimum width keeps the lines going over bare paper
    const minw = await probe(page, { rects: [['#ffffff', 0, 0, 1, 1]], mode: { ...MONO, minWidth: 0.2 } });
    expect(minw.means.all).toBeLessThan(0.95);
    const none = await probe(page, { rects: [['#ffffff', 0, 0, 1, 1]], mode: { ...MONO, minWidth: 0 } });
    expect(none.means.all).toBeGreaterThan(0.99);
  });

  test('light ink on dark paper puts the lines in the lights (the electric-blue look)', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const r = await probe(page, { rects: [['#000000', 0, 0, 1, 1], ['#ffffff', 0.5, 0, 0.5, 1]], mode: { follow: 0, wave: 0, minWidth: 0, ink: '#ffffff', paper: '#1e1eff' } });
    // left (black picture) stays blue paper (luma of #1e1eff = 0.18), right (white picture) gets thick white lines
    expect(Math.abs(r.means.left - 0.181)).toBeLessThan(0.02);
    expect(r.means.right).toBeGreaterThan(0.6);
  });

  test('SVG: valid, background + lines layer, filled ribbons; plotter mode is strokes only', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const r = await probe(page, { rects: [['#ffffff', 0, 0, 1, 1], ['#000000', 0.2, 0.2, 0.6, 0.6]], mode: { ...MONO, ink: '#102030' } });
    const a = await inspectSVG(page, r.svg);
    expect(a.error).toBeNull();
    expect(a.nan).toBe(false);
    expect(a.bad).toBe(0);
    expect(a.layers).toEqual(['Background', 'Lines']);
    expect(a.fills).toContain('#102030');
    const b = await inspectSVG(page, r.plot);
    expect(b.error).toBeNull();
    expect(b.fills.every((f) => f === 'none')).toBe(true);
    expect(b.layers).toEqual(['Lines']);
    expect(b.subpaths).toBeGreaterThan(a.subpaths); // thick lines become several pen strokes
  });

  test('studio: generated controls, non-blank render, presets and SVG download', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const before = await renderCount(page);
    await page.locator('#mode-list .mode-item[data-mode-id="linehalftone"]').click();
    await waitForRender(page, before);
    await settle(page);
    const s = await canvasStats(page);
    expect(s.variance).toBeGreaterThan(0.01);
    for (const id of ['pattern', 'spacing', 'angle', 'follow', 'minWidth', 'maxWidth', 'ink', 'paper']) {
      await expect(page.locator(`#controls [data-param="${id}"]`)).toHaveCount(1);
    }
    // centre controls only for rings
    await expect(page.locator('#controls [data-param="centerX"]')).toBeHidden();
    const b2 = await renderCount(page);
    await setControl(page, 'pattern', 'circles');
    await waitForRender(page, b2);
    await expect(page.locator('#controls [data-param="centerX"]')).toBeVisible();
    await expect(page.locator('#controls [data-param="angle"]')).toBeHidden();
    const s2 = await canvasStats(page);
    expect(s2.hash).not.toBe(s.hash);
    const { name, bytes } = await captureDownload(page, () => page.click('[data-export="svg"]'));
    expect(name).toMatch(/^dither-linehalftone-\d{8}-\d{6}\.svg$/);
    const info = await inspectSVG(page, bytes.toString('utf8'));
    expect(info.error).toBeNull();
    expect(info.layers).toEqual(['Background', 'Rings']);
    await guard.assertClean(expect);
  });
});
