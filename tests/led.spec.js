import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, renderMode } from './helpers.js';

// LED panel (PLAN.md 7.10). Source 480x240 with 40 columns -> 40x20 LEDs of 8 px, output 320x160 at scale 1.

const BASE = { mode: 'led', width: 480, height: 240, global: { cols: 40 } };
const P = (mode) => ({ global: { cols: 40 }, mode: { glow: 0, panel: '#08090b', ...mode } });
/** centre pixel of LED (cx, cy) of a 40x20 panel as a fraction of the 320x160 output */
const centre = (cx, cy) => [(cx * 8 + 4) / 320, (cy * 8 + 4) / 160];

test.describe('led: look-up endpoints', () => {
  test('white lights the LED fully, black leaves it at 8 % of the LED colour (amber)', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const r = await renderMode(page, {
      ...BASE, rects: [['#ffffff', 0, 0, 0.5, 1], ['#000000', 0.5, 0, 0.5, 1]], params: P({ ledColor: 'amber', levels: 6 }),
      pixels: [centre(5, 10), centre(30, 10)],
    });
    expect(r.error).toBeNull();
    expect([r.width, r.height]).toEqual([320, 160]);
    expect(r.meta.cols).toBe(40);
    expect(r.meta.rows).toBe(20);
    expect(r.frames[0].pixels[0].slice(0, 3)).toEqual([255, 176, 0]); // #ffb000
    // 8 %: 255 * 0.08 = 20.4 -> 20, 176 * 0.08 = 14.08 -> 14
    expect(r.frames[0].pixels[1].slice(0, 3)).toEqual([20, 14, 0]);
    await guard.assertClean(expect);
  });

  test('every single-colour panel reaches its own colour at the top level', async ({ page }) => {
    await gotoApp(page);
    const want = { red: [255, 42, 26], amber: [255, 176, 0], green: [57, 255, 106], blue: [58, 140, 255], white: [255, 255, 255] };
    for (const [ledColor, rgb] of Object.entries(want)) {
      const r = await renderMode(page, { ...BASE, rects: [['#fff', 0, 0, 1, 1]], params: P({ ledColor }), pixels: [centre(3, 3)] });
      expect(r.frames[0].pixels[0].slice(0, 3), ledColor).toEqual(rgb);
    }
  });

  test('levels quantise the brightness: 128 grey with 6 levels is step 3 of 5, intensity 0.08 + 0.92 * 0.6', async ({ page }) => {
    await gotoApp(page);
    // luma 128/255 = 0.50196 -> round(0.50196 * 5) = 3 -> v = 0.6 -> intensity 0.632
    const mono = await renderMode(page, { ...BASE, rects: [['#808080', 0, 0, 1, 1]], params: P({ ledColor: 'amber', levels: 6 }), pixels: [centre(8, 8)] });
    expect(mono.frames[0].pixels[0].slice(0, 3)).toEqual([161, 111, 0]); // 255 * .632 = 161.2, 176 * .632 = 111.2
    const rgb = await renderMode(page, { ...BASE, rects: [['#808080', 0, 0, 1, 1]], params: P({ ledColor: 'rgb', levels: 6 }), pixels: [centre(8, 8)] });
    expect(rgb.frames[0].pixels[0].slice(0, 3)).toEqual([161, 161, 161]);
    // each RGB channel is quantised on its own: pure red keeps red at the top and the others off at 8 %
    const red = await renderMode(page, { ...BASE, rects: [['#ff0000', 0, 0, 1, 1]], params: P({ ledColor: 'rgb', levels: 6 }), pixels: [centre(8, 8)] });
    expect(red.frames[0].pixels[0].slice(0, 3)).toEqual([255, 20, 20]);
  });

  test('a ramp uses at most `levels` brightness steps (distinct SVG layers)', async ({ page }) => {
    await gotoApp(page);
    const ramp = Array.from({ length: 40 }, (_, i) => [`rgb(${Math.round(i * 255 / 39)},${Math.round(i * 255 / 39)},${Math.round(i * 255 / 39)})`, i / 40, 0, 1 / 40, 1]);
    for (const levels of [2, 4, 9]) {
      const svg = await svgOf(page, { ...BASE, rects: ramp, params: P({ ledColor: 'green', levels }) });
      expect(svg.parseError).toBeNull();
      const levelLayers = svg.layers.filter((l) => l.id.startsWith('level-'));
      expect(levelLayers.length, `levels ${levels}`).toBe(levels);
      // each LED is in exactly one level layer
      expect(levelLayers.reduce((a, l) => a + l.count, 0)).toBe(40 * 20);
    }
  });
});

test.describe('led: shape and glow', () => {
  test('the LED is smaller than its cell: the corner of the cell shows the panel colour', async ({ page }) => {
    await gotoApp(page);
    const r = await renderMode(page, {
      ...BASE, rects: [['#fff', 0, 0, 1, 1]], params: P({ ledColor: 'white', ledSize: 0.8, shape: 'round' }),
      pixels: [[0.5 / 320, 0.5 / 160], [4 / 320, 4 / 160], [8.5 / 320, 8.5 / 160]],
    });
    expect(r.frames[0].pixels[0].slice(0, 3)).toEqual([8, 9, 11]); // corner of the first cell: panel
    expect(r.frames[0].pixels[1].slice(0, 3)).toEqual([255, 255, 255]);
    expect(r.frames[0].pixels[2].slice(0, 3)).toEqual([8, 9, 11]); // corner of the next cell
    const square = await renderMode(page, { ...BASE, rects: [['#fff', 0, 0, 1, 1]], params: P({ ledColor: 'white', ledSize: 1, shape: 'square' }), pixels: [[0.5 / 320, 0.5 / 160]] });
    expect(square.frames[0].pixels[0].slice(0, 3)).toEqual([255, 255, 255]); // a full-size square LED fills its cell
  });

  test('glow lights the gap between LEDs; with glow 0 the gap stays at the panel colour', async ({ page }) => {
    await gotoApp(page);
    const at = [[0.5 / 320, 0.5 / 160]];
    const none = await renderMode(page, { ...BASE, rects: [['#fff', 0, 0, 1, 1]], params: P({ ledColor: 'white', glow: 0 }), pixels: at });
    const glow = await renderMode(page, { ...BASE, rects: [['#fff', 0, 0, 1, 1]], params: P({ ledColor: 'white', glow: 1 }), pixels: at });
    expect(none.frames[0].pixels[0][0]).toBe(8);
    expect(glow.frames[0].pixels[0][0]).toBeGreaterThan(40);
  });
});

test.describe('led: SVG', () => {
  test('writes a panel layer plus the LEDs with the declared size, as escaped valid SVG', async ({ page }) => {
    await gotoApp(page);
    const svg = await svgOf(page, { ...BASE, rects: [['#fff', 0, 0, 1, 1]], params: P({ ledColor: 'amber', ledSize: 0.8, levels: 4 }), title: '<b onclick=x> & "t"' });
    expect(svg.parseError).toBeNull();
    expect(svg.root).toEqual({ w: '320', h: '160', vb: '0 0 320 160' });
    expect(svg.layers[0]).toMatchObject({ id: 'panel', fill: '#08090b' });
    expect(svg.layers[1]).toMatchObject({ id: 'level-0', fill: '#ffb000', count: 800 });
    expect(svg.first).toMatchObject({ tag: 'circle', cx: 4, cy: 4, r: 3.2 }); // 0.8 * 8 / 2
    expect(svg.title).toBe('<b onclick=x> & "t"');
    expect(svg.forbidden).toBe(0);
    const sq = await svgOf(page, { ...BASE, rects: [['#fff', 0, 0, 1, 1]], params: P({ ledColor: 'amber', shape: 'square', ledSize: 0.5 }) });
    expect(sq.first).toMatchObject({ tag: 'rect' });
    const rgb = await svgOf(page, { ...BASE, rects: [['#ff0000', 0, 0, 1, 1]], params: P({ ledColor: 'rgb', levels: 6 }) });
    expect(rgb.layers.map((l) => l.id)).toEqual(['panel', 'leds']);
    expect(rgb.layers[1].count).toBe(800);
    expect(rgb.firstFill).toBe('#ff1414');
  });
});

async function svgOf(page, spec) {
  return page.evaluate(async (s) => {
    const { createPipeline } = await import('/src/engine/pipeline.js');
    const { getMode } = await import('/src/modes/index.js');
    const { defaultsOf } = await import('/src/state.js');
    const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
    const { COLOR_PARAMS } = await import('/src/engine/color.js');
    const c = document.createElement('canvas');
    c.width = s.width; c.height = s.height;
    const g = c.getContext('2d');
    for (const [colour, x, y, w, h] of s.rects) { g.fillStyle = colour; g.fillRect(x * s.width, y * s.height, w * s.width, h * s.height); }
    const source = { id: 'p', kind: 'image', width: s.width, height: s.height, version: Math.random(), animated: false, frame: () => c, dispose() {} };
    const mode = getMode('led');
    const pipe = createPipeline();
    const params = { global: { ...defaultsOf(IMAGE_PARAMS), ...s.params.global }, color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: { ...defaultsOf(mode.params), ...s.params.mode } };
    await pipe.render({ source, mode, params, theme: { ink: '#fff', bg: '#000' }, quality: 'full', isExport: true });
    const out = mode.toSVG(pipe.getState('led'), s.title ? { title: s.title } : {});
    const doc = new DOMParser().parseFromString(out, 'image/svg+xml');
    const layers = Array.from(doc.getElementsByTagName('g')).filter((e) => e.getAttribute('inkscape:groupmode') === 'layer').map((e) => ({
      id: e.getAttribute('id'), fill: e.getAttribute('fill'), count: e.children.length,
    }));
    const firstEl = doc.querySelector('g[id="level-0"] > *') || doc.querySelector('g[id="leds"] > *');
    return {
      parseError: doc.querySelector('parsererror') ? 'parsererror' : null, layers, title: doc.querySelector('title')?.textContent,
      forbidden: doc.querySelectorAll('img, script, foreignObject, [onclick], [onerror]').length,
      root: { w: doc.documentElement.getAttribute('width'), h: doc.documentElement.getAttribute('height'), vb: doc.documentElement.getAttribute('viewBox') },
      first: firstEl ? { tag: firstEl.tagName, cx: +firstEl.getAttribute('cx'), cy: +firstEl.getAttribute('cy'), r: +firstEl.getAttribute('r') } : null,
      firstFill: firstEl?.getAttribute('fill'),
    };
  }, spec);
}
