// Accessibility and mobile pass (PLAN.md 1.7, 4.3, 12 phase 7): axe-core (vendored as a dev dependency of tests/
// only, never shipped) on the home page and the studio in all six themes and on a phone, no horizontal page scroll
// at 320 / 360 / 390 px, labels, landmarks and keyboard focus order.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { watchPage, gotoApp, loadFixture } from './helpers.js';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const THEMES = ['horain', 'claro', 'amber', 'crt', 'paper', 'cad'];
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

/** Run axe in the page (evaluated through the DevTools protocol, so the page CSP is untouched). */
async function axe(page) {
  await page.evaluate(AXE);
  return page.evaluate(async (tags) => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: tags } });
    return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }, TAGS);
}

test.describe('axe-core', () => {
  test('home page: no violations in any theme or language', async ({ page }) => {
    test.setTimeout(120_000);
    const guard = watchPage(page);
    await gotoApp(page);
    for (const theme of THEMES) {
      await page.selectOption('#theme-select', theme);
      await page.waitForTimeout(200);
      expect(await axe(page), theme).toEqual([]);
    }
    await page.click('[data-lang="es"]');
    await page.waitForTimeout(200); // let the toggle's colour transition finish, as after each theme change
    expect(await axe(page), 'es').toEqual([]);
    await guard.assertClean(expect);
  });

  test('studio (every group open): no violations in any theme', async ({ page }) => {
    test.setTimeout(180_000);
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    await page.evaluate(() => document.querySelectorAll('#controls details').forEach((d) => { d.open = true; }));
    for (const theme of THEMES) {
      await page.selectOption('#theme-select', theme);
      await page.waitForTimeout(200);
      expect(await axe(page), theme).toEqual([]);
    }
    // a 3D mode (camera button, depth group) and a vector mode (SVG page options)
    for (const id of ['hiddenwire', 'contours']) {
      await page.click(`#mode-list [data-mode-id="${id}"]`);
      await page.evaluate(() => document.querySelectorAll('#controls details').forEach((d) => { d.open = true; }));
      await page.waitForTimeout(300);
      expect(await axe(page), id).toEqual([]);
    }
    await guard.assertClean(expect);
  });

  test('phone studio, the shortcuts dialog and the counter: no violations', async ({ page }) => {
    const guard = watchPage(page);
    await page.setViewportSize({ width: 360, height: 740 });
    await gotoApp(page);
    await loadFixture(page);
    for (const tab of ['image', 'mode', 'color', 'fx', 'export']) {
      await page.click(`.sheet-tab[data-tab="${tab}"]`);
      expect(await axe(page), tab).toEqual([]);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('#vw-keys');
    await expect(page.locator('#keys-dialog')).toBeVisible();
    expect(await axe(page), 'shortcuts dialog').toEqual([]);
    await guard.assertClean(expect);
  });
});

test.describe('mobile layout', () => {
  for (const width of [320, 360, 390]) {
    test(`no horizontal page scroll at ${width} px (home and every settings tab, ES and EN)`, async ({ page }) => {
      const guard = watchPage(page);
      await page.setViewportSize({ width, height: 760 });
      for (const lang of ['es', 'en']) {
        await page.addInitScript((l) => localStorage.setItem('horain.lang', l), lang);
        await gotoApp(page);
        const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(await overflow(), `${lang} home`).toBe(0);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        expect(await overflow(), `${lang} home bottom`).toBe(0);
        await loadFixture(page);
        await expect(page.locator('#sheet-tabs')).toBeVisible();
        for (const tab of ['image', 'mode', 'color', 'fx', 'export']) {
          await page.click(`.sheet-tab[data-tab="${tab}"]`);
          expect(await overflow(), `${lang} ${tab}`).toBe(0);
          // the tabs themselves fit on screen
          const box = await page.locator(`.sheet-tab[data-tab="${tab}"]`).boundingBox();
          expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
        }
        // the settings sheet sits below the viewer and the mode chips (bottom sheet)
        const viewer = await page.locator('.studio-stage').boundingBox();
        const panel = await page.locator('#studio-panel').boundingBox();
        expect(panel.y).toBeGreaterThan(viewer.y + viewer.height - 1);
      }
      await guard.assertClean(expect);
    });
  }
});

test.describe('keyboard and semantics', () => {
  test('focus order on the home page follows the visual order', async ({ page }) => {
    await gotoApp(page);
    const order = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      order.push(await page.evaluate(() => {
        const a = document.activeElement;
        return a.id || a.dataset.nav || a.dataset.lang || a.dataset.action || a.className || a.tagName;
      }));
    }
    const at = (x) => order.findIndex((o) => String(o).split(' ').includes(x));
    expect(order[0]).toContain('skip-link');
    expect(at('brand')).toBeGreaterThan(0);
    expect(at('studio')).toBeGreaterThan(at('brand'));
    expect(at('theme-select')).toBeGreaterThan(at('studio'));
    expect(at('es')).toBeGreaterThan(at('theme-select'));
    expect(at('dz-pick')).toBeGreaterThan(at('es'));
    expect(at('demo')).toBeGreaterThan(at('dz-pick'));
    // the skip link jumps to <main>
    await page.keyboard.press('Shift+Tab');
    await gotoApp(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
  });

  test('studio: landmarks, visible focus, labelled controls, reset buttons outside the summaries', async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
    await expect(page.locator('h1:visible')).toHaveCount(1);
    await expect(page.locator('#studio')).toHaveAttribute('aria-labelledby', 'studio-h1');
    expect(await page.locator('main aside').count()).toBe(0); // no complementary landmark nested in main
    // every form control in the panel has an accessible name
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('#controls input, #controls select, #controls button')]
      .filter((el) => !el.hidden && !el.closest('[hidden]'))
      .filter((el) => {
        const id = el.id;
        const label = id ? document.querySelector(`label[for="${id}"]`) : null;
        return !(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (label && label.textContent.trim()) || el.textContent.trim() || el.title);
      }).map((el) => el.outerHTML.slice(0, 80)));
    expect(unnamed).toEqual([]);
    expect(await page.locator('summary button, summary input, summary a').count()).toBe(0);
    // keyboard focus is visible: an outline on buttons; sliders draw a ring on their thumb (CSS rule present)
    const slider = page.locator('#controls [data-param="brightness"] input[type="range"]');
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    expect(await slider.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
    const ring = await page.evaluate(() => [...document.styleSheets].some((sh) => { try { return [...sh.cssRules].some((r) => /\.range:focus-visible::-webkit-slider-thumb/.test(r.selectorText || '') && /box-shadow/.test(r.cssText)); } catch { return false; } }));
    expect(ring).toBe(true);
    const reset = page.locator('#controls [data-group="image"] .group-reset');
    await reset.focus();
    const outline = await reset.evaluate((el) => { const cs = getComputedStyle(el); return `${cs.outlineStyle} ${cs.outlineWidth}`; });
    expect(outline).not.toMatch(/^none|0px$/);
    // a group reset still works from the keyboard
    await page.locator('#controls [data-group="image"] .group-reset').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#controls [data-param="brightness"] .ctl-num')).toHaveValue('100');
  });
});
