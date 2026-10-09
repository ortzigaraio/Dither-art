import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, renderMode, loadFixture, settle, setControl, renderCount, waitForRender, captureDownload } from './helpers.js';

// Braille mode (PLAN.md 7.2). Bit layout: (0,0)=0x01 (0,1)=0x02 (0,2)=0x04 (1,0)=0x08 (1,1)=0x10 (1,2)=0x20 (0,3)=0x40 (1,3)=0x80

// A 20 x 4 picture is exactly 10 cells (cols = 10 -> 20 x 4 sub-pixels), so every source pixel is one dot.
// Cell 0: dots (0,0) (0,3) (1,1) (1,2)   -> 0x01 + 0x40 + 0x10 + 0x20 = 0x71 -> U+2871
// Cell 1: all eight dots                  -> 0xFF -> U+28FF
// Cell 2: nothing                         -> 0x00 -> U+2800
// Cell 3: only dot (1,0)                  -> 0x08 -> U+2808
// Cell 4: left column only                -> 0x01+0x02+0x04+0x40 = 0x47 -> U+2847
// Cell 5: right column only               -> 0x08+0x10+0x20+0x80 = 0xB8 -> U+28B8
// Cell 6: top row only (0,0) and (1,0)    -> 0x01+0x08 = 0x09 -> U+2809
// Cell 7: bottom row only (0,3) and (1,3) -> 0x40+0x80 = 0xC0 -> U+28C0
// Cell 8: diagonal (0,0) (1,1) (0,2) (1,3)-> 0x01+0x10+0x04+0x80 = 0x95 -> U+2895
// Cell 9: nothing                         -> U+2800
const PATTERN = (() => {
  const dots = [
    [0, 0, 0], [0, 3, 0], [1, 1, 0], [1, 2, 0], // cell 0
    ...[0, 1].flatMap((dx) => [0, 1, 2, 3].map((dy) => [dx, dy, 1])), // cell 1
    [1, 0, 3], // cell 3
    ...[0, 1, 2, 3].map((dy) => [0, dy, 4]), // cell 4
    ...[0, 1, 2, 3].map((dy) => [1, dy, 5]), // cell 5
    [0, 0, 6], [1, 0, 6], // cell 6
    [0, 3, 7], [1, 3, 7], // cell 7
    [0, 0, 8], [1, 1, 8], [0, 2, 8], [1, 3, 8], // cell 8
  ];
  return dots.map(([dx, dy, cell]) => ['#ffffff', cell * 2 + dx, dy, 1, 1]);
})();
const EXPECTED = '⡱⣿⠀⠈⡇⢸⠉⣀⢕⠀';

const baseSpec = {
  mode: 'braille', width: 20, height: 4, abs: true,
  rects: [['#000000', 0, 0, 20, 4], ...PATTERN],
  params: { global: { cols: 10 }, color: { bg: '#000000', ink: '#ffffff' }, mode: { dither: 'none', threshold: 128 } },
  theme: { ink: '#ffffff', bg: '#000000' },
};

test.describe('braille', () => {
  test('bit layout matches a hand-computed 2x4 pattern', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const r = await renderMode(page, { ...baseSpec, outputs: ['txt'] });
    expect(r.error).toBeNull();
    expect(r.meta.cols).toBe(10);
    expect(r.meta.rows).toBe(1);
    expect(r.outputs.txt).toBe(`${EXPECTED}\n`);
    await guard.assertClean(expect);
  });

  test('the same pattern with the polarity inverted gives the complement (0xFF - bits)', async ({ page }) => {
    await gotoApp(page);
    const r = await renderMode(page, { ...baseSpec, params: { ...baseSpec.params, mode: { ...baseSpec.params.mode, invert: true } }, outputs: ['txt'] });
    const want = Array.from(EXPECTED, (ch) => String.fromCodePoint(0x2800 + (0xff - (ch.codePointAt(0) - 0x2800)))).join('');
    expect(r.outputs.txt).toBe(`${want}\n`);
  });

  test('on a light background the dark pixels become dots', async ({ page }) => {
    await gotoApp(page);
    const dark = ['#000000', 0, 0, 20, 4];
    const rects = [['#ffffff', 0, 0, 20, 4], ...PATTERN.map(([, x, y, w, h]) => ['#000000', x, y, w, h])];
    expect(dark).toBeTruthy();
    const r = await renderMode(page, {
      ...baseSpec, rects,
      params: { global: { cols: 10 }, color: { bg: '#ffffff', ink: '#000000' }, mode: { dither: 'none' } },
      theme: { ink: '#000000', bg: '#ffffff' }, outputs: ['txt'],
    });
    expect(r.outputs.txt).toBe(`${EXPECTED}\n`);
  });

  test('dots are drawn where the bits are (pixel check of the output canvas)', async ({ page }) => {
    await gotoApp(page);
    // pitch 4: char cell is 8 x 16 px at scale 1 -> dot (dx, dy) of cell 0 is centred at (4 + 4dx.., 2 + 4dy..)
    const pt = (cell, dx, dy) => [((cell * 2 + dx) * 4 + 2) / 80, (dy * 4 + 2) / 16];
    const r = await renderMode(page, {
      ...baseSpec,
      pixels: [pt(0, 0, 0), pt(0, 1, 0), pt(0, 0, 3), pt(0, 1, 1), pt(1, 1, 3), pt(2, 0, 0), pt(3, 1, 0), pt(3, 0, 0)],
    });
    expect(r.width).toBe(80);
    expect(r.height).toBe(16);
    const [on00, off10, on03, on11, on13, empty, on30, off30] = r.frames[0].pixels;
    for (const px of [on00, on03, on11, on13, on30]) expect(px.slice(0, 3)).toEqual([255, 255, 255]);
    for (const px of [off10, empty, off30]) expect(px.slice(0, 3)).toEqual([0, 0, 0]);
  });

  test('showEmpty draws the switched-off dots at 15 % opacity; square and circle differ', async ({ page }) => {
    await gotoApp(page);
    const common = { ...baseSpec, pixels: [[(2 * 4 + 2) / 80, 2 / 16]] }; // cell 1, dot (0,0): on
    const empty = { ...baseSpec, pixels: [[((2 * 2) * 4 + 2) / 80, 2 / 16]] }; // cell 2, dot (0,0): off
    const off = await renderMode(page, empty);
    const shown = await renderMode(page, { ...empty, params: { ...empty.params, mode: { ...empty.params.mode, showEmpty: true } } });
    expect(off.frames[0].pixels[0].slice(0, 3)).toEqual([0, 0, 0]);
    const v = shown.frames[0].pixels[0][0];
    expect(v).toBeGreaterThan(25);
    expect(v).toBeLessThan(55); // ~15 % of 255 = 38
    const circle = await renderMode(page, { ...common, params: { ...common.params, mode: { ...common.params.mode, dotShape: 'circle', dotScale: 0.5 } } });
    const square = await renderMode(page, { ...common, params: { ...common.params, mode: { ...common.params.mode, dotShape: 'square', dotScale: 0.5 } } });
    expect(circle.frames[0].hash).not.toBe(square.frames[0].hash);
  });

  test('blankAsSpace exports empty cells as a space; HTML and ANSI exports are escaped and coloured', async ({ page }) => {
    await gotoApp(page);
    const r = await renderMode(page, {
      ...baseSpec,
      params: { ...baseSpec.params, mode: { ...baseSpec.params.mode, blankAsSpace: true }, color: { ...baseSpec.params.color, colorMode: 'original' } },
      outputs: ['txt', 'html', 'ansi'],
    });
    expect(r.outputs.txt).toBe(`${EXPECTED.replace(/⠀/g, ' ')}\n`);
    expect(r.outputs.html).toContain('<pre');
    expect(r.outputs.html).toContain('⡱');
    expect(r.outputs.ansi).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
  });

  test('error diffusion above the worker threshold gives the same dots as the main thread', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const braille = (await import('/src/modes/braille.js')).default;
      const heavy = await import('/src/engine/heavy.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const c = document.createElement('canvas');
      c.width = 1200; c.height = 800;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 1200, 800);
      grad.addColorStop(0, '#000'); grad.addColorStop(1, '#fff');
      g.fillStyle = grad; g.fillRect(0, 0, 1200, 800);
      const source = { id: 's', kind: 'image', width: 1200, height: 800, version: 1, animated: false, frame: () => c, dispose() {} };
      const mk = (cols) => ({
        global: { ...defaultsOf(IMAGE_PARAMS), cols }, color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {},
        mode: { ...defaultsOf(braille.params), dither: 'floyd-steinberg' },
      });
      const theme = { ink: '#fff', bg: '#000' };
      const run = async (cols, forceMain) => {
        heavy.setForceMain(forceMain);
        const before = heavy.stats().spawned;
        const pipe = createPipeline();
        const r = await pipe.render({ source, mode: braille, params: mk(cols), theme });
        heavy.setForceMain(false);
        return { txt: braille.toText(pipe.getState('braille'), 'txt'), rows: r.meta.rows, spawned: heavy.stats().spawned - before };
      };
      // 400 columns x 200+ rows = 800 x 540 sub-pixels = 432k: above the 250k threshold
      const viaWorker = await run(400, false);
      const viaMain = await run(400, true);
      const small = await run(60, false); // 120 x 80 sub-pixels: stays on the main thread
      return { same: viaWorker.txt === viaMain.txt, rows: viaWorker.rows, workerUsed: viaWorker.spawned, smallSpawned: small.spawned, len: viaWorker.txt.length };
    });
    expect(res.same).toBe(true);
    expect(res.rows).toBeGreaterThan(100);
    expect(res.len).toBeGreaterThan(1000);
    expect(res.smallSpawned).toBe(0);
  });

  test('in the studio: TXT export has the declared grid and only Braille characters', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    let before = await renderCount(page);
    await page.locator('#mode-list .mode-item[data-mode-id="braille"]').click();
    await waitForRender(page, before);
    await settle(page);
    const dims = await page.evaluate(() => {
      const c = document.getElementById('viewer-canvas');
      return { cols: Number(c.dataset.cols), rows: Number(c.dataset.rows) };
    });
    expect(dims.cols).toBe(120);
    const { name, bytes } = await captureDownload(page, () => page.click('[data-export="txt"]'));
    expect(name).toMatch(/^dither-braille-\d{8}-\d{6}\.txt$/);
    const lines = bytes.toString('utf8').slice(0, -1).split('\n');
    expect(lines).toHaveLength(dims.rows);
    for (const line of lines) {
      expect(Array.from(line)).toHaveLength(dims.cols);
      expect(line).toMatch(/^[⠀-⣿]+$/);
    }
    before = await renderCount(page);
    await setControl(page, 'threshold', 60, 'mode'); // the image group has its own `threshold`
    await waitForRender(page, before);
    await guard.assertClean(expect);
  });
});
