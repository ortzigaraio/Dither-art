// Presets, "Surprise me" and share links (PLAN.md 10, 18.3).
import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  watchPage, gotoApp, loadFixture, setControl, getControl, settle, canvasStats, captureDownload, renderCount, waitForRender,
} from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'dither-presets-'));
const file = (name, text) => { const p = join(tmp, name); writeFileSync(p, text); return p; };
const presetGroup = (page) => page.locator('#controls [data-group="presets"]');
const toastText = (page) => page.locator('#toasts').innerText();

test.describe('presets', () => {
  test('every curated preset of every mode is valid data (survives validation unchanged)', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const problems = await page.evaluate(async () => {
      const { MODES } = await import('/src/modes/index.js');
      const { defaultState } = await import('/src/state.js');
      const { stateWithPreset } = await import('/src/presets.js');
      const out = [];
      let count = 0;
      for (const m of MODES) {
        for (const p of m.presets || []) {
          count++;
          if (!p.id || !p.name?.es || !p.name?.en) out.push(`${m.id}: preset without id/name`);
          const next = stateWithPreset(defaultState(), m.id, p);
          if (!next || next.modeId !== m.id) { out.push(`${m.id}/${p.id}: rejected`); continue; }
          for (const [k, v] of Object.entries(p.mode || {})) {
            if (JSON.stringify(next.modes[m.id][k]) !== JSON.stringify(v)) out.push(`${m.id}/${p.id}: mode.${k} ${JSON.stringify(v)} -> ${JSON.stringify(next.modes[m.id][k])}`);
          }
          for (const grp of ['global', 'color', 'depth', 'postfx']) {
            for (const [k, v] of Object.entries(p[grp] || {})) {
              if (JSON.stringify(next[grp][k]) !== JSON.stringify(v)) out.push(`${m.id}/${p.id}: ${grp}.${k}`);
            }
          }
        }
        if (!(m.presets || []).length) out.push(`${m.id}: no curated presets`);
      }
      return { out, count };
    });
    expect(problems.out).toEqual([]);
    expect(problems.count).toBeGreaterThanOrEqual(50);
    await guard.assertClean(expect);
  });

  test('curated presets apply from the panel and change the picture', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const group = presetGroup(page);
    await expect(group.locator('[data-preset="classic"]')).toBeVisible();
    const before = await canvasStats(page);
    let n = await renderCount(page);
    await group.locator('[data-preset="matrix"]').click();
    await waitForRender(page, n);
    expect(await getControl(page, 'gradient')).toBe('katakana');
    expect((await getControl(page, 'ink')).toLowerCase()).toBe('#00ff41');
    expect((await canvasStats(page)).hash).not.toBe(before.hash);
    expect(await toastText(page)).toContain('Matrix');
    n = await renderCount(page);
    await group.locator('[data-preset="classic"]').click();
    await waitForRender(page, n);
    expect(await getControl(page, 'gradient')).toBe('standard');
    // a preset also works in another mode (thermal: selects of its own schema)
    await page.click('#mode-list [data-mode-id="thermal"]');
    await settle(page);
    await presetGroup(page).locator('[data-preset="predator"]').click();
    await settle(page);
    expect(await getControl(page, 'thermalPalette')).toBe('turbo');
    expect(await getControl(page, 'source')).toBe('heat');
    await guard.assertClean(expect);
  });

  test('save, export, import: a JSON round trip restores the settings', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => { if (!sessionStorage.getItem('x')) { localStorage.clear(); sessionStorage.setItem('x', '1'); } });
    await gotoApp(page);
    await loadFixture(page);
    await setControl(page, 'gradient', 'blocks');
    await setControl(page, 'cellSize', 17);
    await setControl(page, 'contrast', 140);
    await setControl(page, 'scanlines', 30, 'postfx');
    const group = presetGroup(page);
    await group.locator('[data-preset="name"]').fill('My look');
    await group.locator('[data-preset="save"]').click();
    await expect(group.locator('[data-preset="user-select"] option')).toHaveText(['My look']);
    // survives a reload (localStorage, validated)
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await loadFixture(page);
    await expect(presetGroup(page).locator('[data-preset="user-select"] option')).toHaveText(['My look']);

    const dl = await captureDownload(page, () => presetGroup(page).locator('[data-preset="export"]').click());
    expect(dl.name).toMatch(/^dither-ascii-\d{8}-\d{6}\.preset\.json$/);
    const json = JSON.parse(dl.bytes.toString('utf8'));
    expect(json.format).toBe('dither-preset');
    expect(json.modeId).toBe('ascii');
    expect(json.mode.gradient).toBe('blocks');
    expect(json.mode.cellSize).toBe(17);
    expect(json.global.contrast).toBe(140);
    expect(json.postfx.scanlines).toBe(30);

    // reset everything, then import the file: the values come back
    for (const g of ['image', 'mode', 'postfx']) await page.locator(`#controls [data-group="${g}"] .group-reset`).click();
    await settle(page);
    expect(await getControl(page, 'gradient')).toBe('standard');
    json.name = 'Imported look';
    const chooser = page.waitForEvent('filechooser');
    await presetGroup(page).locator('[data-preset="import"]').click();
    await (await chooser).setFiles(file('look.json', JSON.stringify(json)));
    await expect.poll(() => getControl(page, 'gradient')).toBe('blocks');
    expect(await getControl(page, 'cellSize')).toBe(17);
    expect(await getControl(page, 'contrast')).toBe(140);
    expect(await getControl(page, 'scanlines')).toBe(30);
    await expect(presetGroup(page).locator('[data-preset="user-select"] option')).toHaveText(['Imported look', 'My look']);

    // load and delete a saved preset
    await setControl(page, 'gradient', 'dots');
    await presetGroup(page).locator('[data-preset="user-select"]').selectOption({ label: 'My look' });
    await presetGroup(page).locator('[data-preset="load"]').click();
    await expect.poll(() => getControl(page, 'gradient')).toBe('blocks');
    await presetGroup(page).locator('[data-preset="user-select"]').selectOption({ label: 'My look' });
    await presetGroup(page).locator('[data-preset="delete"]').click();
    await expect(presetGroup(page).locator('[data-preset="user-select"] option')).toHaveText(['Imported look']);
    await guard.assertClean(expect);
  });

  test('hostile imported JSON is rejected or clamped, never executed', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => { if (!sessionStorage.getItem('x')) { localStorage.clear(); sessionStorage.setItem('x', '1'); } });
    await gotoApp(page);
    await loadFixture(page);
    const importFile = async (name, text) => {
      const chooser = page.waitForEvent('filechooser');
      await presetGroup(page).locator('[data-preset="import"]').click();
      await (await chooser).setFiles(file(name, text));
    };
    // not JSON, wrong format, unknown mode, empty bundle, too large: rejected with a message, state unchanged
    const before = await page.evaluate(() => localStorage.getItem('horain.presets'));
    await importFile('a.json', '{not json');
    await expect(page.locator('#toasts')).toContainText(/not valid JSON/);
    await importFile('b.json', JSON.stringify({ format: 'something-else', modeId: 'ascii', mode: {} }));
    await importFile('c.json', JSON.stringify({ modeId: '<script>alert(1)</script>', mode: {} }));
    await importFile('d.json', JSON.stringify({ format: 'dither-presets', presets: [] }));
    await importFile('e.json', JSON.stringify({ modeId: 'ascii', name: 'x'.repeat(300000) }));
    await expect(page.locator('#toasts')).toContainText(/too large/);
    expect(await page.evaluate(() => localStorage.getItem('horain.presets'))).toBe(before);
    expect(await getControl(page, 'gradient')).toBe('standard');

    // values out of range are clamped, unknown keys and prototype tricks are dropped, the name is plain text
    const evil = {
      format: 'dither-preset', modeId: 'ascii', name: '<img src=x onerror="window.__pwned=1">',
      mode: { cellSize: 9999, gradient: 'javascript:alert(1)', lineHeight: 'NaN', __proto__: { polluted: 1 }, extra: 1 },
      global: { contrast: -50, cols: 1e9, constructor: { prototype: { polluted: 1 } } },
      postfx: { chroma: 500, preset: '<b>' },
    };
    const text = JSON.stringify(evil).replace('"extra":1', '"extra":1,"__proto__":{"polluted":1}');
    await importFile('evil.json', text);
    await expect.poll(() => getControl(page, 'cellSize')).toBe(32);
    expect(await getControl(page, 'gradient')).toBe('standard');
    expect(await getControl(page, 'lineHeight')).toBe(1);
    expect(await getControl(page, 'contrast')).toBe(0);
    expect(await getControl(page, 'cols')).toBe(600);
    expect(await getControl(page, 'chroma')).toBe(10);
    const opt = presetGroup(page).locator('[data-preset="user-select"] option').first();
    await expect(opt).toHaveText('<img src=x onerror="window.__pwned=1">');
    expect(await page.evaluate(() => ({ pwned: window.__pwned, polluted: ({}).polluted, imgs: document.querySelectorAll('#controls img, #toasts img').length })))
      .toEqual({ pwned: undefined, polluted: undefined, imgs: 0 });
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('horain.presets')));
    expect(stored[0].mode.cellSize).toBe(32);
    expect('extra' in stored[0].mode).toBe(false);

    // a bundle keeps its valid entries and reports the skipped ones
    await importFile('bundle.json', JSON.stringify({
      format: 'dither-presets', version: 1,
      presets: [{ modeId: 'braille', name: 'ok', mode: { threshold: 90 } }, { modeId: 'nope' }, 42],
    }));
    await expect(page.locator('#toasts')).toContainText(/2 invalid presets were ignored/);
    // the single valid entry was applied: the studio switched to its mode
    await expect(page.locator('#mode-list [data-mode-id="braille"]')).toHaveAttribute('aria-current', 'true');
    // localStorage tampered with by hand is validated as well
    await page.evaluate(() => localStorage.setItem('horain.presets', JSON.stringify([{ modeId: 'braille', name: 'n', mode: { threshold: -4 } }, 'junk', { modeId: 'zzz' }])));
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await loadFixture(page);
    await expect(presetGroup(page).locator('[data-preset="user-select"] option')).toHaveText(['n']);
    await presetGroup(page).locator('[data-preset="load"]').click();
    await expect.poll(() => page.locator('#controls [data-group="mode"] [data-param="threshold"] .ctl-num').inputValue()).toBe('0');
    await guard.assertClean(expect);
  });

  test('storage blocked: saving warns and the app keeps working', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => {
      const deny = () => { throw new DOMException('blocked', 'SecurityError'); };
      Object.defineProperty(window, 'localStorage', { get: deny, configurable: true });
    });
    await gotoApp(page);
    await loadFixture(page);
    await presetGroup(page).locator('[data-preset="name"]').fill('temp');
    await presetGroup(page).locator('[data-preset="save"]').click();
    await expect(page.locator('#toasts')).toContainText(/only lasts this session/);
    await expect(presetGroup(page).locator('[data-preset="user-select"] option')).toHaveText(['temp']);
    await guard.assertClean(expect);
  });

  test('"Surprise me" changes the mode parameters inside their ranges and keeps camera framing', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { MODES } = await import('/src/modes/index.js');
      const { defaultsOf, sanitizeParams } = await import('/src/state.js');
      const { surprise } = await import('/src/presets.js');
      let seed = 7;
      const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
      const bad = [];
      let changed = 0;
      for (const m of MODES) {
        const cur = defaultsOf(m.params);
        const next = surprise(m, cur, rand);
        if (JSON.stringify(sanitizeParams(m.params, next)) !== JSON.stringify(next)) bad.push(`${m.id}: out of schema`);
        if (JSON.stringify(next) !== JSON.stringify(cur)) changed++;
        for (const p of m.params) {
          if (p.random === false && JSON.stringify(next[p.id]) !== JSON.stringify(cur[p.id])) bad.push(`${m.id}.${p.id} should stay`);
          if (p.type === 'range' && Array.isArray(p.randomRange) && (next[p.id] < p.randomRange[0] - 1e-9 || next[p.id] > p.randomRange[1] + 1e-9)) bad.push(`${m.id}.${p.id} outside randomRange`);
          if (p.type === 'text' && next[p.id] !== cur[p.id]) bad.push(`${m.id}.${p.id} text changed`);
        }
      }
      return { bad, changed, total: MODES.length };
    });
    expect(res.bad).toEqual([]);
    expect(res.changed).toBe(res.total);

    await loadFixture(page);
    const before = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('horain.params') || '{}')));
    const n = await renderCount(page);
    await presetGroup(page).locator('[data-preset="surprise"]').click();
    await waitForRender(page, n);
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('horain.params') || '{}')));
    expect(after).not.toBe(before);
    await guard.assertClean(expect);
  });
});

test.describe('share links', () => {
  test('copy link -> open it in a new page -> same mode and settings', async ({ page, context }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    await page.click('#mode-list [data-mode-id="braille"]');
    await settle(page);
    await setControl(page, 'threshold', 77, 'mode');
    await setControl(page, 'brightness', 130);
    await setControl(page, 'vignette', 40, 'postfx');
    await presetGroup(page).locator('[data-preset="share"]').click();
    await expect(page.locator('#toasts')).toContainText('Link copied');
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toMatch(/^http:\/\/localhost:8080\/#s=[A-Za-z0-9_-]+$/);
    expect(await presetGroup(page).locator('[data-preset="share-url"]').inputValue()).toBe(url);
    expect(page.url()).toBe(url);

    const other = await context.newPage();
    const guard2 = watchPage(other);
    await other.addInitScript(() => localStorage.clear());
    await other.goto(url);
    await other.waitForSelector('html[data-ready="true"]');
    await loadFixture(other);
    await expect(other.locator('#mode-list [data-mode-id="braille"]')).toHaveAttribute('aria-current', /true|page/);
    expect(Number(await other.locator('#controls [data-group="mode"] [data-param="threshold"] .ctl-num').inputValue())).toBe(77);
    expect(await getControl(other, 'brightness')).toBe(130);
    expect(await getControl(other, 'vignette')).toBe(40);
    await guard.assertClean(expect);
    await guard2.assertClean(expect);
  });
});
