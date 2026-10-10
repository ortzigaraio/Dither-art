// SEO and sharing (PLAN.md 12 phase 7, 17): Open Graph / Twitter metadata from config.siteUrl, canonical link,
// a valid web manifest with the brand icon, and the generated OG image at the right size.
import { test, expect } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchPage, gotoApp } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** Width and height from a PNG header. */
function pngSize(buf) {
  expect(buf.subarray(1, 4).toString()).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test.describe('seo and share metadata', () => {
  test('Open Graph, Twitter and canonical use config.siteUrl', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const siteUrl = await page.evaluate(async () => (await import('/src/config.js')).config.siteUrl);
    expect(siteUrl).toBe('https://dither.ortzigar.org/');
    const meta = await page.evaluate(() => {
      const get = (sel) => document.head.querySelector(sel)?.getAttribute('content') ?? null;
      return {
        canonical: document.head.querySelector('link[rel="canonical"]')?.getAttribute('href'),
        description: get('meta[name="description"]'),
        ogType: get('meta[property="og:type"]'),
        ogTitle: get('meta[property="og:title"]'),
        ogDesc: get('meta[property="og:description"]'),
        ogUrl: get('meta[property="og:url"]'),
        ogImage: get('meta[property="og:image"]'),
        ogW: get('meta[property="og:image:width"]'),
        ogH: get('meta[property="og:image:height"]'),
        ogAlt: get('meta[property="og:image:alt"]'),
        card: get('meta[name="twitter:card"]'),
        twTitle: get('meta[name="twitter:title"]'),
        twImage: get('meta[name="twitter:image"]'),
        theme: get('meta[name="theme-color"]'),
        manifest: document.head.querySelector('link[rel="manifest"]')?.getAttribute('href'),
      };
    });
    expect(meta.canonical).toBe(siteUrl);
    expect(meta.ogUrl).toBe(siteUrl);
    expect(meta.ogImage).toBe(`${siteUrl}assets/og-image.png`);
    expect(meta.twImage).toBe(meta.ogImage);
    expect([meta.ogW, meta.ogH]).toEqual(['1200', '630']);
    expect(meta.ogType).toBe('website');
    expect(meta.card).toBe('summary_large_image');
    for (const k of ['description', 'ogTitle', 'ogDesc', 'ogAlt', 'twTitle']) expect(meta[k]?.length, k).toBeGreaterThan(10);
    expect(meta.description.length).toBeLessThanOrEqual(200);
    expect(meta.theme).toMatch(/^#[0-9a-f]{6}$/i);
    expect(meta.manifest).toBe('./site.webmanifest');
    // the CSP meta is still the first tag of <head>
    expect(await page.evaluate(() => document.head.firstElementChild.getAttribute('http-equiv'))).toBe('Content-Security-Policy');
    await guard.assertClean(expect);
  });

  test('the web manifest is valid JSON with the brand icon and relative paths', async ({ page, request }) => {
    const res = await request.get('/site.webmanifest');
    expect(res.ok()).toBe(true);
    const m = JSON.parse(await res.text());
    expect(m.name).toBe('Dither');
    expect(m.short_name).toBe('Dither');
    expect(m.start_url).toBe('./');
    expect(m.scope).toBe('./');
    expect(m.display).toBe('standalone');
    for (const k of ['background_color', 'theme_color']) expect(m[k]).toMatch(/^#[0-9A-F]{6}$/i);
    expect(m.icons.some((i) => i.src === 'assets/icons/dither-icon.svg' && i.type === 'image/svg+xml')).toBe(true);
    for (const size of ['192x192', '512x512']) expect(m.icons.some((i) => i.sizes === size && i.type === 'image/png')).toBe(true);
    for (const icon of m.icons) {
      expect(icon.src.startsWith('/') || /^https?:/.test(icon.src)).toBe(false); // relative: works under /<repo>/ too
      const r = await request.get(`/${icon.src}`);
      expect(r.ok(), icon.src).toBe(true);
      if (icon.type === 'image/png') {
        const [w, h] = icon.sizes.split('x').map(Number);
        expect(pngSize(await r.body())).toEqual({ width: w, height: h });
      }
    }
    // the browser itself accepts the manifest (no console errors, no CSP violation while it loads)
    const guard = watchPage(page);
    await gotoApp(page);
    await page.waitForTimeout(500);
    await guard.assertClean(expect);
  });

  test('assets/og-image.png exists, is 1200x630 and under 1 MB', async () => {
    const file = resolve(root, 'assets/og-image.png');
    const buf = readFileSync(file);
    expect(pngSize(buf)).toEqual({ width: 1200, height: 630 });
    expect(statSync(file).size).toBeLessThan(1024 * 1024);
  });
});
