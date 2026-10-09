import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, renderMode } from './helpers.js';

// Halftone (PLAN.md 7.8). Source 480x240 with cell 8: the work buffer is 160x80 (3 px per sample), the logical output
// is 480x240 and, at angle 0, the screen has exactly 60 x 30 dot centres inside the picture.

const BASE = { mode: 'halftone', width: 480, height: 240 };
const monoP = (extra = {}) => ({ halftoneMode: 'mono', cellSize: 8, angle: 0, paper: '#ffffff', ink: '#000000', ...extra });

/** Parse the SVG exported after a render and summarise its layers. */
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
    const mode = getMode('halftone');
    const pipe = createPipeline();
    const params = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: { ...defaultsOf(mode.params), ...s.mode } };
    const r = await pipe.render({ source, mode, params, theme: { ink: '#fff', bg: '#000' }, quality: 'full', isExport: true });
    const svg = mode.toSVG(pipe.getState('halftone'), s.opts || {});
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const parseError = doc.querySelector('parsererror') ? doc.querySelector('parsererror').textContent : null;
    const layers = Array.from(doc.getElementsByTagName('g')).filter((e) => e.getAttribute('inkscape:groupmode') === 'layer').map((e) => ({
      id: e.getAttribute('id'), label: e.getAttribute('inkscape:label'), fill: e.getAttribute('fill'), style: e.getAttribute('style'),
      shapes: Array.from(e.children).map((k) => ({ tag: k.tagName, cx: +k.getAttribute('cx'), cy: +k.getAttribute('cy'), r: +k.getAttribute('r'), d: k.getAttribute('d') })),
    }));
    return {
      error: r.error ? String(r.error) : null, svg, parseError, layers, title: doc.querySelector('title')?.textContent,
      forbidden: doc.querySelectorAll('img, script, foreignObject, [onerror], [onload]').length,
      root: { w: doc.documentElement.getAttribute('width'), h: doc.documentElement.getAttribute('height'), vb: doc.documentElement.getAttribute('viewBox') },
    };
  }, spec);
}

const inside = (L, w, h) => L.shapes.filter((s) => s.cx >= 0 && s.cx <= w && s.cy >= 0 && s.cy <= h);

test.describe('halftone: dots', () => {
  test('a 50 % grey prints dots of exactly half the cell area (r = c * sqrt(a / pi)), one per screen cell', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const r = await svgOf(page, { ...BASE, rects: [['#808080', 0, 0, 1, 1]], mode: monoP() });
    expect(r.error).toBeNull();
    expect(r.parseError).toBeNull();
    const ink = r.layers.find((l) => l.id === 'ink-ink');
    const dots = inside(ink, 480, 240);
    expect(dots.length).toBe(60 * 30);
    // a = 1 - 128/255 = 0.49804 -> r = 8 * sqrt(0.49804 / pi) = 3.185
    const want = 8 * Math.sqrt((1 - 128 / 255) / Math.PI);
    for (const d of dots) expect(d.r).toBeCloseTo(want, 1);
    expect(dots[0].cx).toBeCloseTo(4, 5); // first centre at half a cell
    expect(dots[0].cy).toBeCloseTo(4, 5);
    expect(r.root).toEqual({ w: '480', h: '240', vb: '0 0 480 240' });
    await guard.assertClean(expect);
  });

  test('black fills the cell (r = c / sqrt 2) and white prints no dot', async ({ page }) => {
    await gotoApp(page);
    const r = await svgOf(page, { ...BASE, rects: [['#fff', 0, 0, 1, 1], ['#000', 0, 0, 0.5, 1]], mode: monoP() });
    const ink = r.layers.find((l) => l.id === 'ink-ink');
    const dots = inside(ink, 480, 240);
    expect(dots.length).toBe(30 * 30); // only the left half carries ink
    for (const d of dots) expect(d.cx).toBeLessThan(240);
    // away from the picture border (where the resampling filter leaves a 0.2 % residue, and r(a) is steep near 1)
    const core = dots.filter((d) => d.cy > 12 && d.cy < 228 && d.cx > 12 && d.cx < 228);
    expect(core.length).toBeGreaterThan(500);
    for (const d of core) expect(d.r).toBeCloseTo(8 * Math.SQRT1_2, 1);
  });

  test('the rendered canvas has the right tone: black region dark, white region paper, 50 % grey about half ink', async ({ page }) => {
    await gotoApp(page);
    const r = await renderMode(page, {
      ...BASE, rects: [['#fff', 0, 0, 1, 1], ['#000', 0, 0, 0.25, 1], ['#808080', 0.5, 0, 0.25, 1]], params: { mode: monoP() },
      means: [[0.02, 0.1, 0.23, 0.9], [0.77, 0.1, 0.98, 0.9], [0.52, 0.1, 0.73, 0.9]],
    });
    const [black, white, grey] = r.frames[0].means;
    expect(black).toBeLessThan(0.05);
    expect(white).toBeGreaterThan(0.98);
    expect(grey).toBeGreaterThan(0.4);
    expect(grey).toBeLessThan(0.6);
    expect([r.width, r.height]).toEqual([480, 240]);
  });
});

test.describe('halftone: SVG', () => {
  test('CMYK writes paper + one layer per ink in print order; a pure cyan only inks the cyan layer', async ({ page }) => {
    await gotoApp(page);
    const r = await svgOf(page, { ...BASE, rects: [['#00ffff', 0, 0, 1, 1]], mode: { halftoneMode: 'cmyk', cellSize: 8, paper: '#ffffff' } });
    expect(r.parseError).toBeNull();
    expect(r.layers.map((l) => l.id)).toEqual(['paper', 'ink-cyan', 'ink-magenta', 'ink-yellow', 'ink-black']);
    expect(r.layers.map((l) => l.label)).toEqual(['Paper', 'Cyan', 'Magenta', 'Yellow', 'Black']);
    expect(r.layers.map((l) => l.fill)).toEqual(['#ffffff', '#00aeef', '#ec008c', '#fff200', '#231f20']);
    expect(r.layers.slice(1).every((l) => l.style === 'mix-blend-mode:multiply')).toBe(true);
    expect(r.layers[1].shapes.length).toBeGreaterThan(500);
    for (const l of r.layers.slice(2)) expect(l.shapes.length, l.id).toBe(0);
  });

  test('a neutral grey is printed with the black plate only; a pure red with magenta and yellow', async ({ page }) => {
    await gotoApp(page);
    const grey = await svgOf(page, { ...BASE, rects: [['#808080', 0, 0, 1, 1]], mode: { halftoneMode: 'cmyk', cellSize: 8 } });
    const counts = Object.fromEntries(grey.layers.map((l) => [l.id, l.shapes.length]));
    expect(counts['ink-black']).toBeGreaterThan(500);
    expect(counts['ink-cyan'] + counts['ink-magenta'] + counts['ink-yellow']).toBe(0);
    const red = await svgOf(page, { ...BASE, rects: [['#ff0000', 0, 0, 1, 1]], mode: { halftoneMode: 'cmyk', cellSize: 8 } });
    const rc = Object.fromEntries(red.layers.map((l) => [l.id, l.shapes.length]));
    expect(rc['ink-magenta']).toBeGreaterThan(500);
    expect(rc['ink-yellow']).toBeGreaterThan(500);
    expect(rc['ink-cyan'] + rc['ink-black']).toBe(0);
  });

  test('RGB is additive over a black layer; duotone has two ink layers', async ({ page }) => {
    await gotoApp(page);
    const rgb = await svgOf(page, { ...BASE, rects: [['#ff0000', 0, 0, 1, 1]], mode: { halftoneMode: 'rgb', cellSize: 8 } });
    expect(rgb.layers.map((l) => l.id)).toEqual(['paper', 'ink-red', 'ink-green', 'ink-blue']);
    expect(rgb.layers[0].fill).toBe('#000000');
    expect(rgb.layers[1].shapes.length).toBeGreaterThan(500);
    expect(rgb.layers[2].shapes.length + rgb.layers[3].shapes.length).toBe(0);
    expect(rgb.layers[1].style).toBe('mix-blend-mode:screen');
    const duo = await svgOf(page, { ...BASE, rects: [['#404040', 0, 0, 1, 1]], mode: { halftoneMode: 'duotone', cellSize: 8, ink: '#102040', ink2: '#ff3366' } });
    expect(duo.layers.map((l) => l.id)).toEqual(['paper', 'ink-ink2', 'ink-ink']);
    expect(duo.layers.map((l) => l.fill)).toEqual([expect.any(String), '#ff3366', '#102040']);
  });

  test('every shape exports its own element type; text is escaped and nothing active is written', async ({ page }) => {
    await gotoApp(page);
    const tags = {};
    for (const shape of ['circle', 'square', 'diamond', 'line', 'cross', 'ellipse']) {
      const r = await svgOf(page, { ...BASE, rects: [['#606060', 0, 0, 1, 1]], mode: monoP({ shape }) });
      expect(r.parseError, shape).toBeNull();
      tags[shape] = new Set(r.layers[1].shapes.map((s) => s.tag));
    }
    expect([...tags.circle]).toEqual(['circle']);
    expect([...tags.ellipse]).toEqual(['ellipse']);
    for (const s of ['square', 'diamond', 'line', 'cross']) expect([...tags[s]], s).toEqual(['path']);
    const hostile = `<img src=x onerror=alert(1)> & "q" 'a'</title><script>x()</script>`;
    const r = await svgOf(page, { ...BASE, rects: [['#808080', 0, 0, 1, 1]], mode: monoP(), opts: { title: hostile } });
    expect(r.parseError).toBeNull();
    expect(r.title).toBe(hostile); // round-trips as text: it was escaped
    expect(r.forbidden).toBe(0);
    expect(r.svg).not.toContain('<script');
    expect(r.svg).not.toContain('<img');
  });

  test('jitter and misregistration are deterministic for a seed and different for another', async ({ page }) => {
    await gotoApp(page);
    const run = (seed) => renderMode(page, { ...BASE, rects: [['#808080', 0, 0, 1, 1]], params: { mode: monoP({ jitter: 0.8, seed }) } });
    const a = await run(5);
    const b = await run(5);
    const c = await run(6);
    expect(a.frames[0].hash).toBe(b.frames[0].hash);
    expect(a.frames[0].hash).not.toBe(c.frames[0].hash);
    const plain = await renderMode(page, { ...BASE, rects: [['#ff4020', 0, 0, 1, 1]], params: { mode: { halftoneMode: 'cmyk', cellSize: 8, misregistration: 0 } } });
    const slip = await renderMode(page, { ...BASE, rects: [['#ff4020', 0, 0, 1, 1]], params: { mode: { halftoneMode: 'cmyk', cellSize: 8, misregistration: 3 } } });
    expect(plain.frames[0].hash).not.toBe(slip.frames[0].hash); // the black plate stays put, the colour plates slip
  });
});
