// Small UI utilities: scramble micro-interaction, toasts.
import { test, expect } from '@playwright/test';
import { watchPage, gotoApp } from './helpers.js';

test.describe('ui utilities', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('scramble resolves to the final text within 300 ms and passes through random characters', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const { scramble } = await import('/src/ui/scramble.js');
      const el = document.createElement('span');
      document.body.appendChild(el);
      const seen = new Set();
      const t0 = performance.now();
      scramble(el, 'MODE: ASCII ART');
      await new Promise((resolve) => {
        const tick = () => {
          seen.add(el.textContent);
          if (el.textContent === 'MODE: ASCII ART' && performance.now() - t0 > 50) resolve();
          else requestAnimationFrame(tick);
        };
        tick();
      });
      const ms = performance.now() - t0;
      el.remove();
      return { ms, frames: seen.size, final: 'MODE: ASCII ART', spacesKept: [...seen].filter(Boolean).every((s) => s.length === 15 && s[5] === ' ' && s[11] === ' ') };
    });
    expect(res.ms).toBeLessThan(450); // 280 ms of animation plus frame granularity
    expect(res.frames).toBeGreaterThan(3);
    expect(res.spacesKept).toBe(true);
  });

  test('scramble does nothing but set the text when motion is reduced', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await gotoApp(page);
    const frames = await page.evaluate(async () => {
      const { scramble } = await import('/src/ui/scramble.js');
      const el = document.createElement('span');
      document.body.appendChild(el);
      scramble(el, 'FINAL');
      return el.textContent;
    });
    expect(frames).toBe('FINAL');
    await ctx.close();
  });

  test('toasts: same message collapses, at most four are shown, text is never parsed as HTML', async ({ page }) => {
    const guard = watchPage(page);
    const res = await page.evaluate(async () => {
      const { toast } = await import('/src/ui/toast.js');
      const host = document.getElementById('toasts');
      toast('same', { timeout: 0 });
      toast('same', { timeout: 0 });
      const afterDup = host.children.length;
      for (let i = 0; i < 10; i++) toast(`message ${i}`, { timeout: 0 });
      const afterMany = host.children.length;
      toast('<img src=x onerror=window.__pwned=1><b>bold</b>', { timeout: 0 });
      const last = host.lastElementChild;
      return {
        afterDup, afterMany, imgs: host.querySelectorAll('img, b').length, text: last.querySelector('.toast-msg').textContent,
        role: last.getAttribute('role'), pwned: window.__pwned,
      };
    });
    expect(res.afterDup).toBe(1);
    expect(res.afterMany).toBe(4);
    expect(res.imgs).toBe(0);
    expect(res.text).toBe('<img src=x onerror=window.__pwned=1><b>bold</b>');
    expect(res.role).toBe('status');
    expect(res.pwned).toBeUndefined();
    // errors are announced assertively, and the close button dismisses
    await page.evaluate(async () => {
      const { toastError } = await import('/src/ui/toast.js');
      document.getElementById('toasts').replaceChildren();
      toastError('broken', { timeout: 0 });
    });
    await expect(page.locator('.toast-error')).toHaveAttribute('role', 'alert');
    await page.locator('.toast-close').click();
    await expect(page.locator('.toast')).toHaveCount(0);
    await guard.assertClean(expect);
  });

  test('toasts disappear by themselves', async ({ page }) => {
    await page.evaluate(async () => {
      const { toast } = await import('/src/ui/toast.js');
      toast('short lived', { timeout: 300 });
    });
    await expect(page.locator('.toast')).toHaveCount(1);
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 3000 });
  });
});
