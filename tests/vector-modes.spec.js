// Phase 4 (PLAN.md 7.14-7.20, 12): the seven vector modes keep their polylines as a scene, draw it on the canvas and
// serialise the same data to SVG. These tests check the SVG of every mode (valid XML, layers, plotter mode without
// fills, mm pages), the determinism of the animated modes on the frame time (preview probes and video export), the
// escaped title block, single-line spirals, and that every mode renders a video source.
import { test, expect } from '@playwright/test';
import {
  gotoApp, watchPage, loadVideo, loadFixture, setControl, captureDownload, inspectMedia, canvasStats, renderCount,
  settle, pauseVideo, renderMode,
} from './helpers.js';

const VECTOR_MODES = ['crosshatch', 'contours', 'voronoi', 'flowfield', 'blueprint', 'vectrex', 'spiral'];
const RECTS = [['#f0f0f0', 0, 0, 1, 1], ['#101010', 0.1, 0.15, 0.4, 0.5], ['#808080', 0.55, 0.2, 0.35, 0.6], ['#c04020', 0.2, 0.7, 0.6, 0.2]];
const HOSTILE = `<img src=x onerror=alert(1)>&"'`;

async function pick(page, id) {
  const item = page.locator(`#mode-list .mode-item[data-mode-id="${id}"]`);
  if ((await item.getAttribute('aria-current')) === 'true') return;
  const before = await renderCount(page);
  await item.click();
  await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b, before);
}

/** Render a mode on a synthetic picture and return its SVG with several export options. */
async function svgs(page, mode, params = {}, optsList = [{}]) {
  return page.evaluate(async ({ mode, params, optsList, rects }) => {
    const { createPipeline } = await import('/src/engine/pipeline.js');
    const { getMode } = await import('/src/modes/index.js');
    const { defaultsOf } = await import('/src/state.js');
    const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
    const { COLOR_PARAMS } = await import('/src/engine/color.js');
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    const g = c.getContext('2d');
    for (const [col, x, y, w, h] of rects) { g.fillStyle = col; g.fillRect(x * 320, y * 240, w * 320, h * 240); }
    const source = { id: 's', kind: 'image', width: 320, height: 240, version: 1, animated: false, frame: () => c, dispose() {} };
    const m = getMode(mode);
    const pipe = createPipeline();
    const p = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: { ...defaultsOf(m.params), ...params } };
    const r = await pipe.render({ source, mode: m, params: p, time: 1, theme: { ink: '#c4f169', bg: '#15181e' }, outScale: 1, isExport: true, quality: 'full' });
    const state = pipe.getState(mode);
    return { error: r.error ? String(r.error) : null, svgs: optsList.map((o) => m.toSVG(state, o)) };
  }, { mode, params, optsList, rects: RECTS });
}

async function inspect(page, svg) {
  return page.evaluate((src) => {
    const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
    const INK = 'http://www.inkscape.org/namespaces/inkscape';
    const fills = new Set();
    for (const el of doc.querySelectorAll('*')) if (el.hasAttribute('fill')) fills.add(el.getAttribute('fill'));
    const layers = Array.from(doc.querySelectorAll('g')).filter((x) => x.getAttributeNS(INK, 'groupmode') === 'layer');
    return {
      error: doc.querySelector('parsererror')?.textContent || null,
      root: [doc.documentElement.getAttribute('width'), doc.documentElement.getAttribute('height'), doc.documentElement.getAttribute('viewBox')],
      layers: layers.map((x) => x.getAttributeNS(INK, 'label')),
      layerIds: layers.map((x) => x.id),
      drawn: layers.map((x) => x.querySelectorAll('path, circle, text').length),
      fills: Array.from(fills),
      images: doc.querySelectorAll('image').length,
      bad: doc.querySelectorAll('script, img, foreignObject, iframe').length,
      texts: Array.from(doc.querySelectorAll('text')).map((t) => t.textContent),
      subpaths: Array.from(doc.querySelectorAll('g')).map((x) => ({ id: x.id, m: Array.from(x.querySelectorAll('path')).reduce((s, p) => s + ((p.getAttribute('d') || '').match(/M/g) || []).length, 0) })),
      nan: /NaN|Infinity|undefined/.test(src),
    };
  }, svg);
}

test.describe('vector modes: SVG', () => {
  test('every vector mode exports valid SVG: layers, plotter mode without fills, A4 in mm', async ({ page }) => {
    const guard = watchPage(page);
    await page.goto('/tests/blank.html');
    const ids = await page.evaluate(async () => (await import('/src/modes/index.js')).MODES.filter((m) => m.category === 'vector').map((m) => m.id));
    expect(ids).toEqual(VECTOR_MODES);
    for (const id of ids) {
      const { error, svgs: [plain, plotter, a4] } = await svgs(page, id, {}, [{}, { plotter: true }, { page: 'a4', margin: 10, plotter: true }]);
      expect(error, id).toBeNull();
      const p = await inspect(page, plain);
      expect(p.error, `${id} parses`).toBeNull();
      expect(p.nan, `${id} has no NaN`).toBe(false);
      expect(p.root, id).toEqual(['1000', '750', '0 0 1000 750']);
      expect(p.layers[0], id).toBe('Background');
      expect(p.layers.length, `${id} layers`).toBeGreaterThan(1);
      expect(p.drawn.slice(1).some((n) => n > 0), `${id} draws something`).toBe(true);
      const q = await inspect(page, plotter);
      expect(q.error, `${id} plotter parses`).toBeNull();
      expect(q.fills.every((f) => f === 'none'), `${id} plotter fills: ${q.fills}`).toBe(true);
      expect(q.images, `${id} plotter rasters`).toBe(0);
      expect(q.layers, id).not.toContain('Background');
      const a = await inspect(page, a4);
      expect(a.error, `${id} A4 parses`).toBeNull();
      expect(a.root, `${id} A4`).toEqual(['297mm', '210mm', '0 0 297 210']);
      expect(a.nan, `${id} A4 has no NaN`).toBe(false);
    }
    await guard.assertClean(expect);
  });

  test('sub-styles and options reach the SVG (engraving, contour labels and bands, spiral as one stroke)', async ({ page }) => {
    await page.goto('/tests/blank.html');
    // engraving: filled ribbons normally, 1-4 offset pen strokes in plotter mode
    let r = await svgs(page, 'crosshatch', { style: 'engraving', layers: 2 }, [{}, { plotter: true }]);
    let a = await inspect(page, r.svgs[0]);
    let b = await inspect(page, r.svgs[1]);
    expect(a.layers).toEqual(['Background', 'Engraving', 'Cross engraving 1']);
    expect(a.fills).toContain('#15181e');
    expect(b.fills.every((f) => f === 'none')).toBe(true);
    expect(b.subpaths.find((s) => s.id === 'engraving').m).toBeGreaterThan(a.subpaths.find((s) => s.id === 'engraving').m);
    // hatch: one layer per direction
    r = await svgs(page, 'crosshatch', { style: 'hatch', layers: 3 });
    a = await inspect(page, r.svgs[0]);
    expect(a.layerIds).toEqual(['background', 'hatch-1', 'hatch-2', 'hatch-3']);
    // contours: index contours with numeric labels, bands and hillshade (only outside plotter mode)
    r = await svgs(page, 'contours', { fillBands: true, hillshade: true, labels: true, levels: 10, indexEvery: 2, minLength: 0 }, [{}, { plotter: true }]);
    a = await inspect(page, r.svgs[0]);
    b = await inspect(page, r.svgs[1]);
    expect(a.layers).toEqual(['Background', 'Hypsometric bands', 'Hillshade', 'Contours', 'Index contours', 'Labels']);
    expect(a.images).toBe(1);
    expect(a.texts.length).toBeGreaterThan(0);
    expect(a.texts.every((t) => /^\d+$/.test(t))).toBe(true);
    expect(b.layers).toEqual(['Contours', 'Index contours', 'Labels']);
    // spiral and squiggle: a single continuous stroke
    for (const style of ['spiral', 'squiggle']) {
      r = await svgs(page, 'spiral', { style }, [{}, { plotter: true }]);
      a = await inspect(page, r.svgs[1]);
      expect(a.subpaths.find((s) => s.id === 'line').m, style).toBe(1);
    }
    // flow field: one layer per pen colour; palette mode uses the palette colours
    r = await svgs(page, 'flowfield', { colorFrom: 'palette', palette: 'cga', svgParticles: 300 });
    a = await inspect(page, r.svgs[0]);
    expect(a.layers.length).toBeGreaterThan(1);
    expect(a.layers.slice(1).every((l) => /^Pen \d+ #(000000|55ffff|ff55ff|ffffff)$/.test(l))).toBe(true);
    expect(a.subpaths.filter((s) => s.id.startsWith('pen-')).reduce((n, s) => n + s.m, 0)).toBeLessThanOrEqual(300);
  });

  test('the blueprint title block escapes hostile text in every field (SVG and studio export)', async ({ page }) => {
    const guard = watchPage(page);
    await page.goto('/tests/blank.html');
    const r = await svgs(page, 'blueprint', { title: HOSTILE, scaleText: HOSTILE, date: HOSTILE, sheet: '<b>1', drawnBy: HOSTILE }, [{}, { plotter: true }]);
    for (const svg of r.svgs) {
      expect(svg).not.toMatch(/<img/i);
      expect(svg).not.toContain('<b>');
      const info = await inspect(page, svg);
      expect(info.error).toBeNull();
      expect(info.bad).toBe(0);
      const block = info.texts.filter((t) => t.includes('onerror') || t.includes('<b>'));
      expect(block.length).toBeGreaterThanOrEqual(4); // the hostile values survive as text, not markup
      expect(info.texts).toContain('<b>1');
    }
    // the same through the UI: type into the title field and export
    await gotoApp(page);
    await loadFixture(page);
    await pick(page, 'blueprint');
    await settle(page);
    await setControl(page, 'title', '<script>alert(1)</script>', 'mode');
    await settle(page, 300);
    const { bytes } = await captureDownload(page, () => page.click('[data-export="svg"]'));
    const svg = bytes.toString('utf8');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;SCRIPT&gt;ALERT(1)&lt;/SCRIPT&gt;'); // the title block writes the title in capitals
    const info = await inspect(page, svg);
    expect(info.error).toBeNull();
    expect(info.bad).toBe(0);
    expect(info.texts).toContain('<SCRIPT>ALERT(1)</SCRIPT>');
    await guard.assertClean(expect);
  });
});

test.describe('vector modes: animation is a pure function of time', () => {
  for (const id of ['flowfield', 'vectrex']) {
    test(`${id}: the same seed and time give the same picture, whatever was rendered before`, async ({ page }) => {
      const guard = watchPage(page);
      await page.goto('/tests/blank.html');
      const base = { mode: id, width: 320, height: 240, rects: RECTS, isExport: true };
      const a = await renderMode(page, { ...base, times: [0.5, 1.25, 0.5, 3] });
      const b = await renderMode(page, { ...base, times: [1.25] });
      const c = await renderMode(page, { ...base, times: [1.25], params: { mode: { seed: 99 } } });
      const preview = await renderMode(page, { ...base, isExport: false, times: [1.25, 1.25] });
      expect(a.error).toBeNull();
      expect(a.frames[0].hash, 'scrubbing back gives the same frame').toBe(a.frames[2].hash);
      expect(a.frames[1].hash, 'a different time differs').not.toBe(a.frames[0].hash);
      expect(a.frames[3].hash).not.toBe(a.frames[1].hash);
      expect(b.frames[0].hash, 'a fresh pipeline at the same time').toBe(a.frames[1].hash);
      expect(c.frames[0].hash, 'another seed differs').not.toBe(b.frames[0].hash);
      expect(preview.frames[0].hash).toBe(preview.frames[1].hash);
      await guard.assertClean(expect);
    });
  }

  for (const id of ['flowfield', 'vectrex']) {
    test(`${id}: a still picture exports to WebM with frames that depend only on the frame time`, async ({ page }) => {
      test.setTimeout(180_000);
      const guard = watchPage(page);
      await gotoApp(page);
      await page.evaluate(async (modeId) => {
        const mode = (await import(`/src/modes/${modeId}.js`)).default;
        window.__frames = [];
        const render = mode.render;
        mode.render = function (ctx, state) {
          const meta = render.call(this, ctx, state);
          if (ctx.isExport) {
            const g = ctx.out.canvas.getContext('2d', { willReadFrequently: true });
            const d = g.getImageData(0, 0, ctx.out.canvas.width, ctx.out.canvas.height).data;
            let h = 2166136261;
            for (let i = 0; i < d.length; i += 7) h = Math.imul(h ^ d[i], 16777619);
            window.__frames.push({ t: ctx.time, h: h >>> 0 });
          }
          return meta;
        };
      }, id);
      await loadFixture(page);
      await pick(page, id);
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
        const file = await captureDownload(page, () => page.click('#vx-go'), 150_000);
        const info = await inspectMedia(page, file.bytes);
        expect(info.format).toBe('WebM');
        expect(info.duration).toBeGreaterThan(0.8);
        expect(info.duration).toBeLessThan(1.4);
        return page.evaluate(() => window.__frames.slice(-24));
      };
      const a = await exportOnce();
      const b = await exportOnce();
      expect(a.length).toBe(24);
      a.forEach((f, i) => expect(f.t).toBeCloseTo(i / 24, 5));
      expect(b.map((f) => f.h)).toEqual(a.map((f) => f.h));
      expect(new Set(a.map((f) => f.h)).size, 'the animation moves').toBeGreaterThan(12);
      await guard.assertClean(expect);
    });
  }
});

test.describe('vector modes: sources and studio', () => {
  test('every vector mode renders a video source and offers video export', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadVideo(page);
    await pauseVideo(page);
    for (const id of VECTOR_MODES) {
      await pick(page, id);
      if (id !== 'flowfield' && id !== 'vectrex') await settle(page, 350);
      else await page.waitForTimeout(300);
      const stats = await canvasStats(page);
      expect(stats.variance, `${id} canvas is not blank`).toBeGreaterThan(0);
      await expect(page.locator('#chip-error'), `${id} did not fail`).toBeHidden();
      await expect(page.locator('#controls [data-export="video"]'), `${id} offers video`).toHaveCount(1);
    }
    await guard.assertClean(expect);
  });

  test('voronoi on a video keeps its points coherent from frame to frame (a couple of Lloyd steps per frame)', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const res = await page.evaluate(async () => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const { getMode } = await import('/src/modes/index.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      const g = c.getContext('2d');
      const source = { id: 'v', kind: 'video', width: 320, height: 240, version: 1, animated: false, frameId: 0, frame: () => c, dispose() {} };
      const draw = (x) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 320, 240); g.fillStyle = '#000'; g.fillRect(x, 60, 120, 120); };
      const m = getMode('voronoi');
      const pipe = createPipeline();
      const params = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: { ...defaultsOf(m.params), points: 800, iterations: 10 } };
      const theme = { ink: '#000000', bg: '#ffffff' };
      draw(40);
      await pipe.render({ source, mode: m, params, theme, time: 0, isExport: true });
      const st = pipe.getState('voronoi');
      const first = Float32Array.from(st.points);
      const itFirst = st.iteration;
      draw(48); source.frameId++;
      await pipe.render({ source, mode: m, params, theme, time: 1 / 30, isExport: true });
      let moved = 0;
      for (let i = 0; i < first.length; i += 2) moved += Math.hypot(st.points[i] - first[i], st.points[i + 1] - first[i + 1]);
      return { itFirst, itNext: st.iteration, n: st.points.length / 2, meanMove: moved / (first.length / 2) };
    });
    expect(res.itFirst).toBe(10);
    expect(res.itNext).toBe(2); // only two iterations on the new frame
    expect(res.n).toBe(800);
    expect(res.meanMove).toBeGreaterThan(0);
    expect(res.meanMove).toBeLessThan(6); // the points stay where they were (coherent), they do not reseed
  });

  test('vector modes stay within the render budget on a cached re-render and animate at a usable rate', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const res = await page.evaluate(async (ids) => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const { getMode } = await import('/src/modes/index.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const c = document.createElement('canvas');
      c.width = 1280; c.height = 720;
      const g = c.getContext('2d');
      const grd = g.createRadialGradient(500, 300, 20, 640, 360, 600);
      grd.addColorStop(0, '#fff'); grd.addColorStop(0.5, '#555'); grd.addColorStop(1, '#111');
      g.fillStyle = grd; g.fillRect(0, 0, 1280, 720);
      g.fillStyle = '#000'; g.fillRect(900, 100, 200, 300);
      const source = { id: 'b', kind: 'image', width: 1280, height: 720, version: 1, animated: false, frame: () => c, dispose() {} };
      const out = {};
      for (const id of ids) {
        const m = getMode(id);
        const pipe = createPipeline({ onInvalidate: () => {} });
        const params = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: defaultsOf(m.params) };
        const times = [];
        for (let i = 0; i < 6; i++) {
          const t0 = performance.now();
          await pipe.render({ source, mode: m, params, theme: { ink: '#c4f169', bg: '#15181e' }, time: 1 + i / 30, outScale: 1 });
          times.push(performance.now() - t0);
        }
        const warm = times.slice(2).sort((a, b) => a - b);
        out[id] = { first: Math.round(times[0]), median: Math.round(warm[Math.floor(warm.length / 2)]) };
        pipe.dispose();
      }
      return out;
    }, VECTOR_MODES);
    console.log('vector render times (ms)', JSON.stringify(res));
    for (const id of ['crosshatch', 'contours', 'voronoi', 'blueprint', 'spiral']) {
      expect(res[id].median, `${id}: a still mode re-renders its cached scene`).toBeLessThan(60);
    }
    for (const id of ['flowfield', 'vectrex']) {
      expect(res[id].median, `${id}: animated frame`).toBeLessThan(200); // PLAN.md 18.2: slower frames lower the quality
    }
  });
});
