// Global Post-FX (PLAN.md 5.6): changes the raster output (preview, PNG, video) and never the SVG / TXT exports.
import { test, expect } from '@playwright/test';
import {
  watchPage, gotoApp, loadFixture, setControl, getControl, canvasStats, waitForRender, renderCount, captureDownload, settle,
} from './helpers.js';

/** Render a mode with and without effects in the page; return raster hashes and text/SVG exports. */
async function probe(page, modeId, fx, outputs) {
  return page.evaluate(async ({ modeId, fx, outputs }) => {
    const { createPipeline } = await import('/src/engine/pipeline.js');
    const { getMode } = await import('/src/modes/index.js');
    const { defaultsOf } = await import('/src/state.js');
    const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
    const { COLOR_PARAMS } = await import('/src/engine/color.js');
    const { POSTFX_PARAMS } = await import('/src/engine/postfx.js');
    const c = document.createElement('canvas');
    c.width = 320; c.height = 200;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 320, 0);
    grad.addColorStop(0, '#000'); grad.addColorStop(1, '#fff');
    g.fillStyle = grad; g.fillRect(0, 0, 320, 200);
    g.fillStyle = '#e33'; g.fillRect(60, 50, 90, 90);
    const source = { id: 'p', kind: 'image', width: 320, height: 200, version: 1, animated: false, frame: () => c, dispose() {} };
    const mode = getMode(modeId);
    const run = async (postfx) => {
      const pipe = createPipeline();
      const params = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx, mode: defaultsOf(mode.params) };
      const r = await pipe.render({ source, mode, params, time: 0, quality: 'full', isExport: true, theme: { ink: '#c4f169', bg: '#15181e' } });
      const out = document.createElement('canvas');
      out.width = r.width; out.height = r.height;
      const og = out.getContext('2d');
      og.drawImage(r.canvas, 0, 0);
      const d = og.getImageData(0, 0, out.width, out.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
      // mean luma of the corner (the vignette darkens it) and the centre
      const mean = (x0, y0, x1, y1) => {
        let s = 0, n = 0;
        for (let y = Math.floor(y0 * out.height); y < Math.floor(y1 * out.height); y++) {
          for (let x = Math.floor(x0 * out.width); x < Math.floor(x1 * out.width); x++) {
            const o = (y * out.width + x) * 4; s += d[o] + d[o + 1] + d[o + 2]; n++;
          }
        }
        return s / n / 765;
      };
      const st = pipe.getState(mode.id);
      const ex = {};
      for (const f of outputs) ex[f] = f === 'svg' ? mode.toSVG(st, {}) : mode.toText(st, f, {});
      const res = { hash: (h >>> 0).toString(16), w: r.width, h: r.height, applied: r.postfx, corner: mean(0, 0, 0.12, 0.12), centre: mean(0.4, 0.4, 0.6, 0.6), ex };
      pipe.dispose();
      return res;
    };
    const off = await run(defaultsOf(POSTFX_PARAMS));
    const on = await run({ ...defaultsOf(POSTFX_PARAMS), ...fx });
    return { off, on };
  }, { modeId, fx, outputs });
}

test.describe('post-fx', () => {
  test('off by default; effects change the raster but not TXT / HTML (ASCII)', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const r = await probe(page, 'ascii', { scanlines: 60, vignette: 80, chroma: 3, glow: 50 }, ['txt', 'html']);
    expect(r.off.applied).toBe(false);
    expect(r.on.applied).toBe(true);
    expect(r.on.hash).not.toBe(r.off.hash);
    expect([r.on.w, r.on.h]).toEqual([r.off.w, r.off.h]);
    expect(r.on.ex.txt).toBe(r.off.ex.txt);
    expect(r.on.ex.html).toBe(r.off.ex.html);
    await guard.assertClean(expect);
  });

  test('vector SVG export is identical with effects on; each effect alone changes pixels', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const r = await probe(page, 'contours', { scanlines: 50, curvature: 60, grain: 40 }, ['svg']);
    expect(r.on.hash).not.toBe(r.off.hash);
    expect(r.on.ex.svg).toBe(r.off.ex.svg);
    for (const fx of [{ scanlines: 50 }, { curvature: 60 }, { glow: 70 }, { chroma: 4 }, { vignette: 80 }, { grain: 50 }, { flicker: 80 }]) {
      const one = await probe(page, 'dither1bit', fx, []);
      expect(one.on.hash, JSON.stringify(fx)).not.toBe(one.off.hash);
    }
    // vignette darkens the corners much more than the centre
    const v = await probe(page, 'thermal', { vignette: 100 }, []);
    expect(v.on.corner).toBeLessThan(v.off.corner * 0.6 + 0.001);
    expect(v.on.centre).toBeGreaterThan(v.off.centre * 0.85);
    await guard.assertClean(expect);
  });

  test('studio: the CRT preset fills the sliders, changes the preview and the PNG, editing goes custom', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const group = page.locator('#controls [data-group="postfx"]');
    await expect(group).toHaveCount(1);
    await expect(group).not.toHaveAttribute('open', '');
    await group.locator('summary').click();
    const before = await canvasStats(page);
    const n = await renderCount(page);
    await setControl(page, 'preset', 'crt', 'postfx');
    await waitForRender(page, n);
    expect(await getControl(page, 'scanlines')).toBe(55);
    expect(await getControl(page, 'curvature')).toBe(35);
    const after = await canvasStats(page);
    expect(after.hash).not.toBe(before.hash);
    // the PNG export carries the effects
    const dl = await captureDownload(page, () => page.click('#controls [data-export="png"]'));
    expect(dl.name).toMatch(/\.png$/);
    // editing one effect switches the preset to "custom"
    await setControl(page, 'vignette', 10, 'postfx');
    await expect(page.locator('#controls [data-group="postfx"] [data-param="preset"] select')).toHaveValue('custom');
    // back to off: the picture returns to the plain render
    await setControl(page, 'preset', 'off', 'postfx');
    await settle(page);
    await expect.poll(async () => (await canvasStats(page)).hash).toBe(before.hash);
    await guard.assertClean(expect);
  });

  test('share links carry the effects (validated)', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const out = await page.evaluate(async () => {
      const { createStore, decodeShareHash } = await import('/src/state.js');
      const st = createStore();
      st.set('postfx.scanlines', 70);
      st.set('postfx.preset', 'custom');
      const back = decodeShareHash(st.shareHash());
      const evil = { v: 1, postfx: { scanlines: 9999, chroma: -5, preset: '<script>', bogus: 1 } };
      const b64 = btoa(JSON.stringify(evil)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const bad = decodeShareHash(`#s=${b64}`);
      return { back: back.postfx, bad: bad.postfx };
    });
    expect(out.back.scanlines).toBe(70);
    expect(out.back.preset).toBe('custom');
    expect(out.bad.scanlines).toBe(100);
    expect(out.bad.chroma).toBe(0);
    expect(out.bad.preset).toBe('off');
    expect('bogus' in out.bad).toBe(false);
    await guard.assertClean(expect);
  });
});
