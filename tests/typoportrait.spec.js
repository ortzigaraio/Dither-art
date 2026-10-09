import { test, expect } from '@playwright/test';
import {
  watchPage, gotoApp, renderMode, loadFixture, settle, setControl, renderCount, waitForRender, captureDownload,
} from './helpers.js';

// Typographic portrait (PLAN.md 7.6): HTML / SVG exports escape the user's text (PLAN.md 18.3)

const FACES = [{ css: '500 16px "Geist"', text: 'HORAINhorain' }, { css: '900 16px "Geist"', text: 'HORAIN' }];
const HOSTILE = [
  '<img src=x onerror=alert(1)>',
  '"><script>window.__pwned=1</script>',
  `'; DROP TABLE x;-- &amp; <svg onload=alert(2)> </text><script>alert(3)</script>`,
];

/** Parse an SVG or HTML string inside the page and report what it contains. */
async function inspect(page, src, kind) {
  return page.evaluate(({ src, kind }) => {
    const doc = new DOMParser().parseFromString(src, kind === 'svg' ? 'image/svg+xml' : 'text/html');
    const root = kind === 'svg' ? doc.documentElement : doc.body.querySelector('svg');
    const all = Array.from((kind === 'svg' ? doc : doc.body).querySelectorAll('*'));
    const attrs = all.flatMap((e) => Array.from(e.attributes).map((a) => a.name.toLowerCase()));
    const tags = [...new Set(all.map((e) => e.tagName.toLowerCase()))];
    const letters = Array.from(root.querySelectorAll('tspan')).map((t) => t.textContent).join('');
    return {
      parseError: !!doc.querySelector('parsererror'), rootTag: root?.tagName?.toLowerCase(), tags,
      badAttrs: attrs.filter((a) => a.startsWith('on') || a === 'href' || a === 'xlink:href' || a === 'src'),
      bad: doc.querySelectorAll('img, script, iframe, object, embed, link, foreignobject, style a').length,
      letters, tspans: root.querySelectorAll('tspan').length,
      families: Array.from(root.querySelectorAll('[font-family]')).map((e) => e.getAttribute('font-family')),
    };
  }, { src, kind });
}

const base = (text, extra = {}) => ({
  mode: 'typoportrait', width: 240, height: 120, faces: FACES, theme: { ink: '#ffffff', bg: '#000000' },
  rects: [['#ffffff', 0, 0, 1, 1]],
  params: { global: { cols: 60 }, color: { bg: '#000000', ink: '#ffffff' }, mode: { text, uppercase: false, ...extra } },
  outputs: ['svg', 'html'],
});

test.describe('typographic portrait: escaping', () => {
  test('hostile text (<img onerror>, <script>, quotes, entities) comes out escaped in the SVG and in the HTML', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => { window.__pwned = 0; });
    await gotoApp(page);
    for (const text of HOSTILE) {
      const r = await renderMode(page, base(text));
      expect(r.error).toBeNull();
      for (const [kind, src] of [['svg', r.outputs.svg], ['html', r.outputs.html]]) {
        // as raw text: no tag of the user's can survive
        expect(src, `${kind} raw`).not.toMatch(/<img/i);
        expect(src).not.toMatch(/<script/i);
        expect(src).not.toMatch(/onerror\s*=\s*(?!&)/i);
        expect(src).toContain('&lt;');
        expect(src).toContain('&gt;');
        const info = await inspect(page, src, kind);
        expect(info.parseError, `${kind} parse`).toBe(false);
        expect(info.rootTag).toBe('svg');
        expect(info.bad, `${kind} injected elements`).toBe(0);
        expect(info.badAttrs, `${kind} event/link attributes`).toEqual([]);
        for (const t of info.tags) expect(['svg', 'title', 'rect', 'g', 'text', 'tspan', 'html', 'head', 'meta', 'body', 'style'], t).toContain(t);
        // the letters are the user's text, as text (spaces are positions, not letters)
        const wanted = Array.from(text.replace(/\s/g, ''));
        const got = Array.from(info.letters);
        expect(got.slice(0, wanted.length).join('')).toBe(wanted.join(''));
      }
    }
    expect(await page.evaluate(() => window.__pwned)).toBe(0);
    await guard.assertClean(expect);
  });

  test('the font-family attribute and the page title are escaped too', async ({ page }) => {
    await gotoApp(page);
    const r = await renderMode(page, base('A'));
    expect(r.outputs.svg).toContain('font-family="&quot;Geist&quot;, &quot;Geist Mono&quot;');
    const info = await inspect(page, r.outputs.svg, 'svg');
    expect(info.families[0]).toContain('"Geist"');
    expect(r.outputs.html).toMatch(/<title>Dither typographic portrait<\/title>/);
  });

  test('typing hostile text in the control and exporting HTML and SVG in the studio', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => { window.__pwned = 0; });
    await gotoApp(page);
    await loadFixture(page);
    let before = await renderCount(page);
    await page.locator('#mode-list .mode-item[data-mode-id="typoportrait"]').click();
    await waitForRender(page, before);
    before = await renderCount(page);
    await setControl(page, 'uppercase', false);
    await waitForRender(page, before);
    before = await renderCount(page);
    await setControl(page, 'text', HOSTILE[0]);
    await waitForRender(page, before);
    await settle(page);
    for (const k of ['png', 'svg', 'html']) await expect(page.locator(`[data-export="${k}"]`)).toBeVisible();
    for (const k of ['txt', 'ansi', 'ans', 'json']) await expect(page.locator(`[data-export="${k}"]`)).toHaveCount(0);

    const svg = await captureDownload(page, () => page.click('[data-export="svg"]'));
    expect(svg.name).toMatch(/^dither-typoportrait-\d{8}-\d{6}\.svg$/);
    const svgText = svg.bytes.toString('utf8');
    expect(svgText).not.toMatch(/<img/i);
    const si = await inspect(page, svgText, 'svg');
    expect(si.parseError).toBe(false);
    expect(si.bad).toBe(0);
    expect(si.badAttrs).toEqual([]);
    expect(si.letters.startsWith('<imgsrc=xonerror=alert(1)>')).toBe(true);

    const html = await captureDownload(page, () => page.click('[data-export="html"]'));
    expect(html.name).toMatch(/\.html$/);
    const hi = await inspect(page, html.bytes.toString('utf8'), 'html');
    expect(hi.bad).toBe(0);
    expect(hi.badAttrs).toEqual([]);
    expect(hi.letters.startsWith('<imgsrc=xonerror=alert(1)>')).toBe(true);
    expect(await page.evaluate(() => window.__pwned)).toBe(0);
    await guard.assertClean(expect);
  });

  test('a hostile text in a shared link (#s=) is shown as plain text and never runs', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => { window.__pwned = 0; });
    await gotoApp(page);
    const hash = await page.evaluate(async (evil) => {
      const { createStore, encodeShare, sanitizeState } = await import('/src/state.js');
      const s = sanitizeState({ modeId: 'typoportrait', modes: { typoportrait: { text: evil, uppercase: false } } });
      return `#s=${encodeShare(s)}`;
    }, HOSTILE[1] + '\u0000\u0007');
    await page.goto('about:blank'); // a different hash on the same page would not reload it
    await page.goto(`/${hash}`);
    await page.waitForSelector('html[data-ready="true"]');
    await loadFixture(page);
    await expect(page.locator('#controls [data-param="text"] input')).toHaveValue(HOSTILE[1]); // control characters were stripped
    await expect(page.locator('body[data-view="studio"]')).toBeVisible();
    expect(await page.evaluate(() => window.__pwned)).toBe(0);
    expect(await page.evaluate(() => document.querySelectorAll('#controls script, #controls img').length)).toBe(0);
    await guard.assertClean(expect);
  });
});

test.describe('typographic portrait: layout and modulation', () => {
  test('the text repeats continuously along the rows and fills the width of every row', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { layoutPortrait } = await import('/src/modes/typoportrait.js');
      const cols = 40, rows = 6;
      const lay = layoutPortrait({
        text: 'AB CD', faceId: 'geist-mono', fontSize: 12, letterSpacing: 0, lineHeight: 1, uppercase: false, modulate: 'color',
        cols, rows, t: new Float32Array(cols * rows).fill(0.5), ready: true,
      });
      const letters = lay.rows.flatMap((r) => r.letters.map((l) => l.ch));
      const xs = lay.rows.map((r) => r.letters.map((l) => l.x));
      return {
        letters: letters.join(''), width: lay.width, height: lay.height, rowCount: lay.rows.length,
        monotonic: xs.every((row) => row.every((x, i) => i === 0 || x > row[i - 1])),
        lastRight: lay.rows.map((r) => r.letters.at(-1).x),
        baselines: lay.rows.map((r) => r.baseline),
      };
    });
    expect(res.rowCount).toBe(6);
    expect(res.height).toBe(72);
    // 'AB CD ' repeated; spaces are positions, not letters
    expect(res.letters.startsWith('ABCDABCDABCD')).toBe(true);
    expect(res.monotonic).toBe(true);
    for (const x of res.lastRight) expect(x).toBeGreaterThan(res.width - 20);
    expect(res.baselines).toEqual([...res.baselines].sort((a, b) => a - b));
  });

  test('size, weight, opacity and colour each modulate their own attribute with the picture', async ({ page }) => {
    await gotoApp(page);
    // bright left half, dark right half, on a dark background: more light = bigger / heavier / more opaque / brighter
    const half = (modulate, extra = {}) => ({
      ...base('HORAIN ', { modulate, ...extra }),
      rects: [['#000000', 0, 0, 1, 1], ['#ffffff', 0, 0, 0.5, 1]],
    });
    const parse = async (modulate, attr, extra) => {
      const r = await renderMode(page, half(modulate, extra));
      return page.evaluate(({ src, attr }) => {
        const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
        const width = Number(doc.documentElement.getAttribute('width'));
        const left = [], right = [];
        for (const t of doc.querySelectorAll('tspan')) {
          const v = t.getAttribute(attr);
          (Number(t.getAttribute('x')) < width / 2 ? left : right).push(v === null ? null : v);
        }
        return { left, right, width };
      }, { src: r.outputs.svg, attr });
    };
    const avg = (a) => a.filter((v) => v !== null).map(Number).reduce((s, v) => s + v, 0) / Math.max(1, a.filter((v) => v !== null).length);

    const size = await parse('size', 'font-size');
    expect(avg(size.left)).toBeGreaterThan(avg(size.right) * 1.5);
    const weight = await parse('weight', 'font-weight');
    expect(new Set([...weight.left, ...weight.right]).size).toBeGreaterThan(1);
    expect(avg(weight.left)).toBeGreaterThan(avg(weight.right));
    const opacity = await parse('opacity', 'fill-opacity');
    expect(avg(opacity.left)).toBeGreaterThan(avg(opacity.right) * 2);
    const color = await parse('color', 'fill');
    expect(new Set(color.right.filter(Boolean)).size).toBeGreaterThanOrEqual(1);
    // fixed attributes stay fixed: no per-letter size when modulating opacity
    expect(opacity.left.every((v) => v !== null)).toBe(true);
    const noSize = await parse('opacity', 'font-size');
    expect([...noSize.left, ...noSize.right].every((v) => v === null)).toBe(true);
  });

  test('polarity follows the background: on a light background the dark parts get more ink', async ({ page }) => {
    await gotoApp(page);
    const mk = (bg, ink) => ({
      ...base('HORAIN ', { modulate: 'size' }),
      theme: { ink, bg }, params: { global: { cols: 60 }, color: { bg, ink }, mode: { text: 'HORAIN ', modulate: 'size', uppercase: false } },
      rects: [['#ffffff', 0, 0, 1, 1], ['#000000', 0, 0, 0.5, 1]], // left half dark
    });
    const sizes = async (spec) => {
      const r = await renderMode(page, spec);
      return page.evaluate((src) => {
        const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
        const w = Number(doc.documentElement.getAttribute('width'));
        const l = [], rr = [];
        for (const t of doc.querySelectorAll('tspan')) (Number(t.getAttribute('x')) < w / 2 ? l : rr).push(Number(t.getAttribute('font-size')));
        const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
        return { left: avg(l), right: avg(rr) };
      }, r.outputs.svg);
    };
    const light = await sizes(mk('#ffffff', '#000000'));
    expect(light.left).toBeGreaterThan(light.right * 1.5); // dark half = more ink on paper
    const dark = await sizes(mk('#000000', '#ffffff'));
    expect(dark.right).toBeGreaterThan(dark.left * 1.5); // bright half = more ink on a dark screen
  });

  test('original colour mode gives each letter the colour of the picture', async ({ page }) => {
    await gotoApp(page);
    const r = await renderMode(page, {
      ...base('HORAIN ', { modulate: 'weight' }),
      rects: [['#ff0000', 0, 0, 1, 1], ['#0000ff', 0.5, 0, 0.5, 1]],
      params: { global: { cols: 60 }, color: { bg: '#000000', ink: '#ffffff', colorMode: 'original' }, mode: { text: 'HORAIN ', modulate: 'weight', uppercase: false } },
    });
    const fills = await page.evaluate((src) => {
      const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
      const w = Number(doc.documentElement.getAttribute('width'));
      const out = { left: new Set(), right: new Set() };
      const ink = doc.querySelector('g').getAttribute('fill');
      for (const t of doc.querySelectorAll('tspan')) (Number(t.getAttribute('x')) < w / 2 - 20 ? out.left : Number(t.getAttribute('x')) > w / 2 + 20 ? out.right : new Set()).add(t.getAttribute('fill') || ink);
      return { left: [...out.left], right: [...out.right] };
    }, r.outputs.svg);
    expect(fills.left).toEqual(['#ff0000']);
    expect(fills.right).toEqual(['#0000ff']);
  });

  test('the canvas is drawn (non-blank), every font works, and an empty text falls back to the default', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    for (const font of ['geist', 'unbounded', 'vt323', 'jetbrains-mono', 'geist-mono']) {
      for (const modulate of ['size', 'weight', 'opacity', 'color']) {
        const r = await renderMode(page, {
          ...base('HORAIN ', { font, modulate }), rects: [['#000000', 0, 0, 1, 1], ['#cccccc', 0.1, 0.1, 0.5, 0.6]],
          faces: [{ css: `500 16px "${{ geist: 'Geist', unbounded: 'Unbounded', vt323: 'VT323', 'jetbrains-mono': 'JetBrains Mono', 'geist-mono': 'Geist Mono' }[font]}"`, text: 'HORAIN' }],
          pixels: [[0.2, 0.2]], means: [[0, 0, 1, 1]],
        });
        expect(r.error, `${font}/${modulate}`).toBeNull();
        expect(r.frames[0].means[0], `${font}/${modulate} has ink`).toBeGreaterThan(0.005);
      }
    }
    const empty = await renderMode(page, { ...base('   '), outputs: ['svg'] });
    const info = await inspect(page, empty.outputs.svg, 'svg');
    expect(info.letters.startsWith('HORAIN')).toBe(true); // fell back to the default text
    await guard.assertClean(expect);
  });

  test('size cap: 600 columns at a big font size still renders within the preview limit', async ({ page }) => {
    await gotoApp(page);
    const r = await renderMode(page, { ...base('HORAIN '), params: { global: { cols: 600 }, color: { bg: '#000000', ink: '#ffffff' }, mode: { fontSize: 40, text: 'HORAIN ' } }, outScale: 4, outputs: [] });
    expect(r.error).toBeNull();
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(4096);
  });
});
