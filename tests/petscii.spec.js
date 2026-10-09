import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, renderMode, loadFixture, settle, renderCount, waitForRender, captureDownload } from './helpers.js';

// PETSCII mode (PLAN.md 7.4): own 8x8 glyph set, palette colours only, one global background

test.describe('petscii: glyph set', () => {
  test('about 96 unique original 8x8 bitmaps in four sets, empty first', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { GLYPHS, GLYPH_COUNT, GLYPH_BYTES, GLYPH_SETS, enabledMask } = await import('/src/engine/petscii.js');
      const keys = GLYPHS.map((g) => Array.from(g.rows).join(','));
      const perSet = Object.fromEntries(GLYPH_SETS.map((s) => [s, GLYPHS.filter((g) => g.set === s).length]));
      return {
        count: GLYPH_COUNT, bytes: GLYPH_BYTES.length, unique: new Set(keys).size, ids: new Set(GLYPHS.map((g) => g.id)).size,
        first: GLYPHS[0].id, second: GLYPHS[1].id, perSet, sets: GLYPH_SETS,
        onlyBlocks: Array.from(enabledMask(['blocks'])).reduce((a, b) => a + b, 0),
        none: Array.from(enabledMask([])).reduce((a, b) => a + b, 0),
      };
    });
    expect(res.count).toBeGreaterThanOrEqual(90);
    expect(res.count).toBeLessThanOrEqual(100);
    expect(res.bytes).toBe(res.count * 8);
    expect(res.unique).toBe(res.count); // no duplicate bitmaps
    expect(res.ids).toBe(res.count);
    expect(res.first).toBe('empty');
    expect(res.second).toBe('full');
    for (const s of res.sets) expect(res.perSet[s], s).toBeGreaterThanOrEqual(15);
    expect(res.onlyBlocks).toBe(res.perSet.blocks);
    expect(res.none).toBe(2); // "empty" and "full" are always available
  });

  test('exact glyph bitmaps for simple shapes', async ({ page }) => {
    await gotoApp(page);
    const rows = await page.evaluate(async () => {
      const { GLYPHS } = await import('/src/engine/petscii.js');
      const get = (id) => Array.from(GLYPHS.find((g) => g.id === id).rows);
      return { full: get('full'), top: get('half-top'), left: get('half-left'), tl: get('quad-tl'), bar3: get('bar-left-3'), h3: get('line-h-3'), tri: get('tri-bl') };
    });
    expect(rows.full).toEqual(Array(8).fill(0xff));
    expect(rows.top).toEqual([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);
    expect(rows.left).toEqual(Array(8).fill(0xf0));
    expect(rows.tl).toEqual([0xf0, 0xf0, 0xf0, 0xf0, 0, 0, 0, 0]);
    expect(rows.bar3).toEqual(Array(8).fill(0xe0));
    expect(rows.h3).toEqual([0, 0, 0, 0xff, 0, 0, 0, 0]);
    expect(rows.tri).toEqual([0x80, 0xc0, 0xe0, 0xf0, 0xf8, 0xfc, 0xfe, 0xff]); // x <= y
  });

  test('Unicode approximation: exact for blocks, lines and diagonals', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { GLYPHS, glyphToUnicode } = await import('/src/engine/petscii.js');
      const u = (id) => glyphToUnicode(GLYPHS.find((g) => g.id === id).index);
      const all = GLYPHS.map((g) => glyphToUnicode(g.index));
      return {
        pairs: Object.fromEntries(['empty', 'full', 'half-top', 'half-bottom', 'half-left', 'half-right', 'quad-tl', 'line-h-3', 'line-v-3', 'cross', 'slash', 'backslash', 'tri-bl', 'bar-bottom-2', 'heart'].map((id) => [id, u(id)])),
        allSingle: all.every((c) => Array.from(c).length === 1),
      };
    });
    expect(res.pairs).toEqual({
      empty: ' ', full: '█', 'half-top': '▀', 'half-bottom': '▄', 'half-left': '▌', 'half-right': '▐', 'quad-tl': '▘',
      'line-h-3': '─', 'line-v-3': '│', cross: '┼', slash: '╱', backslash: '╲', 'tri-bl': '◣', 'bar-bottom-2': '▂', heart: '♥',
    });
    expect(res.allSingle).toBe(true);
  });
});

/** Render a synthetic picture with petscii and read the canvas back together with the JSON export. */
async function renderPetscii(page, { picture, cols = 10, mode = {}, width = 80, height = 40, outScale = 1, force = null, wantData = true }) {
  return page.evaluate(async (a) => {
    const { createPipeline } = await import('/src/engine/pipeline.js');
    const petscii = (await import('/src/modes/petscii.js')).default;
    const heavy = await import('/src/engine/heavy.js');
    const { defaultsOf } = await import('/src/state.js');
    const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
    const { COLOR_PARAMS } = await import('/src/engine/color.js');
    const c = document.createElement('canvas');
    c.width = a.width; c.height = a.height;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    for (const op of a.picture) {
      if (op.rect) { g.fillStyle = op.rect[0]; g.fillRect(...op.rect.slice(1)); }
      if (op.tri) { g.fillStyle = op.tri[0]; g.beginPath(); op.tri.slice(1).reduce((_, v, i, arr) => { if (i % 2 === 0) (i === 0 ? g.moveTo : g.lineTo).call(g, v, arr[i + 1]); return 0; }, 0); g.closePath(); g.fill(); }
      if (op.grad) { const gr = g.createLinearGradient(0, 0, a.width, a.height); gr.addColorStop(0, op.grad[0]); gr.addColorStop(1, op.grad[1]); g.fillStyle = gr; g.fillRect(0, 0, a.width, a.height); }
    }
    const source = { id: 's', kind: 'image', width: a.width, height: a.height, version: Math.random(), animated: false, frame: () => c, dispose() {} };
    const params = {
      global: { ...defaultsOf(IMAGE_PARAMS), cols: a.cols }, color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {},
      mode: { ...defaultsOf(petscii.params), grid: 'custom', customCols: a.cols, ...a.mode },
    };
    if (a.force !== null) heavy.setForceMain(a.force);
    const spawnedBefore = heavy.stats().spawned;
    const pipe = createPipeline();
    const r = await pipe.render({ source, mode: petscii, params, theme: { ink: '#fff', bg: '#000' }, outScale: a.outScale });
    heavy.setForceMain(false);
    const out = document.createElement('canvas');
    out.width = r.width; out.height = r.height;
    const og = out.getContext('2d', { willReadFrequently: true });
    og.drawImage(r.canvas, 0, 0);
    const data = a.wantData ? Array.from(og.getImageData(0, 0, out.width, out.height).data) : null;
    return {
      width: r.width, height: r.height, meta: r.meta, error: r.error ? String(r.error) : null,
      json: JSON.parse(petscii.toJSON(pipe.getState('petscii'))), txt: petscii.toText(pipe.getState('petscii'), 'txt'),
      data, workerSpawned: heavy.stats().spawned - spawnedBefore,
    };
  }, { picture, cols, mode, width, height, outScale, force, wantData });
}

const hexOf = (d, i) => `#${[d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

test.describe('petscii: matching and colours', () => {
  test('simple shapes are matched to exactly the glyphs that draw them', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    // 10 x 5 cells over a black screen; white shapes inside chosen cells
    const picture = [
      { rect: ['#000000', 0, 0, 80, 40] },
      { rect: ['#ffffff', 8, 8, 8, 8] }, // cell (1,1): full
      { rect: ['#ffffff', 24, 16, 4, 8] }, // cell (3,2): left half
      { rect: ['#ffffff', 40, 24, 4, 4] }, // cell (5,3): top-left quadrant
      { rect: ['#ffffff', 56, 8, 8, 1] }, // cell (7,1): top line (y = 0)
    ];
    const r = await renderPetscii(page, { picture });
    expect(r.error).toBeNull();
    expect(r.meta.cols).toBe(10);
    expect(r.meta.rows).toBe(5);
    const idOf = (cell) => r.json.glyphs[r.json.cells[cell]].id;
    expect(idOf(1 * 10 + 1)).toBe('full');
    expect(idOf(2 * 10 + 3)).toBe('half-left');
    expect(idOf(3 * 10 + 5)).toBe('quad-tl');
    expect(idOf(1 * 10 + 7)).toBe('line-h-0');
    expect(idOf(0)).toBe('empty');
    const white = r.json.palette.indexOf('#ffffff');
    for (const cell of [11, 23, 35, 17]) expect(r.json.colors[cell]).toBe(white);
    expect(r.json.background).toBe(r.json.palette.indexOf('#000000'));
    await guard.assertClean(expect);
  });

  test('output uses only palette colours, one global background, and equals the JSON cell by cell', async ({ page }) => {
    await gotoApp(page);
    const picture = [{ grad: ['#102a60', '#f0d070'] }, { rect: ['#3a9a3a', 10, 8, 30, 20] }, { rect: ['#ffffff', 50, 5, 18, 12] }];
    for (const paletteSet of ['c64', 'vic20', 'pet']) {
      const r = await renderPetscii(page, { picture, cols: 10, width: 160, height: 80, mode: { paletteSet, border: false } });
      expect(r.error).toBeNull();
      const palette = r.json.palette;
      const { cols, rows } = r.json;
      expect(r.width).toBe(cols * 8);
      expect(r.height).toBe(rows * 8);
      const seen = new Set();
      let mismatches = 0;
      const bgHex = palette[r.json.background];
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const cell = cy * cols + cx;
          const rowsBytes = r.json.glyphs[r.json.cells[cell]].rows;
          for (let py = 0; py < 8; py++) {
            for (let px = 0; px < 8; px++) {
              const on = (rowsBytes[py] & (0x80 >> px)) !== 0;
              const o = ((cy * 8 + py) * r.width + cx * 8 + px) * 4;
              const hex = hexOf(r.data, o);
              seen.add(hex);
              const want = on ? palette[r.json.colors[cell]] : bgHex;
              if (hex.toLowerCase() !== want.toLowerCase() || r.data[o + 3] !== 255) mismatches++;
            }
          }
        }
      }
      expect(mismatches, paletteSet).toBe(0);
      for (const hex of seen) expect(palette.map((p) => p.toLowerCase()), `${paletteSet} ${hex}`).toContain(hex.toLowerCase());
      expect(r.json.colors.every((c) => c >= 0 && c < palette.length)).toBe(true);
      expect(typeof r.json.background).toBe('number'); // exactly one background for the whole screen
      if (paletteSet === 'pet') expect(palette).toHaveLength(2);
    }
  });

  test('manual background colour is honoured; automatic picks the most frequent colour', async ({ page }) => {
    await gotoApp(page);
    // mostly C64 blue (#352879 = index 6) with a little white
    const picture = [{ rect: ['#352879', 0, 0, 80, 40] }, { rect: ['#ffffff', 8, 8, 8, 8] }];
    const auto = await renderPetscii(page, { picture, mode: { bgColor: 'auto' } });
    expect(auto.json.background).toBe(6);
    const manual = await renderPetscii(page, { picture, mode: { bgColor: '2' } });
    expect(manual.json.background).toBe(2);
    // the rest of the screen is still reproduced: fg colour per cell is blue on the manual (red) background
    expect(manual.json.colors[0]).toBe(6);
    expect(hexOf(manual.data, 0)).toBe(auto.json.palette[6].toLowerCase()); // cell 0: a full glyph in blue
  });

  test('glyph sets can be switched off', async ({ page }) => {
    await gotoApp(page);
    const picture = [{ grad: ['#000000', '#ffffff'] }, { rect: ['#ffffff', 20, 10, 25, 20] }];
    const all = await renderPetscii(page, { picture, cols: 20 });
    const onlyBlocks = await renderPetscii(page, { picture, cols: 20, mode: { useLines: false, useDiagonals: false, useRounds: false } });
    const none = await renderPetscii(page, { picture, cols: 20, mode: { useBlocks: false, useLines: false, useDiagonals: false, useRounds: false } });
    const sets = (r) => new Set(r.json.cells.map((g) => r.json.glyphs[g].set));
    expect(sets(onlyBlocks).size).toBe(1);
    expect(sets(onlyBlocks).has('blocks')).toBe(true);
    expect(sets(all).size).toBeGreaterThan(1);
    const ids = new Set(none.json.cells.map((g) => none.json.glyphs[g].id));
    for (const id of ids) expect(['empty', 'full']).toContain(id);
  });

  test('integer scale, C64 border and the TXT export', async ({ page }) => {
    await gotoApp(page);
    const picture = [{ rect: ['#000000', 0, 0, 80, 40] }, { rect: ['#ffffff', 8, 8, 8, 8] }];
    const plain = await renderPetscii(page, { picture, mode: { border: false } });
    expect(plain.width).toBe(80);
    expect(plain.height).toBe(40);
    const framed = await renderPetscii(page, { picture, mode: { border: true, borderColor: '14' } });
    expect(framed.width).toBe(80 + 64);
    expect(framed.height).toBe(40 + 64);
    expect(hexOf(framed.data, 0)).toBe(framed.json.palette[14].toLowerCase()); // corner = border colour
    const x2 = await renderPetscii(page, { picture, outScale: 2, mode: { border: false } });
    expect(x2.width).toBe(160); // whole-pixel blocks
    const lines = plain.txt.slice(0, -1).split('\n');
    expect(lines).toHaveLength(5);
    for (const l of lines) expect(Array.from(l)).toHaveLength(10);
    expect(lines[1][1]).toBe('█');
    expect(lines[0][0]).toBe(' ');
  });

  test('grids above 40x25 are matched in the worker, with the same result as the main thread', async ({ page }) => {
    await gotoApp(page);
    const picture = [{ grad: ['#102a60', '#f0d070'] }, { rect: ['#3a9a3a', 40, 30, 120, 60] }, { rect: ['#ffffff', 200, 20, 60, 40] }];
    const args = { picture, cols: 60, width: 480, height: 300, wantData: false }; // 60 x 38 = 2280 cells > 1000
    const viaWorker = await renderPetscii(page, { ...args, force: false });
    const viaMain = await renderPetscii(page, { ...args, force: true });
    expect(viaWorker.workerSpawned).toBeGreaterThanOrEqual(0);
    expect(viaWorker.json.cells).toEqual(viaMain.json.cells);
    expect(viaWorker.json.colors).toEqual(viaMain.json.colors);
    expect(viaWorker.json.background).toBe(viaMain.json.background);
    expect(viaWorker.json.cells.length).toBe(60 * 38);
    // the small default grid (40x25 = 1000 cells at most) does not touch the worker
    const small = await renderPetscii(page, { picture, cols: 40, width: 320, height: 200, force: false, wantData: false });
    expect(small.meta.rows).toBe(25);
    expect(small.workerSpawned).toBe(0);
  });
});

test.describe('petscii: in the studio', () => {
  test('exports are exactly PNG, TXT and JSON; JSON is a valid screen description; global cols are hidden', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const before = await renderCount(page);
    await page.locator('#mode-list .mode-item[data-mode-id="petscii"]').click();
    await waitForRender(page, before);
    await settle(page);
    await expect(page.locator('[data-export="png"]')).toBeVisible();
    await expect(page.locator('[data-export="txt"]')).toBeVisible();
    await expect(page.locator('[data-export="json"]')).toBeVisible();
    for (const k of ['html', 'ansi', 'ans', 'svg']) await expect(page.locator(`[data-export="${k}"]`)).toHaveCount(0);
    await expect(page.locator('#controls [data-param="cols"]')).toHaveCount(0);
    const { name, bytes } = await captureDownload(page, () => page.click('[data-export="json"]'));
    expect(name).toMatch(/^dither-petscii-\d{8}-\d{6}\.json$/);
    const j = JSON.parse(bytes.toString('utf8'));
    expect(j.format).toBe('dither-petscii');
    expect(j.cols).toBe(40);
    expect(j.cells).toHaveLength(j.cols * j.rows);
    expect(j.colors).toHaveLength(j.cols * j.rows);
    expect(Number.isInteger(j.background)).toBe(true);
    await guard.assertClean(expect);
  });
});
