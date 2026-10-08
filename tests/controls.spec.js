// Phase 1 acceptance: every control of the reference panel changes the result live, and the
// controls themselves (generated from schemas) behave: reset, editable values, showIf, groups.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  watchPage, gotoApp, loadFixture, renderCount, waitForRender, canvasStats, setControl, getControl, resetAll,
} from './helpers.js';

/** [control id, new value, optional preconditions as [id, value] pairs] */
const CASES = [
  // ---- IMAGEN (global) ----
  ['cols', 60],
  ['brightness', 160],
  ['contrast', 250],
  ['saturation', 0, [['colorMode', 'original']]],
  ['hue', 120],
  ['grayscale', 100, [['colorMode', 'original']]],
  ['sepia', 100],
  ['invert', 100],
  ['thresholdOn', true],
  ['threshold', 200, [['thresholdOn', true]]],
  ['sharpness', 15],
  ['edges', 6],
  ['dither', 'floyd-steinberg'],
  ['dither', 'jjn'],
  ['dither', 'stucki'],
  ['dither', 'atkinson'],
  ['dither', 'burkes'],
  ['dither', 'sierra'],
  ['dither', 'sierra2'],
  ['dither', 'sierra-lite'],
  ['dither', 'bayer2'],
  ['dither', 'bayer4'],
  ['dither', 'bayer8'],
  ['dither', 'bayer16'],
  ['dither', 'blue-noise'],
  ['dither', 'random'],
  ['serpentine', true, [['dither', 'floyd-steinberg']]],
  ['frame', 24],
  ['flipX', true],
  ['cropTop', 30],
  ['cropRight', 25],
  ['cropBottom', 30],
  ['cropLeft', 20],
  // ---- MODO: ASCII ----
  ['gradient', 'detailed'],
  ['gradient', 'blocks'],
  ['gradient', 'math'],
  ['gradient', 'arrows'],
  ['gradient', 'binary'],
  ['gradient', 'katakana'],
  ['gradient', 'box'],
  ['gradient', 'dots'],
  ['customGradient', '#.', [['gradient', 'custom']]],
  ['autoSort', false, [['gradient', 'math']]],
  ['invertGradient', true],
  ['spaceDensity', 8],
  ['edgeChars', false, [['edges', 6]]],
  ['edgeThreshold', 0.9, [['edges', 6]]],
  ['font', 'jetbrains-mono'],
  ['font', 'ibm-plex-mono'],
  ['font', 'vt323'],
  ['font', 'space-mono'],
  ['font', 'courier'],
  ['cellSize', 20],
  ['lineHeight', 1.3],
  ['letterSpacing', 2],
  // ---- COLOR ----
  ['colorMode', 'original'],
  ['colorMode', 'gradient'],
  ['colorMode', 'palette'],
  ['ink', '#ff0000'],
  ['bg', '#336699'],
  ['bgTransparent', true],
  ['palette', 'c64', [['colorMode', 'palette']]],
  ['palette', 'gameboy', [['colorMode', 'palette']]],
  ['customPalette', '#ff0000 #00ff00 #0000ff', [['colorMode', 'palette'], ['palette', 'custom']]],
  ['colorBoost', 200, [['colorMode', 'original']]],
];

test.describe('controls change the result live', () => {
  test('every control of the panel changes the output', async ({ page }) => {
    test.setTimeout(240_000);
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);

    const failures = [];
    for (const [id, value, pre = []] of CASES) {
      await resetAll(page);
      for (const [pid, pval] of pre) {
        const before = await renderCount(page);
        await setControl(page, pid, pval);
        await waitForRender(page, before);
      }
      const base = await canvasStats(page);
      const before = await renderCount(page);
      await setControl(page, id, value);
      await waitForRender(page, before);
      const next = await canvasStats(page);
      const changed = next.hash !== base.hash;
      if (!changed) failures.push(`${id}=${JSON.stringify(value)} did not change the output`);
      // the control must also reflect what we set
      const shown = await getControl(page, id);
      if (typeof value === 'string' && value.startsWith('#') && id !== 'customGradient' && id !== 'customPalette') {
        if (String(shown).toLowerCase() !== value) failures.push(`${id}: control shows ${shown}, expected ${value}`);
      } else if (typeof value !== 'string' || id === 'customGradient' || id === 'customPalette') {
        if (shown !== value) failures.push(`${id}: control shows ${shown}, expected ${value}`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
    await guard.assertClean(expect);
  });
});

// ---------------------------------------------------------------------------------------------------
// Semantics, checked on the TXT export
// ---------------------------------------------------------------------------------------------------
async function txt(page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-export="txt"]')]);
  return readFileSync(await dl.path(), 'utf8');
}
async function change(page, id, value) {
  const before = await renderCount(page);
  await setControl(page, id, value);
  await waitForRender(page, before);
}

test.describe('semantics', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
  });

  test('thresholding leaves exactly two characters', async ({ page }) => {
    await change(page, 'thresholdOn', true);
    const chars = new Set(Array.from((await txt(page)).replace(/\n/g, '')));
    expect(chars.size).toBe(2);
    expect(chars.has(' ')).toBe(true);
  });

  test('a binary gradient only uses its own characters', async ({ page }) => {
    await change(page, 'gradient', 'binary');
    const chars = new Set(Array.from((await txt(page)).replace(/\n/g, '')));
    for (const c of chars) expect(' 01').toContain(c);
    expect(chars.size).toBeGreaterThanOrEqual(2);
  });

  test('space density adds empty cells', async ({ page }) => {
    const ratio = (t) => (t.match(/ /g) || []).length / t.replace(/\n/g, '').length;
    const base = ratio(await txt(page));
    await change(page, 'spaceDensity', 20);
    const more = ratio(await txt(page));
    expect(more).toBeGreaterThan(base + 0.1);
  });

  test('inverting the gradient reverses every cell', async ({ page }) => {
    await change(page, 'autoSort', false); // keep the declared order
    const order = ' .:-=+*#%@';
    const a = (await txt(page)).replace(/\n/g, '');
    await change(page, 'invertGradient', true);
    const b = (await txt(page)).replace(/\n/g, '');
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(order.indexOf(a[i]) + order.indexOf(b[i])).toBe(order.length - 1);
  });

  test('edge detection brings directional characters, and they can be switched off', async ({ page }) => {
    const hasDir = (t) => /[|/\\]/.test(t);
    expect(hasDir(await txt(page))).toBe(false);
    await change(page, 'edges', 6);
    expect(hasDir(await txt(page))).toBe(true);
    await change(page, 'edgeChars', false);
    expect(hasDir(await txt(page))).toBe(false);
  });

  test('invert colours flips the picture (bright becomes dark)', async ({ page }) => {
    const rank = (t) => {
      const order = ' .:-=+*#%@';
      const s = t.replace(/\n/g, '');
      let sum = 0;
      for (const ch of s) sum += order.indexOf(ch);
      return sum / s.length;
    };
    await change(page, 'autoSort', false);
    const a = rank(await txt(page));
    await change(page, 'invert', 100);
    const b = rank(await txt(page));
    expect(Math.abs(a + b - 9)).toBeLessThan(1.2); // mean ink rank mirrors around the middle of the scale
  });

  test('brightness lifts the average density, contrast spreads it', async ({ page }) => {
    const mean = (t) => {
      const order = ' .:-=+*#%@';
      const s = t.replace(/\n/g, '');
      let sum = 0;
      for (const ch of s) sum += order.indexOf(ch);
      return sum / s.length;
    };
    await change(page, 'autoSort', false);
    const m0 = mean(await txt(page));
    await change(page, 'brightness', 170);
    const m1 = mean(await txt(page));
    await change(page, 'brightness', 40);
    const m2 = mean(await txt(page));
    // On a dark background bright pixels get dense glyphs; on a light one it is the other way round.
    const darkBg = await page.evaluate(() => document.documentElement.dataset.tone === 'dark');
    if (darkBg) {
      expect(m1).toBeGreaterThan(m0);
      expect(m2).toBeLessThan(m0);
    } else {
      expect(m1).toBeLessThan(m0);
      expect(m2).toBeGreaterThan(m0);
    }
  });

  test('theme polarity: bright pixels get dense glyphs on dark themes and sparse ones on light themes', async ({ page }) => {
    await change(page, 'autoSort', false);
    const mean = (t) => {
      const order = ' .:-=+*#%@';
      const s = t.replace(/\n/g, '');
      let sum = 0;
      for (const ch of s) sum += order.indexOf(ch);
      return sum / s.length;
    };
    const before = await renderCount(page);
    await page.selectOption('#theme-select', 'horain');
    await waitForRender(page, before);
    const dark = mean(await txt(page));
    const before2 = await renderCount(page);
    await page.selectOption('#theme-select', 'claro');
    await waitForRender(page, before2);
    const light = mean(await txt(page));
    expect(Math.abs(dark + light - 9)).toBeLessThan(0.6);
    expect(dark).not.toBeCloseTo(light, 0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Frame, transparency
// ---------------------------------------------------------------------------------------------------
test.describe('output surface', () => {
  test('transparent frame adds a clear margin around the output', async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
    const base = await canvasStats(page);
    await change(page, 'frame', 30);
    const framed = await canvasStats(page);
    expect(framed.width).toBe(base.width + 60);
    expect(framed.height).toBe(base.height + 60);
    const corner = await page.evaluate(() => {
      const c = document.getElementById('viewer-canvas');
      return Array.from(c.getContext('2d').getImageData(3, 3, 1, 1).data);
    });
    expect(corner[3]).toBe(0);
    expect(await page.locator('#viewer-world.is-transparent').count()).toBe(1); // checkerboard shows through
  });

  test('transparent background leaves the empty cells clear (viewer and PNG)', async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
    await change(page, 'bgTransparent', true);
    const stats = await canvasStats(page);
    expect(stats.opaque).toBeLessThan(stats.width * stats.height * 0.9);
    expect(stats.opaque).toBeGreaterThan(0);
    await expect(page.locator('#controls [data-param="bg"]')).toBeHidden();

    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-export="png"]')]);
    const buf = readFileSync(await dl.path());
    const alpha = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const { data } = g.getImageData(0, 0, c.width, c.height);
      let clear = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] === 0) clear++;
      return clear / (c.width * c.height);
    }, buf.toString('base64'));
    expect(alpha).toBeGreaterThan(0.1);
  });

  test('colour modes colour the glyphs (original / gradient / palette)', async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
    const mono = await canvasStats(page);
    await change(page, 'colorMode', 'original');
    const original = await canvasStats(page);
    expect(original.colors).toBeGreaterThan(mono.colors * 2);
    await change(page, 'colorMode', 'gradient');
    const gradient = await canvasStats(page);
    expect(gradient.colors).toBeGreaterThan(mono.colors);
    await change(page, 'colorMode', 'palette');
    await change(page, 'palette', 'mac1bit');
    const bw = await canvasStats(page);
    // two palette colours + anti-aliased blends between glyph and background only
    expect(bw.colors).toBeLessThan(original.colors);
  });
});

// ---------------------------------------------------------------------------------------------------
// The controls themselves
// ---------------------------------------------------------------------------------------------------
test.describe('controls UI', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
  });

  test('slider value is editable: type a number and press Enter', async ({ page }) => {
    const row = page.locator('[data-param="contrast"]');
    const num = row.locator('.ctl-num');
    await num.click();
    await num.fill('180');
    await num.press('Enter');
    await expect(row.locator('.range')).toHaveValue('180');
    expect(await getControl(page, 'contrast')).toBe(180);
    // out-of-range values are clamped to the schema
    await num.fill('9999');
    await num.press('Enter');
    await expect(row.locator('.range')).toHaveValue('300');
    // garbage reverts
    await num.fill('abc');
    await num.press('Enter');
    await expect(num).toHaveValue('300');
  });

  test('moving the range input renders live', async ({ page }) => {
    const before = await canvasStats(page);
    const n = await renderCount(page);
    await page.locator('[data-param="brightness"] .range').evaluate((el) => {
      el.value = '170';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitForRender(page, n);
    expect((await canvasStats(page)).hash).not.toBe(before.hash);
    await expect(page.locator('[data-param="brightness"] .ctl-num')).toHaveValue('170');
  });

  test('keyboard changes sliders', async ({ page }) => {
    const range = page.locator('[data-param="sepia"] .range');
    await range.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await getControl(page, 'sepia')).toBe(3);
    await page.keyboard.press('End');
    expect(await getControl(page, 'sepia')).toBe(100);
  });

  test('double-clicking a label restores the default', async ({ page }) => {
    await setControl(page, 'brightness', 150);
    expect(await getControl(page, 'brightness')).toBe(150);
    await page.locator('[data-param="brightness"] .ctl-label').dblclick();
    expect(await getControl(page, 'brightness')).toBe(100);
    await setControl(page, 'invertGradient', true);
    await page.locator('[data-param="invertGradient"] .ctl-label').dblclick();
    expect(await getControl(page, 'invertGradient')).toBe(false);
  });

  test('the ↺ of a group restores that group only', async ({ page }) => {
    await setControl(page, 'brightness', 150);
    await setControl(page, 'cellSize', 20);
    await page.locator('[data-group="image"] .group-reset').click();
    expect(await getControl(page, 'brightness')).toBe(100);
    expect(await getControl(page, 'cellSize')).toBe(20);
    await page.locator('[data-group="mode"] .group-reset').click();
    expect(await getControl(page, 'cellSize')).toBe(12);
  });

  test('controls a mode does not use are hidden, not disabled (showIf)', async ({ page }) => {
    await expect(page.locator('[data-param="threshold"]')).toBeHidden();
    await expect(page.locator('[data-param="serpentine"]')).toBeHidden();
    await expect(page.locator('[data-param="customGradient"]')).toBeHidden();
    await expect(page.locator('[data-param="edgeChars"]')).toBeHidden();
    await expect(page.locator('[data-param="gradStops"]')).toBeHidden();
    await setControl(page, 'thresholdOn', true);
    await expect(page.locator('[data-param="threshold"]')).toBeVisible();
    await setControl(page, 'dither', 'atkinson');
    await expect(page.locator('[data-param="serpentine"]')).toBeVisible();
    await setControl(page, 'dither', 'bayer4');
    await expect(page.locator('[data-param="serpentine"]')).toBeHidden();
    await setControl(page, 'gradient', 'custom');
    await expect(page.locator('[data-param="customGradient"]')).toBeVisible();
    await setControl(page, 'edges', 3);
    await expect(page.locator('[data-param="edgeChars"]')).toBeVisible();
    await setControl(page, 'colorMode', 'gradient');
    await expect(page.locator('[data-param="gradStops"]')).toBeVisible();
    await expect(page.locator('[data-param="ink"]')).toBeHidden();
  });

  test('gradient stops: add, edit and remove colours', async ({ page }) => {
    await setControl(page, 'colorMode', 'gradient');
    const row = page.locator('[data-param="gradStops"]');
    await expect(row.locator('.swatch')).toHaveCount(2);
    await row.locator('.mini-btn[aria-label="+"]').click();
    await expect(row.locator('.swatch')).toHaveCount(3);
    await expect(row.locator('.mini-btn[aria-label="+"]')).toBeDisabled();
    const n = await renderCount(page);
    await row.locator('.swatch').first().evaluate((el) => {
      el.value = '#ff0000';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForRender(page, n);
    await row.locator('.mini-btn[aria-label="−"]').click();
    await expect(row.locator('.swatch')).toHaveCount(2);
    await expect(row.locator('.mini-btn[aria-label="−"]')).toBeDisabled();
  });

  test('colour defaults follow the theme until the user picks one', async ({ page }) => {
    await page.selectOption('#theme-select', 'horain');
    expect((await getControl(page, 'ink')).toLowerCase()).toBe('#c4f169');
    expect((await getControl(page, 'bg')).toLowerCase()).toBe('#15181e');
    await page.selectOption('#theme-select', 'amber');
    expect((await getControl(page, 'ink')).toLowerCase()).toBe('#ffb000');
    // once chosen, the colour sticks across themes
    await setControl(page, 'ink', '#123456');
    await page.selectOption('#theme-select', 'cad');
    expect((await getControl(page, 'ink')).toLowerCase()).toBe('#123456');
    // and the reset button hands it back to the theme
    await page.locator('[data-param="ink"] .mini-btn').click();
    expect((await getControl(page, 'ink')).toLowerCase()).toBe('#e6f0ff');
  });

  test('help tooltips are reachable by keyboard and describe the control', async ({ page }) => {
    const help = page.locator('[data-param="sharpness"] .ctl-help');
    await help.focus();
    const tip = page.locator('[data-param="sharpness"] .ctl-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toHaveAttribute('role', 'tooltip');
    expect(await help.getAttribute('aria-describedby')).toBe(await tip.getAttribute('id'));
  });

  test('every control has an accessible name and a visible focus ring', async ({ page }) => {
    const missing = await page.evaluate(() => {
      const bad = [];
      for (const el of document.querySelectorAll('#controls input, #controls select, #controls button')) {
        if (el.hidden || el.closest('[hidden]')) continue;
        const name = (el.getAttribute('aria-label') || '').trim()
          || Array.from(el.labels || []).map((l) => l.textContent.trim()).join('')
          || (el.tagName === 'BUTTON' ? el.textContent.trim() : '')
          || (el.title || '').trim();
        if (!name) bad.push(`${el.tagName} ${el.className} ${el.getAttribute('data-export') || ''}`);
      }
      return bad;
    });
    expect(missing).toEqual([]);
    // Focus is visible: the slider thumb gets a ring through a :focus-visible rule, native controls get the global outline
    const thumbRing = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule.selectorText && rule.selectorText.includes('.range:focus-visible::-webkit-slider-thumb')) return rule.style.boxShadow;
        }
      }
      return '';
    });
    expect(thumbRing).not.toBe('');
    await page.locator('[data-param="gradient"] select').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const outlineStyle = await page.locator('[data-param="gradient"] select').evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outlineStyle).toBe('solid');
  });

  test('changing the mode keeps the file and rebuilds the panel', async ({ page }) => {
    const name = await page.locator('[data-group="input"] .src-name').textContent();
    expect(name).toBe('fixture.png');
    await expect(page.locator('[data-group="mode"] .group-title')).toContainText('ASCII');
    await expect(page.locator('#mode-list .mode-item[aria-current="true"]')).toHaveText(/ASCII/);
    // switching language rebuilds the panel in place, keeping values and the loaded file
    await setControl(page, 'brightness', 133);
    await page.click('.lang-toggle [data-lang="es"]');
    await expect(page.locator('[data-param="brightness"] .ctl-label')).toHaveText('Brillo');
    await expect(page.locator('[data-group="mode"] .group-title')).toContainText('Modo: ASCII');
    expect(await getControl(page, 'brightness')).toBe(133);
    await expect(page.locator('[data-group="input"] .src-name')).toHaveText('fixture.png');
  });
});

// ---------------------------------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------------------------------
test.describe('viewer', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
  });

  const zoomOf = (page) => page.evaluate(() => parseInt(document.getElementById('vw-zoom').textContent, 10));

  test('wheel zooms between 10% and 800%, 1:1 and Fit restore', async ({ page }) => {
    const fit = await zoomOf(page);
    expect(fit).toBeGreaterThan(20);
    const box = await page.locator('#viewer-viewport').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    const zoomed = await zoomOf(page);
    expect(zoomed).toBeGreaterThan(fit);
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -600);
    expect(await zoomOf(page)).toBe(800);
    for (let i = 0; i < 60; i++) await page.mouse.wheel(0, 600);
    expect(await zoomOf(page)).toBe(10);
    await page.click('#vw-1to1');
    expect(await zoomOf(page)).toBe(100);
    await page.click('#vw-fit');
    expect(await zoomOf(page)).toBe(fit);
  });

  test('dragging pans the picture', async ({ page }) => {
    await page.click('#vw-1to1');
    const before = await page.locator('#viewer-canvas').boundingBox();
    const vp = await page.locator('#viewer-viewport').boundingBox();
    await page.mouse.move(vp.x + 200, vp.y + 200);
    await page.mouse.down();
    await page.mouse.move(vp.x + 260, vp.y + 240, { steps: 4 });
    await page.mouse.up();
    const after = await page.locator('#viewer-canvas').boundingBox();
    expect(Math.round(after.x - before.x)).toBe(60);
    expect(Math.round(after.y - before.y)).toBe(40);
  });

  test('zooming in re-renders the text at the resolution the zoom needs', async ({ page }) => {
    const before = await page.locator('#viewer-canvas').getAttribute('data-out-scale');
    expect(before).toBe('1');
    const n = await renderCount(page);
    const box = await page.locator('#viewer-viewport').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -500);
    await waitForRender(page, n);
    await expect.poll(() => page.locator('#viewer-canvas').getAttribute('data-out-scale')).not.toBe('1');
  });

  test('split view shows the original on one side and can be dragged', async ({ page }) => {
    await expect(page.locator('#split-handle')).toBeHidden();
    await page.click('#vw-split');
    await expect(page.locator('#split-handle')).toBeVisible();
    await expect(page.locator('#vw-split')).toHaveAttribute('aria-pressed', 'true');
    const orig = await canvasStats(page, '#viewer-original');
    expect(orig.variance).toBeGreaterThan(0);
    // the original really is on top on the left of the handle and the art on the right
    const hit = await page.evaluate(() => {
      const w = document.getElementById('viewer-world').getBoundingClientRect();
      const y = w.top + w.height / 2;
      const left = document.elementFromPoint(w.left + w.width * 0.2, y);
      const right = document.elementFromPoint(w.left + w.width * 0.8, y);
      return { left: left && left.id, right: right && right.id };
    });
    expect(hit).toEqual({ left: 'viewer-original', right: 'viewer-canvas' });
    const h = await page.locator('#split-handle').boundingBox();
    const w = await page.locator('#viewer-world').boundingBox();
    const startPct = await page.evaluate(() => document.getElementById('split-handle').getAttribute('aria-valuenow'));
    expect(startPct).toBe('50');
    await page.mouse.move(h.x + 1, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(w.x + w.width * 0.8, h.y + h.height / 2, { steps: 5 });
    await page.mouse.up();
    const pct = Number(await page.locator('#split-handle').getAttribute('aria-valuenow'));
    expect(pct).toBeGreaterThan(70);
    expect(pct).toBeLessThan(90);
    // keyboard
    await page.locator('#split-handle').focus();
    await page.keyboard.press('ArrowLeft');
    expect(Number(await page.locator('#split-handle').getAttribute('aria-valuenow'))).toBeLessThan(pct);
    await page.click('#vw-split');
    await expect(page.locator('#split-handle')).toBeHidden();
  });

  test('stats show resolution and render time', async ({ page }) => {
    const text = await page.locator('#viewer-stats').textContent();
    expect(text).toMatch(/^\d+×\d+ · \d+ ms$/);
    expect(text.startsWith('120×')).toBe(true);
  });

  test('keyboard: + - 0 zoom and fit', async ({ page }) => {
    await page.locator('#viewer-viewport').focus();
    const fit = await zoomOf(page);
    await page.keyboard.press('+');
    expect(await zoomOf(page)).toBeGreaterThan(fit);
    await page.keyboard.press('0');
    expect(await zoomOf(page)).toBe(fit);
  });
});
