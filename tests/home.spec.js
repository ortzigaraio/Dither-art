// Home view (PLAN.md 4.3): the hero tours several modes; the gallery thumbnails loop, lazily and cheaply.
import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, canvasStats } from './helpers.js';

test.describe('home: hero and gallery', () => {
  test('the hero demo rotates through modes of several categories, not only ASCII', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await page.waitForFunction(() => !document.getElementById('hero-demo').hidden);
    const seen = new Set();
    for (let i = 0; i < 14; i++) {
      seen.add(await page.locator('#hero-demo').getAttribute('data-mode'));
      await page.waitForTimeout(1000);
    }
    seen.delete(null);
    expect(seen.size).toBeGreaterThanOrEqual(3);
    const cats = await page.evaluate(async (ids) => {
      const { getMode } = await import('/src/modes/index.js');
      return [...new Set(ids.map((id) => getMode(id).category))];
    }, [...seen]);
    expect(cats.length).toBeGreaterThanOrEqual(2);
    expect((await canvasStats(page, '#hero-canvas')).variance).toBeGreaterThan(0);
    await guard.assertClean(expect);
  });

  test('gallery thumbnails render lazily and loop while on screen', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const cards = page.locator('#mode-grid .mode-card');
    const n = await cards.count();
    // far-away cards have not rendered anything yet (lazy)
    expect(await cards.nth(n - 1).getAttribute('data-thumb')).toBe(null);
    const card = page.locator('#mode-grid .mode-card[data-mode-id="matrix"]');
    await card.scrollIntoViewIfNeeded();
    await expect(card).toHaveAttribute('data-thumb', 'loop', { timeout: 30_000 });
    const hashes = new Set();
    for (let i = 0; i < 6; i++) {
      hashes.add((await canvasStats(page, '#mode-grid .mode-card[data-mode-id="matrix"] canvas')).hash);
      await page.waitForTimeout(350);
    }
    expect(hashes.size).toBeGreaterThan(1);
    // every available mode gets at least a still thumbnail once scrolled into view (3D / simulation included)
    for (let i = 0; i < n; i++) {
      const c = cards.nth(i);
      if (await c.getAttribute('aria-disabled')) continue;
      await c.scrollIntoViewIfNeeded();
      await expect(c).toHaveAttribute('data-thumb', /ready|loop/, { timeout: 60_000 });
      expect((await canvasStats(page, `#mode-grid .mode-card[data-mode-id="${await c.getAttribute('data-mode-id')}"] canvas`)).variance).toBeGreaterThan(0);
    }
    await guard.assertClean(expect);
  });

  test('reduced motion: thumbnails are still pictures', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const guard = watchPage(page);
    await gotoApp(page);
    const card = page.locator('#mode-grid .mode-card[data-mode-id="matrix"]');
    await card.scrollIntoViewIfNeeded();
    await expect(card).toHaveAttribute('data-thumb', 'ready', { timeout: 30_000 });
    const a = await canvasStats(page, '#mode-grid .mode-card[data-mode-id="matrix"] canvas');
    await page.waitForTimeout(1200);
    const b = await canvasStats(page, '#mode-grid .mode-card[data-mode-id="matrix"] canvas');
    expect(b.hash).toBe(a.hash);
    await expect(card).toHaveAttribute('data-thumb', 'ready');
    await guard.assertClean(expect);
    await ctx.close();
  });
});
