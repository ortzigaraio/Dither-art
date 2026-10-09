import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import {
  watchPage, gotoApp, FIXTURE_PNG, SCREENSHOT_DIR, loadFixture, renderCount, waitForRender, settle,
  canvasStats, setControl, getControl, resetAll,
} from './helpers.js';

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

// ---------------------------------------------------------------------------
// 2. Every registered mode renders a non-uniform canvas
// ---------------------------------------------------------------------------
test.describe('2. modes', () => {
  test('each registered mode renders a non-blank canvas (screenshots in tests/screenshots)', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const ids = await page.evaluate(async () => (await import('/src/modes/index.js')).MODE_IDS);
    expect(ids.length).toBeGreaterThan(0);
    await loadFixture(page);
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    for (const id of ids) {
      const item = page.locator(`#mode-list .mode-item[data-mode-id="${id}"]`);
      if ((await item.getAttribute('aria-current')) !== 'true') {
        const before = await renderCount(page);
        await item.click();
        await waitForRender(page, before);
      }
      const stats = await canvasStats(page);
      expect(stats.variance, `${id}: pixel variance`).toBeGreaterThan(0);
      expect(stats.colors, `${id}: distinct colours`).toBeGreaterThan(1);
      expect(await page.locator('#chip-error').isHidden(), `${id}: no mode error chip`).toBe(true);
      await page.locator('#viewer-viewport').screenshot({ path: `${SCREENSHOT_DIR}/${id}.png` });
    }
    await guard.assertClean(expect);
  });
});

// ---------------------------------------------------------------------------
// 4. ASCII text export
// ---------------------------------------------------------------------------
async function download(page, selector) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(selector)]);
  const path = await dl.path();
  return { name: dl.suggestedFilename(), buf: readFileSync(path) };
}

test.describe('4. ASCII exports', () => {
  test('TXT has `rows` lines of `cols` characters', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const { cols, rows } = await page.evaluate(() => {
      const c = document.getElementById('viewer-canvas');
      return { cols: Number(c.dataset.cols), rows: Number(c.dataset.rows) };
    });
    expect(cols).toBe(120);
    expect(rows).toBeGreaterThan(10);
    const { name, buf } = await download(page, '[data-export="txt"]');
    expect(name).toMatch(/^dither-ascii-\d{8}-\d{6}\.txt$/);
    const text = buf.toString('utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.slice(0, -1).split('\n');
    expect(lines).toHaveLength(rows);
    for (const line of lines) expect(Array.from(line)).toHaveLength(cols);
    // only characters of the default gradient
    expect(text.replace(/\n/g, '')).toMatch(/^[ .:\-=+*#%@]+$/);
    await guard.assertClean(expect);
  });

  test('TXT follows the columns control', async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
    const before = await renderCount(page);
    await setControl(page, 'cols', 40);
    await waitForRender(page, before);
    const { buf } = await download(page, '[data-export="txt"]');
    const lines = buf.toString('utf8').slice(0, -1).split('\n');
    for (const line of lines) expect(Array.from(line)).toHaveLength(40);
    expect(lines.length).toBe(Number(await page.locator('#viewer-canvas').getAttribute('data-rows')));
  });

  test('HTML export escapes & < > " \' from a custom gradient', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    let before = await renderCount(page);
    await setControl(page, 'gradient', 'custom');
    await waitForRender(page, before);
    before = await renderCount(page);
    await setControl(page, 'customGradient', `<>&"'`);
    await waitForRender(page, before);
    // a hostile payload as well
    const { buf } = await download(page, '[data-export="html"]');
    const html = buf.toString('utf8');
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
    const parsed = await page.evaluate((src) => {
      const doc = new DOMParser().parseFromString(src, 'text/html');
      const pre = doc.querySelector('pre');
      return {
        children: Array.from(pre.querySelectorAll('*')).map((e) => e.tagName),
        scripts: doc.querySelectorAll('script, img, iframe, svg').length,
        text: pre.textContent,
      };
    }, html);
    expect(parsed.scripts).toBe(0);
    expect(parsed.children.every((t) => t === 'SPAN')).toBe(true);
    expect(parsed.text).toMatch(/[<>&"']/);
    await guard.assertClean(expect);
  });

  test('HTML export never lets a hostile custom gradient become markup', async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
    let before = await renderCount(page);
    await setControl(page, 'gradient', 'custom');
    await waitForRender(page, before);
    before = await renderCount(page);
    await setControl(page, 'customGradient', `<img src=x onerror=alert(1)>`);
    await waitForRender(page, before);
    const { buf } = await download(page, '[data-export="html"]');
    const html = buf.toString('utf8');
    expect(html).not.toMatch(/<img/i);
    const parsed = await page.evaluate((src) => {
      const doc = new DOMParser().parseFromString(src, 'text/html');
      return { bad: doc.querySelectorAll('img, script, iframe').length, spans: doc.querySelectorAll('pre *').length };
    }, html);
    expect(parsed.bad).toBe(0);
  });

  test('ANSI export uses 24-bit escapes by default and 16 colours on request', async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
    let before = await renderCount(page);
    await setControl(page, 'colorMode', 'original');
    await waitForRender(page, before);
    let { name, buf } = await download(page, '[data-export="ansi"]');
    expect(name).toMatch(/\.ansi\.txt$/);
    let text = buf.toString('utf8');
    expect(text).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    expect(text.split('\n').filter(Boolean).every((l) => l.endsWith('\x1b[0m'))).toBe(true);
    await page.locator('[data-export="ansi-depth"]').selectOption('16');
    ({ buf } = await download(page, '[data-export="ansi"]'));
    text = buf.toString('utf8');
    expect(text).not.toMatch(/38;2;/);
    expect(text).toMatch(/\x1b\[(3\d|9\d)m/);
    await page.locator('[data-export="ansi-depth"]').selectOption('256');
    ({ buf } = await download(page, '[data-export="ansi"]'));
    expect(buf.toString('utf8')).toMatch(/\x1b\[38;5;\d+m/);
  });

  test('PNG export honours the scale (1x / 2x) and is a real PNG', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const dims = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
    let { name, buf } = await download(page, '[data-export="png"]');
    expect(name).toMatch(/^dither-ascii-\d{8}-\d{6}\.png$/);
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const one = dims(buf);
    await page.locator('[data-export="png-scale"]').selectOption('2');
    ({ buf } = await download(page, '[data-export="png"]'));
    const two = dims(buf);
    expect(Math.abs(two.w - one.w * 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(two.h - one.h * 2)).toBeLessThanOrEqual(1);
    await guard.assertClean(expect);
  });

  test('copy text and copy image use the clipboard', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    await page.click('[data-export="copy-text"]');
    await expect(page.locator('.toast')).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const { cols, rows } = await page.evaluate(() => {
      const c = document.getElementById('viewer-canvas');
      return { cols: Number(c.dataset.cols), rows: Number(c.dataset.rows) };
    });
    const lines = clip.slice(0, -1).split('\n');
    expect(lines).toHaveLength(rows);
    expect(Array.from(lines[0])).toHaveLength(cols);

    await page.click('[data-export="copy-image"]');
    await expect.poll(async () => page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      return items.flatMap((i) => i.types);
    })).toContain('image/png');
    await guard.assertClean(expect);
  });
});
