import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, FIXTURE_PNG } from './helpers.js';

const THEMES = {
  horain: { tone: 'dark', bg: '#15181e', accent: '#c4f169' },
  claro: { tone: 'light', bg: '#f7f8fa', accent: '#c4f169' },
  amber: { tone: 'dark', bg: '#0b0b0a', accent: '#ffb000' },
  crt: { tone: 'dark', bg: '#050a06', accent: '#39ff6a' },
  paper: { tone: 'light', bg: '#efece4', accent: '#e5402a' },
  cad: { tone: 'dark', bg: '#0d2a4a', accent: '#7fd4ff' },
};

test.describe('1. page load', () => {
  test('loads without console errors or CSP violations', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await expect(page.locator('#hero-title')).toBeVisible();
    await expect(page.locator('#dropzone')).toBeVisible();
    // CSP meta must be the first tag of <head>
    const first = await page.evaluate(() => document.head.firstElementChild.getAttribute('http-equiv'));
    expect(first).toBe('Content-Security-Policy');
    await guard.assertClean(expect);
  });
});

test.describe('3. themes and language', () => {
  test('every theme applies, shows the right logo and is remembered', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    for (const [id, th] of Object.entries(THEMES)) {
      await page.selectOption('#theme-select', id);
      const html = page.locator('html');
      await expect(html).toHaveAttribute('data-theme', id);
      await expect(html).toHaveAttribute('data-tone', th.tone);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const [r, g, b] = bg.match(/\d+/g).map(Number);
      // CAD paints a grid over its background colour: compare the token instead of the pixel
      const token = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toLowerCase());
      expect(token).toBe(th.bg);
      if (id !== 'cad') expect('#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')).toBe(th.bg);
      const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase());
      expect(accent).toBe(th.accent);

      // Header logo: exactly the dark-bg SVG on dark themes, the light-bg SVG on light themes
      const visible = page.locator('.site-header .logo:visible');
      await expect(visible).toHaveCount(1);
      await expect(visible).toHaveAttribute('src', th.tone === 'dark' ? /horain-espino-on-dark\.svg$/ : /horain-espino\.svg$/);
      const loaded = await visible.evaluate((img) => img.complete && img.naturalWidth > 0);
      expect(loaded).toBe(true);
    }
    // persisted across reloads
    await page.selectOption('#theme-select', 'amber');
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'amber');
    await expect(page.locator('#theme-select')).toHaveValue('amber');
    await guard.assertClean(expect);
  });

  test('ES/EN toggle translates the page and is remembered', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await page.click('.lang-toggle [data-lang="es"]');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.locator('.dz-title')).toHaveText('Arrastra y suelta un archivo aquí, o haz clic para seleccionarlo');
    await expect(page.locator('.hero-title')).toContainText('convierte imágenes y video en');
    await expect(page.locator('.lang-toggle [data-lang="es"]')).toHaveAttribute('aria-pressed', 'true');

    await page.click('.lang-toggle [data-lang="en"]');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('.dz-title')).toHaveText('Upload a file by dragging and dropping it here, or click here to select file');
    await expect(page.locator('.hero-title')).toContainText('turn images & video into');

    await page.click('.lang-toggle [data-lang="es"]');
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await guard.assertClean(expect);
  });

  test('initial language follows the browser (es* -> ES, otherwise EN)', async ({ browser }) => {
    for (const [locale, expected] of [['es-ES', 'es'], ['de-DE', 'en']]) {
      const ctx = await browser.newContext({ locale });
      const page = await ctx.newPage();
      await gotoApp(page);
      await expect(page.locator('html')).toHaveAttribute('lang', expected);
      await ctx.close();
    }
  });

  test('prefers-color-scheme: light selects the CLARO theme when nothing was chosen', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'light' });
    const page = await ctx.newPage();
    await gotoApp(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'claro');
    await ctx.close();
  });
});

test.describe('5. guardrails: file input', () => {
  test('a text file renamed to .png is rejected with a toast and the app stays usable', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await page.setInputFiles('#file-input', {
      name: 'evil.png',
      mimeType: 'image/png',
      buffer: Buffer.from('this is definitely not a png, just text pretending to be one'),
    });
    await expect(page.locator('.toast-error')).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-view', 'home');
    await expect(page.locator('#dropzone')).toBeVisible();
    await guard.assertClean(expect);
  });
});

test.describe('Phase 0 acceptance', () => {
  test('dropping an image opens the studio and shows it in the viewer', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await page.setInputFiles('#file-input', FIXTURE_PNG);
    await expect(page.locator('body')).toHaveAttribute('data-view', 'studio');
    await expect(page.locator('#viewer-canvas')).toBeVisible();
    await guard.assertClean(expect);
  });
});
