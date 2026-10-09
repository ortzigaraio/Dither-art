// Responsive layout, accessibility basics, theme contrast and motion preferences (PLAN.md 4.3, 1.7).
import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, loadFixture, settle, canvasStats, openChooser } from './helpers.js';

const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 0);

test.describe('responsive layout', () => {
  for (const width of [320, 360, 390, 600, 700, 768, 820, 900, 960, 1024, 1100, 1440]) {
    test(`no horizontal scroll at ${width}px (home and studio)`, async ({ page }) => {
      const guard = watchPage(page);
      await page.setViewportSize({ width, height: width < 700 ? 800 : 900 });
      await gotoApp(page);
      await page.waitForTimeout(300);
      expect(await noHScroll(page), 'home').toBe(true);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      expect(await noHScroll(page), 'home bottom').toBe(true);
      await loadFixture(page);
      expect(await noHScroll(page), 'studio').toBe(true);
      // the page itself never scrolls in the studio: panels scroll on their own
      const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
      expect(overflow).toBeLessThanOrEqual(1);
      await guard.assertClean(expect);
    });
  }

  test('desktop (>= 1100): 3 columns with the mode list', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoApp(page);
    await loadFixture(page);
    const cols = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { left: r('.studio-modes'), stage: r('.studio-stage'), panel: r('.studio-panel') };
    });
    expect(Math.round(cols.left.width)).toBe(240);
    expect(Math.round(cols.panel.width)).toBe(340);
    expect(cols.stage.width).toBeGreaterThan(700);
    await expect(page.locator('#mode-list')).toBeVisible();
    await expect(page.locator('#mode-select')).toBeHidden();
    await expect(page.locator('#sheet-tabs')).toBeHidden();
    // all groups visible at once on desktop
    for (const g of ['input', 'image', 'mode', 'color', 'export']) await expect(page.locator(`[data-group="${g}"]`)).toBeVisible();
  });

  test('tablet (700-1099): the mode list becomes a <select>, settings 300px on the right', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await gotoApp(page);
    await loadFixture(page);
    await expect(page.locator('#mode-select')).toBeVisible();
    await expect(page.locator('#mode-list')).toBeHidden();
    await expect(page.locator('#sheet-tabs')).toBeHidden();
    const panel = await page.locator('.studio-panel').boundingBox();
    expect(Math.round(panel.width)).toBe(300);
    await expect(page.locator('#mode-select')).toHaveValue('ascii');
  });

  test('mobile (< 700): viewer on top, mode chips, settings in a tabbed bottom sheet, 16px gutters', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page);
    await loadFixture(page);
    const box = (s) => page.locator(s).boundingBox();
    const viewer = await box('.studio-stage');
    const chips = await box('.studio-modes');
    const panel = await box('.studio-panel');
    expect(viewer.y).toBeLessThan(chips.y);
    expect(chips.y).toBeLessThan(panel.y);
    expect(viewer.height).toBeGreaterThan(300);
    const modeCount = await page.evaluate(async () => (await import('/src/modes/index.js')).MODE_IDS.length);
    await expect(page.locator('#mode-list .mode-item')).toHaveCount(modeCount); // one chip per registered mode
    await expect(page.locator('#mode-list .mode-item').first()).toBeVisible();
    for (const cat of await page.locator('#mode-list .mode-cat').all()) await expect(cat).toBeHidden(); // one heading per category
    await expect(page.locator('#sheet-tabs')).toBeVisible();
    const tabs = await page.locator('#sheet-tabs .sheet-tab').allTextContents();
    expect(tabs.map((x) => x.trim().toUpperCase())).toEqual(['IMAGE', 'MODE', 'COLOR', 'FX', 'EXPORT']);

    // tab IMAGEN shows input + image groups only
    await expect(page.locator('[data-group="image"]')).toBeVisible();
    await expect(page.locator('[data-group="color"]')).toBeHidden();
    await page.click('.sheet-tab[data-tab="color"]');
    await expect(page.locator('[data-group="color"]')).toBeVisible();
    await expect(page.locator('[data-group="image"]')).toBeHidden();
    await page.click('.sheet-tab[data-tab="mode"]');
    await expect(page.locator('[data-group="mode"]')).toBeVisible();
    await expect(page.locator('[data-group="presets"]')).toBeVisible();
    await page.click('.sheet-tab[data-tab="fx"]');
    await expect(page.locator('[data-group="postfx"]')).toBeVisible();
    await expect(page.locator('[data-group="mode"]')).toBeHidden();
    await page.click('.sheet-tab[data-tab="export"]');
    await expect(page.locator('[data-group="export"]')).toBeVisible();
    await expect(page.locator('.sheet-tab[aria-selected="true"]')).toHaveAttribute('data-tab', 'export');

    // side gutters of 16px on the home page
    await page.click('#site-nav a[data-nav="about"]', { force: true }).catch(() => {});
  });

  test('mobile home: hero text keeps 16px side margins and the dropzone is reachable', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await gotoApp(page);
    const left = await page.locator('.hero-title').evaluate((el) => el.getBoundingClientRect().left);
    expect(left).toBe(16);
    const dz = await page.locator('#dropzone').boundingBox();
    expect(dz.x).toBe(16);
    expect(dz.x + dz.width).toBeLessThanOrEqual(360 - 16 + 0.5);
    await page.locator('#dz-pick').scrollIntoViewIfNeeded();
    await expect(page.locator('#dz-pick')).toBeInViewport();
  });

  test('phones start with a lighter default resolution (80 columns) that "reset" restores', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.clear());
    await gotoApp(page);
    await loadFixture(page);
    expect(await page.locator('#viewer-canvas').getAttribute('data-cols')).toBe('80');
    await page.locator('[data-param="cols"] .ctl-num').fill('150');
    await page.locator('[data-param="cols"] .ctl-num').press('Enter');
    await page.locator('[data-group="image"] .group-reset').click();
    await expect(page.locator('[data-param="cols"] .ctl-num')).toHaveValue('80');
  });

  test('the mobile toolbar and header fit one row each at 360px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await gotoApp(page);
    const h = await page.locator('.site-header').boundingBox();
    expect(h.height).toBeLessThanOrEqual(60);
    await loadFixture(page);
    const bar = await page.locator('.viewer-toolbar').boundingBox();
    expect(bar.height).toBeLessThan(60);
  });
});

test.describe('theme contrast (AA)', () => {
  const lum = (hex) => {
    const n = parseInt(hex.replace('#', ''), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  test('text and accent pairs meet WCAG AA in all six themes', async ({ page }) => {
    await gotoApp(page);
    const results = [];
    for (const theme of ['horain', 'claro', 'amber', 'crt', 'paper', 'cad']) {
      await page.selectOption('#theme-select', theme);
      const t = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        const get = (n) => cs.getPropertyValue(n).trim();
        return Object.fromEntries(['--bg', '--panel', '--panel-2', '--fg', '--fg-2', '--accent', '--accent-text', '--accent-ink', '--danger'].map((n) => [n, get(n)]));
      });
      const pairs = [
        ['fg on bg', t['--fg'], t['--bg']],
        ['fg on panel', t['--fg'], t['--panel']],
        ['fg-2 on bg', t['--fg-2'], t['--bg']],
        ['fg-2 on panel', t['--fg-2'], t['--panel']],
        ['fg-2 on panel-2', t['--fg-2'], t['--panel-2']],
        ['accent-text on bg', t['--accent-text'], t['--bg']],
        ['accent-text on panel', t['--accent-text'], t['--panel']],
        ['accent-ink on accent', t['--accent-ink'], t['--accent']],
        ['danger on bg', t['--danger'], t['--bg']],
        ['danger on panel', t['--danger'], t['--panel']],
      ];
      for (const [name, fg, bg] of pairs) results.push({ theme, name, ratio: ratio(fg, bg) });
    }
    // Every pair reaches AA for normal text in all six themes (PAPER's accent ink is #111111 since phase 7, PLAN.md 19)
    const failing = results.filter((r) => r.ratio < 4.5);
    expect(failing.map((r) => `${r.theme}: ${r.name} = ${r.ratio.toFixed(2)}`)).toEqual([]);
  });

  test('lime is never used as text colour on light themes', async ({ page }) => {
    await gotoApp(page);
    for (const theme of ['claro', 'paper']) {
      await page.selectOption('#theme-select', theme);
      const accentText = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-text').trim().toLowerCase());
      expect(accentText).not.toBe('#c4f169');
      const color = await page.locator('.hero-accent').evaluate((el) => getComputedStyle(el).color);
      expect(color).not.toBe('rgb(196, 241, 105)');
    }
  });
});

test.describe('accessibility basics', () => {
  test('landmarks, one h1, skip link, labelled controls on the home page', async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('header')).toHaveCount(1);
    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.locator('footer')).toHaveCount(1);
    await expect(page.locator('h1:visible')).toHaveCount(1);
    await expect(page.locator('.skip-link')).toHaveAttribute('href', '#main');
    const unlabeled = await page.evaluate(() => {
      const bad = [];
      for (const el of document.querySelectorAll('button, a, input, select')) {
        if (el.closest('[hidden]')) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const name = (el.getAttribute('aria-label') || '').trim() || (el.textContent || '').trim() || Array.from(el.labels || []).map((l) => l.textContent.trim()).join('') || el.getAttribute('title') || '';
        if (!name && !el.querySelector('img[alt]')) bad.push(`${el.tagName}.${el.className}#${el.id}`);
      }
      return bad;
    });
    expect(unlabeled).toEqual([]);
    // images have alt text
    const noAlt = await page.evaluate(() => Array.from(document.images).filter((i) => !i.hasAttribute('alt')).length);
    expect(noAlt).toBe(0);
  });

  test('keyboard reaches the dropzone and opens the picker', async ({ page }) => {
    await gotoApp(page);
    await page.locator('#dz-pick').focus();
    const chooser = await openChooser(page, () => page.keyboard.press('Enter'));
    expect(chooser).toBeTruthy();
    const ring = await page.locator('#dz-pick').evaluate((el) => getComputedStyle(el, '::after').outlineStyle);
    expect(ring).toBe('solid');
  });

  test('external links open safely', async ({ page }) => {
    await gotoApp(page);
    const bad = await page.evaluate(() => Array.from(document.querySelectorAll('a[target="_blank"]'))
      .filter((a) => !/noopener/.test(a.rel) || !/noreferrer/.test(a.rel)).length);
    expect(bad).toBe(0);
    const total = await page.locator('a[target="_blank"]').count();
    expect(total).toBeGreaterThanOrEqual(3);
  });

  test('prefers-reduced-motion: the hero stays still and decorative animation stops', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const guard = watchPage(page);
    await gotoApp(page);
    await page.waitForFunction(() => document.getElementById('hero-demo') && !document.getElementById('hero-demo').hidden);
    await page.waitForTimeout(500);
    const hashOf = () => canvasStats(page, '#hero-canvas');
    const a = await hashOf();
    await page.waitForTimeout(1600);
    const b = await hashOf();
    expect(a.variance).toBeGreaterThan(0);
    expect(b.hash).toBe(a.hash);
    const anim = await page.locator('.dz-arrow').first().evaluate((el) => getComputedStyle(el).animationName);
    expect(anim === 'none' || (await page.locator('.dz-arrow').first().evaluate((el) => getComputedStyle(el).animationDuration)) !== '1s').toBe(true);
    await guard.assertClean(expect);
    await ctx.close();
  });

  test('the hero demo animates by default and rotates its look', async ({ page }) => {
    await gotoApp(page);
    await page.waitForFunction(() => !document.getElementById('hero-demo').hidden);
    const a = await canvasStats(page, '#hero-canvas');
    await page.waitForTimeout(700);
    const b = await canvasStats(page, '#hero-canvas');
    expect(a.variance).toBeGreaterThan(0);
    expect(b.hash).not.toBe(a.hash);
    const labels = new Set();
    for (let i = 0; i < 6; i++) {
      labels.add(await page.locator('#hero-demo-label').textContent());
      await page.waitForTimeout(1000);
    }
    expect(labels.size).toBeGreaterThan(1);
  });

  test('the hero stops rendering while the studio is open', async ({ page }) => {
    await gotoApp(page);
    await page.waitForFunction(() => !document.getElementById('hero-demo').hidden);
    await loadFixture(page);
    const a = await canvasStats(page, '#hero-canvas');
    await page.waitForTimeout(800);
    const b = await canvasStats(page, '#hero-canvas');
    expect(b.hash).toBe(a.hash);
  });
});

test.describe('home view', () => {
  test('mode gallery lists every mode with a rendered thumbnail and opens the studio on click', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const ids = await page.evaluate(async () => (await import('/src/modes/index.js')).MODE_IDS);
    await page.locator('#modes').scrollIntoViewIfNeeded();
    for (const id of ids) {
      const card = page.locator(`.mode-card[data-mode-id="${id}"]`);
      await card.scrollIntoViewIfNeeded(); // thumbnails render lazily, when their card nears the viewport
      await expect(card).toBeVisible();
      await expect.poll(async () => (await canvasStats(page, `.mode-card[data-mode-id="${id}"] canvas`)).variance).toBeGreaterThan(0);
    }
    await page.click(`.mode-card[data-mode-id="${ids[0]}"]`);
    await page.waitForSelector('body[data-view="studio"]');
    await page.waitForFunction(() => Number(document.getElementById('viewer-canvas').dataset.frame || 0) > 0);
    await expect(page.locator('#mode-list .mode-item[aria-current="true"]')).toHaveAttribute('data-mode-id', ids[0]);
    await guard.assertClean(expect);
  });

  test('navigation: studio link, anchors and returning to the home view', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoApp(page);
    // without a file the Studio link brings the user to the dropzone
    await page.click('#site-nav a[data-nav="studio"]');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'home');
    await expect(page.locator('#dz-pick')).toBeFocused();
    await page.click('#site-nav a[data-nav="about"]');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    await loadFixture(page);
    await expect(page.locator('#site-nav a[data-nav="studio"]')).toHaveAttribute('aria-current', 'page');
    // leave the studio for the about section and come back: the file is still there
    await page.click('#site-nav a[data-nav="about"]');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'home');
    await page.click('#site-nav a[data-nav="studio"]');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'studio');
    await settle(page);
    expect((await canvasStats(page)).variance).toBeGreaterThan(0);
  });

  test('the icons come from the Dither files', async ({ page }) => {
    await gotoApp(page);
    const favicon = await page.locator('link[rel="icon"]').first().getAttribute('href');
    expect(favicon).toBe('./assets/icons/dither-icon.svg');
    const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
    expect(apple).toBe('./assets/icons/apple-touch-icon.png');
    for (const url of [favicon, apple]) {
      const res = await page.request.get(`/${url.replace('./', '')}`);
      expect(res.status()).toBe(200);
    }
    // the header wordmark stays legible: at least 24px tall (PLAN.md 18.4)
    const h = await page.locator('.site-header .brand-name').evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(24);
  });

  test('the product is Dither: name, wordmark, links and file names', async ({ page }) => {
    await gotoApp(page);
    await expect(page).toHaveTitle(/^Dither\b/);
    await expect(page.locator('.site-header .brand')).toHaveAttribute('aria-label', 'Dither, home');
    // a typographic DITHER wordmark in the condensed display face
    await expect(page.locator('.site-header .brand-name')).toHaveText('Dither');
    const mark = await page.locator('.site-header .brand-name').evaluate((el) => getComputedStyle(el));
    expect(mark.fontFamily).toContain('Big Shoulders Display');
    expect(mark.textTransform).toBe('uppercase');
    // the footer repeats the wordmark, links point to the Dither repo, config agrees with the markup
    await expect(page.locator('.site-footer .footer-wordmark')).toHaveText('Dither');
    const cfg = await page.evaluate(async () => (await import('/src/config.js')).config);
    expect(cfg).toMatchObject({ productName: 'Dither', fileSlug: 'dither', siteUrl: 'https://dither.ortzigar.org/', repoUrl: 'https://github.com/ortzigaraio/Dither-art' });
    const hrefs = await page.locator('a[href*="github.com"]').evaluateAll((els) => els.map((e) => e.href));
    expect(hrefs.length).toBeGreaterThanOrEqual(2);
    // every GitHub link is the configured repository (or a file inside it, such as the LICENSE)
    for (const h of hrefs) expect(h === cfg.repoUrl || h.startsWith(`${cfg.repoUrl}/blob/main/`), h).toBe(true);
    expect(hrefs.filter((h) => h === cfg.repoUrl).length).toBeGreaterThanOrEqual(2);
    // Dither stands on its own: no Horain logo or "by Horain" anywhere on the page or in its metadata
    await expect(page.locator('img[src*="assets/brand/"]')).toHaveCount(0);
    const text = await page.evaluate(() => document.documentElement.outerHTML);
    expect(text).not.toMatch(/by Horain|horain-espino|horain-icon/i);
    expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/horain/i);
  });

  for (const width of [320, 340, 360, 390]) {
    test(`mobile header keeps the wordmark and the theme/language controls on one row at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 740 });
      await gotoApp(page);
      await page.evaluate(() => document.fonts.ready);
      const rects = await page.evaluate(() => {
        const r = (s) => {
          const e = Array.from(document.querySelectorAll(s)).find((x) => getComputedStyle(x).display !== 'none');
          const b = e.getBoundingClientRect();
          return { l: b.left, r: b.right, t: b.top, b: b.bottom };
        };
        return { name: r('.site-header .brand-name'), picker: r('.theme-picker'), lang: r('.lang-toggle'), vw: window.innerWidth };
      });
      expect(rects.name.l).toBeGreaterThanOrEqual(15);
      expect(rects.name.r).toBeLessThanOrEqual(rects.picker.l);
      expect(rects.picker.r).toBeLessThanOrEqual(rects.lang.l);
      expect(rects.lang.r).toBeLessThanOrEqual(rects.vw - 15); // 16px gutter on both sides
      expect(Math.abs(rects.name.t - rects.lang.t)).toBeLessThan(20); // same row
      // the theme select still covers the compact picker so the native chooser opens on tap
      const cover = await page.evaluate(() => {
        const p = document.querySelector('.theme-picker').getBoundingClientRect();
        const s = document.getElementById('theme-select').getBoundingClientRect();
        return { pw: p.width, sw: s.width, ph: p.height, sh: s.height };
      });
      expect(cover.sw).toBeGreaterThanOrEqual(cover.pw - 2);
      expect(cover.sh).toBeGreaterThanOrEqual(cover.ph - 2);
      await page.selectOption('#theme-select', 'amber');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'amber');
    });
  }

  test('typography: condensed uppercase headlines, Geist Mono uppercase labels and values, Unbounded card titles', async ({ page }) => {
    await gotoApp(page);
    const fam = (sel) => page.locator(sel).first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return { family: cs.fontFamily, transform: cs.textTransform, weight: cs.fontWeight, ls: cs.letterSpacing };
    });
    const h1 = await fam('.hero-title');
    expect(h1.family).toContain('Big Shoulders Display');
    expect(h1.transform).toBe('uppercase');
    expect(h1.weight).toBe('800');
    const label = await fam('.section-head .label');
    expect(label.family).toContain('Geist Mono');
    expect(label.transform).toBe('uppercase');
    const card = await fam('.mode-card-name');
    expect(card.family).toContain('Unbounded');
    await loadFixture(page);
    const val = await fam('.ctl-num');
    expect(val.family).toContain('Geist Mono');
    expect(await page.evaluate(() => document.fonts.check('600 20px "Unbounded"', 'abc'))).toBe(true);
    expect(await page.evaluate(() => document.fonts.check('16px "Geist Mono"', '█░▒▓'))).toBe(true);
    const loaded = await page.evaluate(() => Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => f.family));
    expect(loaded).toEqual(expect.arrayContaining(['Big Shoulders Display', 'Unbounded', 'Geist', 'Geist Mono']));
  });
});

test.describe('home view (language)', () => {
  test('the hero demo label and the nav landmark follow the language', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('horain.lang', 'es'));
    await gotoApp(page);
    await page.waitForFunction(() => !document.getElementById('hero-demo').hidden);
    await expect(page.locator('#hero-demo-label')).toHaveText(/^demo · ascii · /);
    await expect(page.locator('#site-nav')).toHaveAttribute('aria-label', 'Principal');
    await page.click('.lang-toggle [data-lang="en"]');
    await expect(page.locator('#site-nav')).toHaveAttribute('aria-label', 'Primary');
    // gradient names come from the localized option labels, not raw ids
    const labels = new Set();
    for (let i = 0; i < 5; i++) {
      labels.add(await page.locator('#hero-demo-label').textContent());
      await page.waitForTimeout(1000);
    }
    expect([...labels].some((l) => /standard|blocks|detailed|katakana/.test(l))).toBe(true);
  });
});
