import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, loadFixture, renderCount, waitForRender, captureDownload } from './helpers.js';

// io/exportSVG.js (PLAN.md 7 VECTOR, 12 phase 4 acceptance): valid XML, Inkscape layers, page sizes in mm, plotter
// mode without fills, escaped text. Parsed with DOMParser in the page.

/** Parse SVG text in the page and summarise what the tests look at. */
async function inspectSVG(page, svg) {
  return page.evaluate((src) => {
    const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
    const root = doc.documentElement;
    const INK = 'http://www.inkscape.org/namespaces/inkscape';
    const fills = new Set();
    for (const el of doc.querySelectorAll('*')) {
      if (el.hasAttribute('fill')) fills.add(el.getAttribute('fill'));
      const st = el.getAttribute('style') || '';
      const m = /fill\s*:\s*([^;]+)/.exec(st);
      if (m) fills.add(m[1].trim());
    }
    const nums = [];
    for (const p of doc.querySelectorAll('path')) {
      for (const n of (p.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g) || []) nums.push(Number(n));
    }
    return {
      error: doc.querySelector('parsererror')?.textContent || null,
      tag: root.tagName,
      width: root.getAttribute('width'),
      height: root.getAttribute('height'),
      viewBox: root.getAttribute('viewBox'),
      layers: Array.from(doc.querySelectorAll('g')).filter((g) => g.getAttributeNS(INK, 'groupmode') === 'layer').map((g) => g.getAttributeNS(INK, 'label')),
      fills: Array.from(fills),
      images: doc.querySelectorAll('image').length,
      scripts: doc.querySelectorAll('script, foreignObject').length,
      handlers: Array.from(doc.querySelectorAll('*')).flatMap((el) => Array.from(el.attributes).map((a) => a.name)).filter((n) => /^on/i.test(n)),
      texts: Array.from(doc.querySelectorAll('text')).map((t) => t.textContent),
      title: doc.querySelector('title')?.textContent,
      paths: doc.querySelectorAll('path').length,
      circles: doc.querySelectorAll('circle').length,
      minNum: nums.length ? Math.min(...nums) : null,
      maxNum: nums.length ? Math.max(...nums) : null,
    };
  }, svg);
}

const HOSTILE = `<script>alert(1)</script><img src=x onerror="alert(2)"> & "quotes" 'apos' ]]>`;

/** A synthetic scene with every kind of element. */
async function sceneSVG(page, opts, size = [400, 300]) {
  return page.evaluate(async ({ opts, size }) => {
    const { sceneToSVG } = await import('/src/io/exportSVG.js');
    const c = document.createElement('canvas');
    c.width = 8; c.height = 6;
    c.getContext('2d').fillRect(0, 0, 4, 3);
    const scene = {
      width: size[0], height: size[1], background: '#f3efe4', title: opts.sceneTitle || 'Test scene',
      layers: [
        { id: 'shade', label: 'Hillshade', color: '#000000', image: { canvas: c, x: 0, y: 0, width: size[0], height: size[1] }, blend: 'multiply', plotter: 'skip' },
        { id: 'bands', label: 'Bands', color: '#336699', plotter: 'outline', shapes: [{ rings: [new Float32Array([10, 10, 100, 10, 100, 100, 10, 100])], fill: '#aabbcc' }] },
        { id: 'lines', label: 'Lines', color: '#15181e', width: 0.8, paths: [
          { points: new Float32Array([0, 0, 400, 300]) },
          { points: new Float32Array([400, 0, 200, 150, 0, 300]) },
          { points: new Float32Array([50, 50, 60, 50, 60, 60]), closed: true, color: '#ff0000', width: 2 },
        ] },
        { id: 'engr', label: 'Engraving', color: '#123456', width: 0.5, ribbons: [{ points: new Float32Array([0, 200, 100, 200, 200, 210, 300, 200]), widths: new Float32Array([0.5, 2, 3, 0.4]) }] },
        { id: 'dots', label: 'Dots', color: '#222222', dots: { x: new Float32Array([5, 50, 300]), y: new Float32Array([5, 60, 200]), r: new Float32Array([1, 2, 3]), count: 3 } },
        { id: 'labels', label: opts.layerLabel || 'Labels', color: '#000000', texts: [{ x: 20, y: 280, text: opts.text || 'label 100', size: 12, angle: 15 }] },
      ],
    };
    return sceneToSVG(scene, opts);
  }, { opts, size });
}

test.describe('SVG export', () => {
  test('a scene parses, keeps its Inkscape layers and px size by default', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const info = await inspectSVG(page, await sceneSVG(page, {}));
    expect(info.error).toBeNull();
    expect(info.tag).toBe('svg');
    expect([info.width, info.height, info.viewBox]).toEqual(['400', '300', '0 0 400 300']);
    expect(info.layers).toEqual(['Background', 'Hillshade', 'Bands', 'Lines', 'Engraving', 'Dots', 'Labels']);
    expect(info.images).toBe(1);
    expect(info.fills).toEqual(expect.arrayContaining(['#f3efe4', '#aabbcc', 'none']));
  });

  test('plotter mode has strokes only: no fill other than none, no rasters, no background', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const info = await inspectSVG(page, await sceneSVG(page, { plotter: true }));
    expect(info.error).toBeNull();
    expect(info.fills.every((f) => f === 'none'), `fills: ${info.fills}`).toBe(true);
    expect(info.images).toBe(0);
    expect(info.layers).not.toContain('Background');
    expect(info.layers).not.toContain('Hillshade');
    expect(info.layers).toEqual(expect.arrayContaining(['Bands', 'Lines', 'Engraving', 'Dots', 'Labels']));
    expect(info.circles).toBe(3);
  });

  test('A4 / A3 / Letter / custom pages use mm units, the right viewBox and keep the drawing inside the margin', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const tall = await inspectSVG(page, await sceneSVG(page, { page: 'a4', margin: 15 }, [300, 400]));
    expect(tall.error).toBeNull();
    expect([tall.width, tall.height, tall.viewBox]).toEqual(['210mm', '297mm', '0 0 210 297']);
    expect(tall.minNum).toBeGreaterThanOrEqual(15 - 1e-6);
    expect(tall.maxNum).toBeLessThanOrEqual(297 - 15 + 1e-6);
    const wide = await inspectSVG(page, await sceneSVG(page, { page: 'a4' }, [400, 300]));
    expect([wide.width, wide.height, wide.viewBox]).toEqual(['297mm', '210mm', '0 0 297 210']);
    const forced = await inspectSVG(page, await sceneSVG(page, { page: 'a4', orientation: 'portrait' }, [400, 300]));
    expect([forced.width, forced.height]).toEqual(['210mm', '297mm']);
    const a3 = await inspectSVG(page, await sceneSVG(page, { page: 'a3', orientation: 'portrait' }));
    expect([a3.width, a3.height, a3.viewBox]).toEqual(['297mm', '420mm', '0 0 297 420']);
    const letter = await inspectSVG(page, await sceneSVG(page, { page: 'letter', orientation: 'portrait' }));
    expect([letter.width, letter.height, letter.viewBox]).toEqual(['215.9mm', '279.4mm', '0 0 215.9 279.4']);
    const custom = await inspectSVG(page, await sceneSVG(page, { page: 'custom', customW: 100, customH: 80, margin: 0 }));
    expect([custom.width, custom.height, custom.viewBox]).toEqual(['100mm', '80mm', '0 0 100 80']);
    // hostile numbers are clamped, not written
    const bad = await inspectSVG(page, await sceneSVG(page, { page: 'custom', customW: 'x"><script>', customH: -5, margin: 1e9 }));
    expect(bad.error).toBeNull();
    expect(bad.scripts).toBe(0);
    expect([bad.width, bad.height]).toEqual(['210mm', '10mm']);
  });

  test('hostile text, titles and layer labels come out escaped', async ({ page }) => {
    await page.goto('/tests/blank.html');
    for (const plotter of [false, true]) {
      const svg = await sceneSVG(page, { text: HOSTILE, layerLabel: HOSTILE, title: HOSTILE, plotter });
      expect(svg).not.toContain('<script>');
      expect(svg).not.toContain('<img');
      const info = await inspectSVG(page, svg);
      expect(info.error).toBeNull();
      expect(info.scripts).toBe(0);
      expect(info.handlers).toEqual([]);
      expect(info.texts).toEqual([HOSTILE]);
      expect(info.title).toBe(HOSTILE);
      expect(info.layers).toContain(HOSTILE);
    }
  });

  test('the export panel offers page, margin and plotter options for vector modes and they reach the file', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const before = await renderCount(page);
    await page.locator('#mode-list .mode-item[data-mode-id="crosshatch"]').click();
    await waitForRender(page, before);
    await expect(page.locator('[data-export="svg-page"]')).toBeVisible();
    await expect(page.locator('[data-export="svg-margin"]')).toBeHidden();
    await page.locator('[data-export="svg-page"]').selectOption('a4');
    await expect(page.locator('[data-export="svg-margin"]')).toBeVisible();
    await page.locator('[data-export="svg-margin"]').selectOption('20');
    await page.locator('[data-export="svg-plotter"]').check();
    const { name, bytes } = await captureDownload(page, () => page.click('[data-export="svg"]'));
    expect(name).toMatch(/^dither-crosshatch-\d{8}-\d{6}\.svg$/);
    const info = await inspectSVG(page, bytes.toString('utf8'));
    expect(info.error).toBeNull();
    expect([info.width, info.height, info.viewBox]).toEqual(['297mm', '210mm', '0 0 297 210']); // the fixture is landscape
    expect(info.fills.every((f) => f === 'none')).toBe(true);
    expect(info.minNum).toBeGreaterThanOrEqual(20 - 1e-6);
    expect(info.paths).toBeGreaterThan(0);
    // the custom page shows its size inputs
    await page.locator('[data-export="svg-page"]').selectOption('custom');
    await expect(page.locator('[data-export="svg-customW"]')).toBeVisible();
    await expect(page.locator('[data-export="svg-orientation"]')).toBeHidden();
    // a pixel mode with SVG (halftone) has no page options
    const b2 = await renderCount(page);
    await page.locator('#mode-list .mode-item[data-mode-id="halftone"]').click();
    await waitForRender(page, b2);
    await expect(page.locator('[data-export="svg"]')).toBeVisible();
    await expect(page.locator('[data-export="svg-page"]')).toHaveCount(0);
    await guard.assertClean(expect);
  });
});
