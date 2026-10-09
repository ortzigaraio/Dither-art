// End-to-end colour correctness of the ASCII output: the colours on the canvas are the ones the settings promise.
import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers.js';

/** Render a synthetic source with the ASCII mode and return sampled pixels of the output. */
async function renderProbe(page, { params, rects, width = 300, height = 500, sample }) {
  return page.evaluate(async ({ params, rects, width, height, sample }) => {
    const { createPipeline } = await import('/src/engine/pipeline.js');
    const ascii = (await import('/src/modes/ascii.js')).default;
    const { ensureFonts } = await import('/src/engine/glyphs.js');
    const { defaultsOf } = await import('/src/state.js');
    const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
    const { COLOR_PARAMS } = await import('/src/engine/color.js');
    await ensureFonts('geist-mono', ' █░▒▓.#');
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const g = c.getContext('2d');
    // rects: [colour, x, y, w, h] as fractions of the picture (the CSP forbids eval, so no code strings)
    for (const [colour, x, y, w, h] of rects) {
      g.fillStyle = colour;
      g.fillRect(x * width, y * height, w * width, h * height);
    }
    const source = { id: 's', kind: 'image', width, height, version: Math.random(), animated: false, frame: () => c, dispose() {} };
    const pipe = createPipeline();
    const full = {
      global: { ...defaultsOf(IMAGE_PARAMS), cols: 40, ...(params.global || {}) },
      color: { ...defaultsOf(COLOR_PARAMS), ...(params.color || {}) },
      depth: {}, postfx: {},
      mode: { ...defaultsOf(ascii.params), ...(params.mode || {}) },
    };
    const r = await pipe.render({ source, mode: ascii, params: full, theme: { ink: '#c4f169', bg: '#15181e' } });
    const out = document.createElement('canvas');
    out.width = r.width;
    out.height = r.height;
    const og = out.getContext('2d', { willReadFrequently: true });
    og.drawImage(r.canvas, 0, 0);
    const px = (fx, fy) => Array.from(og.getImageData(Math.floor(fx * (r.width - 1)), Math.floor(fy * (r.height - 1)), 1, 1).data);
    const all = og.getImageData(0, 0, r.width, r.height).data;
    const hist = new Map();
    for (let i = 0; i < all.length; i += 4) {
      const k = `${all[i]},${all[i + 1]},${all[i + 2]},${all[i + 3]}`;
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    return { samples: sample.map(([x, y]) => px(x, y)), hist: Array.from(hist.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12), total: r.width * r.height };
  }, { params, rects, width, height, sample });
}

const SPLIT = [['#ff0000', 0, 0, 0.5, 1], ['#0000ff', 0.5, 0, 0.5, 1]];
const WHOLE = (colour) => [[colour, 0, 0, 1, 1]];
// two identical full blocks: every cell is drawn, whatever its luma
const FULL_BLOCKS = { gradient: 'custom', customGradient: '██', spaceDensity: 0, autoSort: false };

test.describe('colour output', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('mono: glyph pixels are exactly the ink and the rest exactly the background', async ({ page }) => {
    const r = await renderProbe(page, {
      params: { color: { ink: '#ff8800', bg: '#001122' }, mode: { gradient: 'blocks' } },
      rects: [['#000000', 0, 0, 0.5, 1], ['#ffffff', 0.5, 0, 0.5, 1]], // dark half: empty cells, bright half: full blocks
      sample: [[0.2, 0.5], [0.8, 0.5]],
    });
    expect(r.samples[0]).toEqual([0, 17, 34, 255]);
    expect(r.samples[1]).toEqual([255, 136, 0, 255]);
    // the two colours cover (almost) everything, in about equal parts; the shade blocks around the boundary
    // column are the only other values
    const [first, second, ...rest] = r.hist;
    expect([first[0], second[0]].sort()).toEqual(['0,17,34,255', '255,136,0,255']);
    expect(Math.abs(first[1] / r.total - 0.5)).toBeLessThan(0.06);
    expect(Math.abs(second[1] / r.total - 0.5)).toBeLessThan(0.06);
    expect(rest.reduce((a, [, n]) => a + n, 0) / r.total).toBeLessThan(0.08); // the filter spreads the edge over ~2 columns of 40
  });

  test('mono: thin glyphs blend the ink into the background without leaving the two end colours', async ({ page }) => {
    const r = await renderProbe(page, {
      params: { color: { ink: '#ff8800', bg: '#001122' }, mode: { gradient: 'standard' } },
      rects: WHOLE('#ffffff'),
      sample: [[0.5, 0.5]],
    });
    expect(r.hist.length).toBeGreaterThan(2); // anti-aliasing produces intermediate values
    for (const [k] of r.hist) {
      const [R, G, B, A] = k.split(',').map(Number);
      expect(A).toBe(255);
      // every pixel lies on the segment bg -> ink: R from 0 to 255, G from 17 to 136, B from 34 to 0
      const t = R / 255;
      expect(Math.abs(G - (17 + (136 - 17) * t))).toBeLessThanOrEqual(2);
      expect(Math.abs(B - (34 * (1 - t)))).toBeLessThanOrEqual(2);
    }
  });

  test('mono: bright pixels get the denser glyph on a dark background', async ({ page }) => {
    const dark = await renderProbe(page, {
      params: { color: { ink: '#ffffff', bg: '#000000' }, mode: FULL_BLOCKS },
      rects: [['#000000', 0, 0, 1, 1], ['#ffffff', 0.5, 0, 0.5, 1]],
      sample: [[0.2, 0.5], [0.8, 0.5]],
    });
    // custom gradient with one glyph: ' ' for the darkest level (spaceDensity 0 removes it), so use the standard check below
    expect(dark.samples).toHaveLength(2);
    const std = await renderProbe(page, {
      params: { color: { ink: '#ffffff', bg: '#000000' }, mode: { gradient: 'blocks' } },
      rects: [['#000000', 0, 0, 0.5, 1], ['#ffffff', 0.5, 0, 0.5, 1]],
      sample: [[0.2, 0.5], [0.8, 0.5]],
    });
    expect(std.samples[0][0]).toBeLessThan(10); // black half: empty cell, background
    expect(std.samples[1][0]).toBeGreaterThan(245); // white half: full block, ink
  });

  test('original colour: each cell takes the colour of its part of the picture', async ({ page }) => {
    const r = await renderProbe(page, {
      params: { color: { colorMode: 'original', bg: '#000000' }, mode: FULL_BLOCKS },
      rects: SPLIT,
      sample: [[0.2, 0.5], [0.8, 0.5]],
    });
    expect(r.samples[0]).toEqual([255, 0, 0, 255]);
    expect(r.samples[1]).toEqual([0, 0, 255, 255]);
  });

  test('original colour: output saturation 0 turns the colours grey, 200 keeps them saturated', async ({ page }) => {
    const grey = await renderProbe(page, {
      params: { color: { colorMode: 'original', colorBoost: 0, bg: '#000000' }, mode: FULL_BLOCKS },
      rects: SPLIT,
      sample: [[0.2, 0.5], [0.8, 0.5]],
    });
    for (const s of grey.samples) {
      expect(s[0]).toBe(s[1]);
      expect(s[1]).toBe(s[2]);
    }
    const vivid = await renderProbe(page, {
      params: { color: { colorMode: 'original', colorBoost: 200, bg: '#000000' }, mode: FULL_BLOCKS },
      rects: WHOLE('#c06060'),
      sample: [[0.5, 0.5]],
    });
    const plain = await renderProbe(page, {
      params: { color: { colorMode: 'original', colorBoost: 100, bg: '#000000' }, mode: FULL_BLOCKS },
      rects: WHOLE('#c06060'),
      sample: [[0.5, 0.5]],
    });
    expect(vivid.samples[0][0] - vivid.samples[0][1]).toBeGreaterThan(plain.samples[0][0] - plain.samples[0][1]);
  });

  test('gradient: colours come from the stops by luminosity', async ({ page }) => {
    const r = await renderProbe(page, {
      params: { color: { colorMode: 'gradient', gradStops: ['#000000', '#ff0000'], bg: '#101010' }, mode: FULL_BLOCKS },
      rects: [['#ffffff', 0, 0, 0.5, 1], ['#555555', 0.5, 0, 0.5, 1]],
      sample: [[0.2, 0.5], [0.8, 0.5]],
    });
    const [bright, mid] = r.samples;
    expect(bright).toEqual([255, 0, 0, 255]); // luma 1 -> last stop
    expect(mid[0]).toBeGreaterThan(60);
    expect(mid[0]).toBeLessThan(110); // luma 0.33 -> a third of the way to red
    expect(mid[1]).toBe(0);
    expect(mid[2]).toBe(0);
  });

  test('palette: every glyph pixel is a palette colour', async ({ page }) => {
    const r = await renderProbe(page, {
      params: { color: { colorMode: 'palette', palette: 'ega16', bg: '#000000' }, mode: FULL_BLOCKS },
      rects: [...SPLIT, ['#808000', 0, 0, 1, 0.25]],
      sample: [[0.2, 0.9], [0.8, 0.9], [0.2, 0.05]],
    });
    const ega = new Set(['0,0,0', '0,0,170', '0,170,0', '0,170,170', '170,0,0', '170,0,170', '170,85,0', '170,170,170', '85,85,85', '85,85,255', '85,255,85', '85,255,255', '255,85,85', '255,85,255', '255,255,85', '255,255,255']);
    for (const s of r.samples) expect(ega.has(s.slice(0, 3).join(',')), `pixel ${s}`).toBe(true);
    // red and blue land on different palette entries
    expect(r.samples[0].join()).not.toBe(r.samples[1].join());
  });

  test('palette: a custom list is parsed from text (invalid entries ignored)', async ({ page }) => {
    const r = await renderProbe(page, {
      params: { color: { colorMode: 'palette', palette: 'custom', customPalette: '#ff00ff, nope, #00ffff', bg: '#000000' }, mode: FULL_BLOCKS },
      rects: SPLIT,
      sample: [[0.2, 0.5], [0.8, 0.5]],
    });
    const allowed = new Set(['255,0,255', '0,255,255']);
    for (const s of r.samples) expect(allowed.has(s.slice(0, 3).join(','))).toBe(true);
  });

  test('transparent background: empty cells have alpha 0 and glyph pixels keep their colour', async ({ page }) => {
    const r = await renderProbe(page, {
      params: { color: { colorMode: 'original', bgTransparent: true }, mode: { ...FULL_BLOCKS, gradient: 'blocks', customGradient: ' █', spaceDensity: 1 } },
      rects: [['#000000', 0, 0, 0.5, 1], ['#ff0000', 0.5, 0, 0.5, 1]],
      sample: [[0.2, 0.5], [0.8, 0.5]],
    });
    expect(r.samples[0][3]).toBe(0); // dark left half: empty cell on a transparent background
    expect(r.samples[1].slice(0, 3)).toEqual([255, 0, 0]);
    expect(r.samples[1][3]).toBeGreaterThan(0);
  });
});
