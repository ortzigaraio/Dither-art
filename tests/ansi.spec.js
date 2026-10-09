import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, renderMode, loadFixture, settle, renderCount, waitForRender, captureDownload } from './helpers.js';

// ANSI Art mode (PLAN.md 7.3): half blocks, shading, .ans in CP437

const strip = (bytes) => {
  // remove ESC [ ... m sequences and CR LF, keep the character bytes
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x1b && bytes[i + 1] === 0x5b) { while (bytes[i] !== 0x6d) i++; continue; }
    if (bytes[i] === 0x0d || bytes[i] === 0x0a) continue;
    out.push(bytes[i]);
  }
  return out;
};
const ascii = (bytes) => Buffer.from(bytes).toString('latin1');

test.describe('ansi art: .ans bytes (CP437)', () => {
  test('block characters map to 0xDF 0xB0 0xB1 0xB2 0xDB and the SGR codes are ANSI.SYS-style', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { gridToANS, cp437Byte } = await import('/src/io/exportText.js');
      const n = 5;
      const grid = {
        cols: n, rows: 1, chars: ['▀', '░', '▒', '▓', '█'],
        rgba: new Uint8ClampedArray(n * 4).fill(255), bgRgba: new Uint8ClampedArray(n * 4).map((v, i) => (i % 4 === 3 ? 255 : 0)),
        mono: null, bg: null,
      };
      const white = Array.from(gridToANS(grid));
      // second grid: blue foreground (VGA 0,0,170) on red background (170,0,0), then a bright background (255,85,85)
      const g2 = {
        cols: 3, rows: 1, chars: ['▀', 'X', ' '],
        rgba: Uint8ClampedArray.from([0, 0, 170, 255, 255, 255, 85, 255, 0, 0, 0, 255]),
        bgRgba: Uint8ClampedArray.from([170, 0, 0, 255, 255, 85, 85, 255, 0, 0, 0, 255]),
        mono: null, bg: null,
      };
      const colours = Array.from(gridToANS(g2));
      return {
        white, colours,
        singles: ['▀', '░', '▒', '▓', '█', '▄', '▌', '▐', '─', 'A', '~', '€'].map(cp437Byte),
      };
    });
    expect(strip(res.white)).toEqual([0xdf, 0xb0, 0xb1, 0xb2, 0xdb]);
    // bright white on black: one SGR before the first character, no repeat while the colours stay the same
    expect(ascii(res.white)).toBe('\x1b[0;1;37;40m\xdf\xb0\xb1\xb2\xdb\x1b[0m\r\n');
    expect(res.singles).toEqual([0xdf, 0xb0, 0xb1, 0xb2, 0xdb, 0xdc, 0xdd, 0xde, 0xc4, 0x41, 0x7e, 0x3f]);
    // VGA blue (index 1) -> ANSI 34; red (index 4) -> ANSI 31 as background 41; bright red background -> dark red 41
    const s = ascii(res.colours);
    expect(s).toContain('\x1b[0;34;41m\xdf');
    expect(s).toContain('\x1b[0;1;33;41mX'); // bright yellow (255,255,85) on the bright-red background mapped to its dark counterpart
    expect(s).toContain('\x1b[0;30;40m ');
    await guard.assertClean(expect);
  });
});

// A 10 x 4 picture is 10 columns x 2 rows (half blocks: 10 x 4 pixels), so each pixel is one half of a cell.
const px = (x, y, c) => [c, x, y, 1, 1];

test.describe('ansi art: half blocks', () => {
  const rect = (rects) => ({
    mode: 'ansi', width: 10, height: 4, abs: true, rects, theme: { ink: '#fff', bg: '#000' },
  });

  test('truecolor: foreground = top pixel, background = bottom pixel (exact colours)', async ({ page }) => {
    await gotoApp(page);
    const r = await renderMode(page, {
      ...rect([['#000', 0, 0, 10, 4], px(0, 0, '#ff0000'), px(0, 1, '#0000ff'), px(1, 0, '#00ff00'), px(1, 1, '#ffff00')]),
      params: { global: { cols: 10 }, mode: { charMode: 'halfblocks', ansiPalette: 'truecolor' } },
      outputs: ['txt', 'ansi', 'html'], pixels: [[0.05, 0.1], [0.05, 0.4]],
    });
    expect(r.error).toBeNull();
    expect(r.meta.cols).toBe(10);
    expect(r.meta.rows).toBe(2);
    expect(r.outputs.txt.split('\n')[0].startsWith('▀▀')).toBe(true);
    // ANSI: cell 0 = fg red on bg blue; cell 1 = fg green on bg yellow
    const line = r.outputs.ansi.split('\n')[0];
    expect(line).toContain('\x1b[48;2;0;0;255m\x1b[38;2;255;0;0m▀');
    expect(line).toContain('\x1b[48;2;255;255;0m\x1b[38;2;0;255;0m▀');
    // HTML: colour and background per run, nothing unescaped
    expect(r.outputs.html).toContain('color:#ff0000;background:#0000ff');
    // canvas: the top half of the cell is red, the bottom half blue (cell 8x16 px; the picture is 80 x 32)
    expect(r.width).toBe(80);
    expect(r.height).toBe(32);
    expect(r.frames[0].pixels[0].slice(0, 3)).toEqual([255, 0, 0]);
    expect(r.frames[0].pixels[1].slice(0, 3)).toEqual([0, 0, 255]);
  });

  test('VGA 16 with 8 backgrounds: the half block is flipped when only the top colour can be a background', async ({ page }) => {
    await gotoApp(page);
    // bright red (255,85,85) = VGA 12 (not a legal background) over blue (0,0,170) = VGA 1 (legal)
    const base = {
      ...rect([['#000', 0, 0, 10, 4], px(0, 0, '#ff5555'), px(0, 1, '#0000aa'), px(1, 0, '#0000aa'), px(1, 1, '#ff5555')]),
      params: { global: { cols: 10 }, mode: { charMode: 'halfblocks', ansiPalette: 'vga16', dither: 'none', bg8: true } },
      outputs: ['txt', 'ans'],
    };
    const r = await renderMode(page, base);
    const row = Array.from(r.outputs.txt.split('\n')[0]);
    expect(row[0]).toBe('▀'); // fg bright red (top), bg blue (bottom)
    expect(row[1]).toBe('▄'); // top is blue: bottom (bright red) must be the foreground of a lower half block
    const bytes = strip(r.outputs.ans);
    expect(bytes[0]).toBe(0xdf);
    expect(bytes[1]).toBe(0xdc);
    const raw = ascii(r.outputs.ans);
    expect(raw.startsWith('\x1b[0;1;31;44m\xdf\xdc')).toBe(true); // bright (1) red (31) on blue (44), one SGR for both cells
    // without the restriction the first cell stays a plain ▀ and the second still needs a legal... (blue top, bright red bottom -> bg bright red)
    const free = await renderMode(page, { ...base, params: { ...base.params, mode: { ...base.params.mode, bg8: false } } });
    expect(Array.from(free.outputs.txt.split('\n')[0]).slice(0, 2)).toEqual(['▀', '▀']);
  });
});

test.describe('ansi art: shading and modes', () => {
  test('classic shading of a black-to-white ramp uses ░▒▓█ and spaces, never half blocks', async ({ page }) => {
    await gotoApp(page);
    const r = await renderMode(page, {
      mode: 'ansi', width: 256, height: 32, theme: { ink: '#fff', bg: '#000' },
      rects: Array.from({ length: 64 }, (_, i) => [`rgb(${i * 4},${i * 4},${i * 4})`, i * 4, 0, 4, 32]).map(([c, x, y, w, h]) => [c, x, y, w, h]),
      abs: true,
      params: { global: { cols: 64 }, mode: { charMode: 'shading', ansiPalette: 'vga16', dither: 'none' } },
      outputs: ['txt', 'ans'],
    });
    const chars = new Set(Array.from(r.outputs.txt.replace(/\n/g, '')));
    for (const c of chars) expect(' ░▒▓█').toContain(c);
    expect(chars.size).toBeGreaterThanOrEqual(3);
    const bytes = new Set(strip(r.outputs.ans));
    for (const b of bytes) expect([0x20, 0xb0, 0xb1, 0xb2, 0xdb]).toContain(b);
    expect(bytes.size).toBeGreaterThanOrEqual(3);
  });

  test('shading honours the 8-background restriction in the .ans (never a bright background code 4x with bold)', async ({ page }) => {
    await gotoApp(page);
    const r = await renderMode(page, {
      mode: 'ansi', width: 64, height: 64, theme: { ink: '#fff', bg: '#000' },
      rects: [['#ff5555', 0, 0, 32, 64], ['#55ffff', 32, 0, 32, 64]], abs: true,
      params: { global: { cols: 32 }, mode: { charMode: 'shading', ansiPalette: 'vga16', dither: 'none', bg8: true } },
      outputs: ['ans'],
    });
    const sgr = [...ascii(r.outputs.ans).matchAll(/\x1b\[0;(?:1;)?(\d+);(\d+)m/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(sgr.length).toBeGreaterThan(0);
    for (const [fg, bg] of sgr) {
      expect(fg).toBeGreaterThanOrEqual(30); expect(fg).toBeLessThanOrEqual(37);
      expect(bg).toBeGreaterThanOrEqual(40); expect(bg).toBeLessThanOrEqual(47);
    }
  });

  test('xterm 256 and truecolor shading (projection) and the mixed mode all render with valid characters', async ({ page }) => {
    await gotoApp(page);
    for (const [charMode, ansiPalette] of [['shading', 'xterm256'], ['shading', 'truecolor'], ['mixed', 'vga16'], ['mixed', 'truecolor'], ['mixed', 'xterm256']]) {
      const r = await renderMode(page, {
        mode: 'ansi', width: 120, height: 60, theme: { ink: '#fff', bg: '#000' },
        rects: [['#204080', 0, 0, 120, 60], ['#e0a030', 20, 10, 50, 30], ['#ffffff', 80, 5, 30, 20]], abs: true,
        params: { global: { cols: 40 }, mode: { charMode, ansiPalette, dither: 'floyd-steinberg' } },
        outputs: ['txt', 'ansi', 'ans'], pixels: [[0.5, 0.5]],
      });
      expect(r.error, `${charMode}/${ansiPalette}`).toBeNull();
      const chars = new Set(Array.from(r.outputs.txt.replace(/\n/g, '')));
      for (const c of chars) expect(' ░▒▓█▀▄', `${charMode}/${ansiPalette}`).toContain(c);
      expect(r.outputs.ans.length).toBeGreaterThan(40);
      expect(r.frames[0].pixels[0][3]).toBe(255);
    }
  });

  test('large palette dithering in the worker gives the same cells as the main thread', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const ansi = (await import('/src/modes/ansi.js')).default;
      const heavy = await import('/src/engine/heavy.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const c = document.createElement('canvas');
      c.width = 900; c.height = 600;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 900, 600);
      grad.addColorStop(0, '#102040'); grad.addColorStop(0.5, '#d08040'); grad.addColorStop(1, '#f0f0c0');
      g.fillStyle = grad; g.fillRect(0, 0, 900, 600);
      const source = { id: 's', kind: 'image', width: 900, height: 600, version: 1, animated: false, frame: () => c, dispose() {} };
      const out = {};
      for (const charMode of ['halfblocks', 'shading']) {
        const params = {
          global: { ...defaultsOf(IMAGE_PARAMS), cols: 250 }, color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {},
          mode: { ...defaultsOf(ansi.params), charMode, ansiPalette: 'vga16', dither: 'floyd-steinberg' },
        };
        const run = async (forceMain) => {
          heavy.setForceMain(forceMain);
          const before = heavy.stats().spawned;
          const pipe = createPipeline();
          await pipe.render({ source, mode: ansi, params, theme: { ink: '#fff', bg: '#000' } });
          heavy.setForceMain(false);
          return { txt: ansi.toText(pipe.getState('ansi'), 'ansi'), spawned: heavy.stats().spawned - before };
        };
        const w = await run(false);
        const m = await run(true);
        out[charMode] = { same: w.txt === m.txt, len: w.txt.length, worker: w.spawned >= 0 };
      }
      return out;
    });
    expect(res.halfblocks.same).toBe(true);
    expect(res.shading.same).toBe(true);
    expect(res.halfblocks.len).toBeGreaterThan(5000);
  });
});

test.describe('ansi art: in the studio', () => {
  test('the export panel offers .ans and downloads a CP437 file', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const before = await renderCount(page);
    await page.locator('#mode-list .mode-item[data-mode-id="ansi"]').click();
    await waitForRender(page, before);
    await settle(page);
    for (const k of ['png', 'txt', 'html', 'ansi', 'ans']) await expect(page.locator(`[data-export="${k}"]`)).toBeVisible();
    const { name, bytes } = await captureDownload(page, () => page.click('[data-export="ans"]'));
    expect(name).toMatch(/^dither-ansi-\d{8}-\d{6}\.ans$/);
    expect(bytes[0]).toBe(0x1b);
    const chars = new Set(strip([...bytes]));
    for (const b of chars) expect(b === 0x20 || b === 0xdf || b === 0xdc || (b >= 0xb0 && b <= 0xb2) || b === 0xdb).toBe(true);
    expect(chars.has(0xdf) || chars.has(0xdc)).toBe(true);
    const txt = await captureDownload(page, () => page.click('[data-export="txt"]'));
    const lines = txt.bytes.toString('utf8').slice(0, -1).split('\n');
    const dims = await page.evaluate(() => { const c = document.getElementById('viewer-canvas'); return { cols: Number(c.dataset.cols), rows: Number(c.dataset.rows) }; });
    expect(lines).toHaveLength(dims.rows);
    for (const line of lines) expect(Array.from(line)).toHaveLength(dims.cols);
    await guard.assertClean(expect);
  });
});
