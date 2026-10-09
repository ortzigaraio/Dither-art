import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, loadFixture, loadVideo, settle, renderCount } from './helpers.js';

// Phase 3 plumbing that every mode relies on: categories and badges in the list, export panel = declared exports,
// animated modes loop on stills (PLAN.md 5.7, 6)

/** Select a mode (a click on the active one changes nothing) and wait for its first frame. */
async function pick(page, id) {
  const item = page.locator(`#mode-list .mode-item[data-mode-id="${id}"]`);
  if ((await item.getAttribute('aria-current')) === 'true') return;
  const before = await renderCount(page);
  await item.click();
  await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b, before);
}

const EXPORT_KEYS = { png: ['png'], txt: ['txt'], html: ['html'], ansi: ['ansi'], ans: ['ans'], svg: ['svg'], json: ['json'] };

test.describe('mode list', () => {
  test('groups by category, in registry order, with TXT / SVG / ANIM badges that match what the mode can do', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const info = await page.evaluate(async () => {
      const { MODES, CATEGORIES } = await import('/src/modes/index.js');
      const groups = Array.from(document.querySelectorAll('#mode-list .mode-group')).map((g) => ({
        heading: g.querySelector('.mode-cat').textContent.trim(),
        items: Array.from(g.querySelectorAll('.mode-item')).map((b) => ({
          id: b.dataset.modeId, badges: Array.from(b.querySelectorAll('.badge')).map((x) => x.textContent.trim()),
        })),
      }));
      const select = Array.from(document.querySelectorAll('#mode-select optgroup')).map((og) => ({
        label: og.label, ids: Array.from(og.querySelectorAll('option')).map((o) => o.value),
      }));
      return {
        groups, select, categories: CATEGORIES,
        modes: MODES.map((m) => ({ id: m.id, category: m.category, badges: m.badges, exports: m.exports, animated: m.animated })),
      };
    });
    expect(info.groups.map((g) => g.heading)).toEqual(['Text']); // only the text category has modes so far
    const textModes = info.modes.filter((m) => m.category === 'text');
    expect(info.groups[0].items.map((i) => i.id)).toEqual(textModes.map((m) => m.id));
    expect(info.select[0].ids).toEqual(textModes.map((m) => m.id));
    expect(info.groups[0].items.map((i) => i.id)).toEqual(expect.arrayContaining(['ascii', 'braille', 'ansi', 'petscii', 'matrix', 'typoportrait']));
    for (const m of info.modes) {
      const item = info.groups[0].items.find((i) => i.id === m.id);
      expect(item.badges, `${m.id} badges`).toEqual(m.badges);
      expect(m.badges.includes('TXT'), `${m.id} TXT badge`).toBe(m.exports.includes('txt'));
      expect(m.badges.includes('SVG'), `${m.id} SVG badge`).toBe(m.exports.includes('svg'));
      expect(m.badges.includes('ANIM'), `${m.id} ANIM badge`).toBe(!!m.animated);
    }
    await guard.assertClean(expect);
  });
});

test.describe('export panel', () => {
  test('offers exactly the exports each mode declares (still image)', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const modes = await page.evaluate(async () => (await import('/src/modes/index.js')).MODES.map((m) => ({ id: m.id, exports: m.exports, animated: !!m.animated })));
    for (const m of modes) {
      await pick(page, m.id);
      if (!m.animated) await settle(page);
      const keys = await page.evaluate(() => Array.from(document.querySelectorAll('#controls [data-group="export"] button[data-export]')).map((b) => b.dataset.export));
      const want = new Set();
      for (const e of m.exports) for (const k of EXPORT_KEYS[e] || []) want.add(k);
      if (m.exports.includes('png')) want.add('copy-image');
      if (m.exports.includes('txt')) want.add('copy-text');
      want.add('share');
      if (m.exports.includes('video') && m.animated) want.add('video'); // a picture exports video only when the mode moves
      expect(new Set(keys), `${m.id} buttons`).toEqual(want);
      expect(keys.length, `${m.id} no duplicate buttons`).toBe(want.size);
      // the ANSI colour depth selector belongs to modes that export ANSI escapes
      await expect(page.locator('#controls [data-export="ansi-depth"]')).toHaveCount(m.exports.includes('ansi') ? 1 : 0);
    }
    await guard.assertClean(expect);
  });

  test('with a video source, video export appears exactly for the modes that declare it', async ({ page }) => {
    await gotoApp(page);
    await loadVideo(page);
    const modes = await page.evaluate(async () => (await import('/src/modes/index.js')).MODES.map((m) => ({ id: m.id, exports: m.exports })));
    for (const m of modes) {
      await pick(page, m.id);
      await expect(page.locator('#controls [data-export="video"]')).toHaveCount(m.exports.includes('video') ? 1 : 0);
    }
  });

  test('a mode cannot be registered with an export it cannot produce', async ({ page }) => {
    await gotoApp(page);
    // the registry check runs at load time: every declared format must have its function
    const res = await page.evaluate(async () => {
      const { MODES } = await import('/src/modes/index.js');
      const fn = { txt: 'toText', html: 'toText', ansi: 'toText', ans: 'toBinary', svg: 'toSVG', json: 'toJSON' };
      const bad = [];
      for (const m of MODES) for (const e of m.exports) if (fn[e] && typeof m[fn[e]] !== 'function') bad.push(`${m.id}:${e}`);
      return bad;
    });
    expect(res).toEqual([]);
  });
});

test.describe('animated modes on still images (PLAN.md 5.7)', () => {
  test('every animated mode keeps rendering a still picture; still modes stay idle', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const modes = await page.evaluate(async () => (await import('/src/modes/index.js')).MODES.map((m) => ({ id: m.id, animated: !!m.animated })));
    expect(modes.some((m) => m.animated)).toBe(true);
    for (const m of modes) {
      await pick(page, m.id);
      // a still mode may render once more at the zoom-matched resolution (160 ms debounce): let that pass first
      if (!m.animated) await settle(page, 350);
      const a = await renderCount(page);
      await page.waitForTimeout(600);
      const b = await renderCount(page);
      if (m.animated) expect(b - a, `${m.id} keeps looping`).toBeGreaterThanOrEqual(4);
      else expect(b, `${m.id} idle on a still picture`).toBe(a);
    }
    await guard.assertClean(expect);
  });
});
