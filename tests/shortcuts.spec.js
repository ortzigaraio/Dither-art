// Keyboard shortcuts (PLAN.md 4.7) and the "?" help overlay.
import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, loadFixture, setControl, getControl, settle, captureDownload } from './helpers.js';

const current = (page) => page.locator('#mode-list [aria-current="true"]').getAttribute('data-mode-id');

test.describe('keyboard shortcuts', () => {
  test('[ ] cycle modes, R resets, S split, X surprise, E exports PNG, C copies', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => localStorage.clear());
    await gotoApp(page);
    await loadFixture(page);
    const ids = await page.evaluate(async () => (await import('/src/modes/index.js')).MODES.map((m) => m.id));
    await page.locator('#viewer-viewport').focus();
    expect(await current(page)).toBe(ids[0]);
    await page.keyboard.press(']');
    await expect.poll(() => current(page)).toBe(ids[1]);
    await page.keyboard.press('[');
    await page.keyboard.press('[');
    await expect.poll(() => current(page)).toBe(ids[ids.length - 1]); // wraps around
    await page.keyboard.press(']');
    await expect.poll(() => current(page)).toBe(ids[0]);
    await settle(page);

    // R: reset the mode group
    await setControl(page, 'cellSize', 20);
    await page.locator('#viewer-viewport').focus();
    await page.keyboard.press('r');
    await expect.poll(() => getControl(page, 'cellSize')).toBe(12);

    // S: split before / after
    await page.keyboard.press('s');
    await expect(page.locator('#vw-split')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('S');
    await expect(page.locator('#vw-split')).toHaveAttribute('aria-pressed', 'false');

    // X: surprise me changes the mode parameters
    const before = await page.evaluate(() => JSON.stringify([...document.querySelectorAll('#controls [data-group="mode"] select, #controls [data-group="mode"] .ctl-num')].map((x) => x.value)));
    await page.keyboard.press('x');
    await expect.poll(() => page.evaluate(() => JSON.stringify([...document.querySelectorAll('#controls [data-group="mode"] select, #controls [data-group="mode"] .ctl-num')].map((x) => x.value)))).not.toBe(before);
    await settle(page);

    // E: PNG download
    const dl = await captureDownload(page, () => page.keyboard.press('e'));
    expect(dl.name).toMatch(/^dither-ascii-.*\.png$/);
    expect(dl.bytes.subarray(1, 4).toString()).toBe('PNG');

    // C: copy the text of a text mode
    await page.keyboard.press('c');
    await expect(page.locator('#toasts')).toContainText('Copied');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text.split('\n').length).toBeGreaterThan(10);
    await guard.assertClean(expect);
  });

  test('shortcuts never fire while typing, with modifiers, or on the home page', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    // home: no studio shortcuts (but ? still opens the help)
    await page.keyboard.press(']');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'home');
    await loadFixture(page);
    const start = await current(page);
    // typing in a text field
    await setControl(page, 'gradient', 'custom');
    const field = page.locator('#controls [data-param="customGradient"] input');
    await field.fill('');
    await field.type('[]rRsxe?');
    await expect(field).toHaveValue('[]rRsxe?');
    expect(await current(page)).toBe(start);
    await expect(page.locator('#vw-split')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#keys-dialog')).toHaveCount(0);
    // with a modifier
    await page.locator('#viewer-viewport').focus();
    await page.keyboard.press('Control+]');
    await page.keyboard.press('Alt+s');
    expect(await current(page)).toBe(start);
    await expect(page.locator('#vw-split')).toHaveAttribute('aria-pressed', 'false');
    await guard.assertClean(expect);
  });

  test('? opens an accessible help overlay listing the shortcuts; Esc closes it', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await page.keyboard.press('?');
    const dlg = page.locator('#keys-dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg).toHaveAttribute('aria-labelledby', 'keys-title');
    await expect(page.locator('#keys-title')).toHaveText(/shortcuts/i);
    const keys = await dlg.locator('kbd').allTextContents();
    for (const k of ['[', ']', 'R', 'E', 'C', 'F', 'S', '?']) expect(keys).toContain(k);
    await expect(dlg.locator('[data-keys="close"]')).toBeFocused();
    // other shortcuts are inert while it is open
    await page.keyboard.press(']');
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);

    // the toolbar button opens it too, in the current language
    await loadFixture(page);
    await page.click('[data-lang="es"]');
    await page.click('#vw-keys');
    await expect(page.locator('#keys-title')).toHaveText('Atajos de teclado');
    await page.click('#keys-dialog [data-keys="close"]');
    await expect(page.locator('#keys-dialog')).toHaveCount(0);
    await expect(page.locator('#vw-keys')).toHaveAttribute('aria-keyshortcuts', '?');
    await guard.assertClean(expect);
  });
});
