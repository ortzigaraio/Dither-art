// Phase 7 logic pass: races on mode / source switches, memory released on mode switches, edge-case inputs, idle
// rendering, validation of untrusted state, and the AI depth timeout.
import { test, expect } from '@playwright/test';
import {
  watchPage, gotoApp, loadFixture, settle, canvasStats, renderCount, captureDownload, inspectMedia,
} from './helpers.js';

/** A PNG of w x h (a horizontal gradient), made in the page and fed to the file input. */
async function openGeneratedPng(page, w, h, name = `gen-${w}x${h}.png`) {
  const bytes = await page.evaluate(async ([w, h]) => {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#000');
    grad.addColorStop(1, '#fff');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, [w, h]);
  await page.setInputFiles('#file-input', { name, mimeType: 'image/png', buffer: Buffer.from(bytes) });
}

const pickMode = (page, id) => page.click(`#mode-list [data-mode-id="${id}"]`);
const activeMode = (page) => page.locator('#mode-list [aria-current="true"]').getAttribute('data-mode-id');

test.describe('races', () => {
  test('mode switch: a slow mode that finishes loading after a newer choice never replaces it', async ({ page }) => {
    const guard = watchPage(page);
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route('**/src/modes/braille.js', async (route) => { await gate; await route.continue(); });
    await gotoApp(page);
    await loadFixture(page);
    await pickMode(page, 'braille'); // its code is held back by the route
    await pickMode(page, 'dither1bit');
    await expect.poll(() => activeMode(page)).toBe('dither1bit');
    release();
    await page.waitForResponse('**/src/modes/braille.js');
    await page.waitForTimeout(400);
    expect(await activeMode(page)).toBe('dither1bit');
    await settle(page);
    expect(await page.locator('#viewer-canvas').getAttribute('data-mode')).toBe('dither1bit');
    await guard.assertClean(expect);
  });

  test('source switch: the last opened picture wins, and an export cannot start twice', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    // two pictures in quick succession: the second one is the one shown
    await openGeneratedPng(page, 320, 200, 'first.png');
    await openGeneratedPng(page, 200, 300, 'second.png');
    await expect(page.locator('[data-group="input"] .src-name')).toHaveText('second.png');
    await settle(page);
    await expect(page.locator('[data-group="input"] .src-line')).toContainText('200×300');
    // two PNG exports fired at once give one file
    const downloads = [];
    page.on('download', (d) => downloads.push(d.suggestedFilename()));
    await page.evaluate(() => {
      const b = document.querySelector('[data-export="png"]');
      b.click();
      b.click();
    });
    await expect.poll(() => downloads.length, { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(800);
    expect(downloads.length).toBe(1);
    await guard.assertClean(expect);
  });
});

test.describe('memory', () => {
  test('switching modes releases the previous mode state (two tours of every mode)', async ({ page }) => {
    test.setTimeout(240_000);
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const ids = await page.locator('#mode-list .mode-item:not([aria-disabled="true"])').evaluateAll((els) => els.map((e) => e.dataset.modeId));
    const peaks = [];
    for (let round = 0; round < 2; round++) {
      let peak = 0;
      for (const id of ids) {
        await pickMode(page, id);
        await expect.poll(() => activeMode(page)).toBe(id);
        await settle(page);
        const st = await page.evaluate(async () => (await import('/src/engine/pipeline.js')).pipelineStats().find((p) => p.label === 'preview'));
        // only the mode on screen keeps a state in the preview pipeline
        expect(st.modes.length).toBeLessThanOrEqual(1);
        peak = Math.max(peak, st.stateBytes);
      }
      peaks.push(peak);
    }
    // the second tour holds no more than the first (nothing accumulates across switches)
    expect(peaks[1]).toBeLessThanOrEqual(peaks[0] * 1.1 + 1024);
    await guard.assertClean(expect);
  });
});

test.describe('edge cases', () => {
  for (const [w, h] of [[1, 1], [1, 4096], [4096, 1]]) {
    test(`a ${w}x${h} picture renders in every mode without errors`, async ({ page }) => {
      test.setTimeout(300_000);
      const guard = watchPage(page);
      await gotoApp(page);
      await openGeneratedPng(page, w, h);
      await page.waitForSelector('body[data-view="studio"]');
      await page.waitForFunction(() => Number(document.getElementById('viewer-canvas').dataset.frame || 0) > 0);
      const ids = await page.locator('#mode-list .mode-item:not([aria-disabled="true"])').evaluateAll((els) => els.map((e) => e.dataset.modeId));
      for (const id of [...ids.filter((x) => x !== 'ascii'), 'ascii']) {
        await pickMode(page, id);
        await page.waitForFunction((m) => document.getElementById('viewer-canvas').dataset.mode === m, id);
        await settle(page);
        const size = await page.locator('#viewer-canvas').evaluate((c) => [c.width, c.height]);
        expect(size[0] * size[1], id).toBeGreaterThan(0);
      }
      await expect(page.locator('#chip-error')).toBeHidden();
      await guard.assertClean(expect);
    });
  }

  test('typing extreme values into a slider clamps them, never NaN or Infinity', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const row = page.locator('#controls [data-param="cols"]');
    const num = row.locator('.ctl-num');
    const [min, max] = await row.locator('input[type="range"]').evaluate((r) => [Number(r.min), Number(r.max)]);
    // finite numbers are clamped; anything that is not a finite number (1e400 is Infinity) keeps the previous value
    const cases = [['9'.repeat(40), max], ['-1e300', min], ['1e400', null], ['-1e400', null], ['Infinity', null], ['NaN', null], ['', null], ['-0', min]];
    for (const [typed, expected] of cases) {
      const before = await num.inputValue();
      await num.fill(typed);
      await num.press('Enter');
      const v = Number(await num.inputValue());
      expect(Number.isFinite(v), typed).toBe(true);
      expect(v).toBeGreaterThanOrEqual(min);
      expect(v).toBeLessThanOrEqual(max);
      if (expected !== null) expect(v, typed).toBe(expected);
      else expect(String(v), typed).toBe(before); // not a number: the previous value stays
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('horain.params') || '{}').global?.cols);
      if (stored !== undefined) expect(Number.isFinite(stored)).toBe(true);
    }
    await settle(page);
    expect((await canvasStats(page)).variance).toBeGreaterThan(0);
    await guard.assertClean(expect);
  });
});

test.describe('idle', () => {
  test('a still picture in a still mode renders 0 frames per second when nothing changes', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    await settle(page, 400);
    const a = await renderCount(page);
    await page.waitForTimeout(2000);
    expect(await renderCount(page)).toBe(a);
    // no animation frame loop keeps spinning either
    const rafs = await page.evaluate(() => new Promise((resolve) => {
      let n = 0;
      const orig = window.requestAnimationFrame;
      window.requestAnimationFrame = (fn) => { n++; return orig.call(window, fn); };
      setTimeout(() => { window.requestAnimationFrame = orig; resolve(n); }, 1500);
    }));
    expect(rafs).toBe(0);
    await guard.assertClean(expect);
  });
});

test.describe('validation of untrusted state', () => {
  test('random garbage in share links, saved sessions and presets always yields a valid state', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const problems = await page.evaluate(async () => {
      const { MODES } = await import('/src/modes/index.js');
      const st = await import('/src/state.js');
      const pr = await import('/src/presets.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const { DEPTH_PARAMS } = await import('/src/engine/depth.js');
      const { POSTFX_PARAMS } = await import('/src/engine/postfx.js');
      let seed = 7;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const pick = (a) => a[Math.floor(rnd() * a.length)];
      const junk = (depth = 0) => {
        const r = rnd();
        if (r < 0.1) return null;
        if (r < 0.2) return pick([NaN, Infinity, -Infinity, -0, 1e308, -1e308, 0.1 + 0.2]);
        if (r < 0.3) return rnd() * 2000 - 1000;
        if (r < 0.4) return pick(['', 'javascript:alert(1)', '<img src=x onerror=alert(1)>', '#zzzzzz', '#fff', '\u0000\u0007', 'x'.repeat(5000)]);
        if (r < 0.5) return rnd() < 0.5;
        if (r < 0.65 && depth < 3) return Array.from({ length: Math.floor(rnd() * 5) }, () => junk(depth + 1));
        if (depth < 3) {
          const o = {};
          for (let i = 0; i < 4; i++) o[pick(['__proto__', 'constructor', 'cols', 'gradient', 'ink', 'x', 'threshold', 'cellSize'])] = junk(depth + 1);
          return o;
        }
        return 'deep';
      };
      const schemas = { global: IMAGE_PARAMS, color: COLOR_PARAMS, depth: DEPTH_PARAMS, postfx: POSTFX_PARAMS };
      const out = [];
      const checkState = (s, where) => {
        if (!s) return;
        if (!MODES.some((m) => m.id === s.modeId)) out.push(`${where}: modeId ${s.modeId}`);
        for (const [k, schema] of Object.entries(schemas)) {
          const again = st.sanitizeParams(schema, s[k]);
          if (JSON.stringify(again) !== JSON.stringify(s[k])) out.push(`${where}: ${k} not stable`);
        }
        for (const m of MODES) {
          const again = st.sanitizeParams(m.params, s.modes[m.id]);
          if (JSON.stringify(again) !== JSON.stringify(s.modes[m.id])) out.push(`${where}: modes.${m.id} not stable`);
        }
        const text = JSON.stringify(s);
        if (/NaN|Infinity/.test(text) && !/"[^"]*(NaN|Infinity)[^"]*"/.test(text)) out.push(`${where}: non-finite number`);
        if (({}).polluted !== undefined || Object.prototype.cols !== undefined) out.push(`${where}: prototype polluted`);
      };
      const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      for (let i = 0; i < 300; i++) {
        const modes = {};
        for (const m of MODES) if (rnd() < 0.3) modes[m.id] = junk();
        const raw = { v: 1, modeId: pick([...MODES.map((m) => m.id), 'evil', 42, null]), global: junk(), color: junk(), depth: junk(), postfx: junk(), modes: rnd() < 0.9 ? modes : junk() };
        try {
          checkState(st.sanitizeState(raw), `state#${i}`);
          checkState(st.decodeShareHash(`#s=${b64(raw)}`), `hash#${i}`);
          const p = pr.sanitizePreset({ format: 'dither-preset', name: junk(), modeId: raw.modeId, mode: junk(), global: junk(), color: junk() });
          if (p) {
            const next = pr.stateWithPreset(st.defaultState(), p.modeId, p);
            checkState(next, `preset#${i}`);
            if (typeof p.name !== 'string' || p.name.length > 60) out.push(`preset#${i}: bad name`);
          }
        } catch (err) {
          out.push(`#${i} threw ${err.message}`);
        }
      }
      return out.slice(0, 20);
    });
    expect(problems).toEqual([]);
    await guard.assertClean(expect);
  });

  test('a saved session for a mode that is not loaded yet keeps its settings until the mode loads', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('horain.params', JSON.stringify({ v: 1, modeId: 'ascii', modes: { halftone: { cellSize: 31, angle: 'evil' } } }));
    });
    await gotoApp(page);
    await loadFixture(page);
    await page.waitForTimeout(400); // the debounced save runs with halftone still unloaded
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('horain.params')).modes.halftone);
    expect(kept.cellSize).toBe(31);
    await pickMode(page, 'halftone');
    await expect.poll(() => activeMode(page)).toBe('halftone');
    await expect(page.locator('#controls [data-param="cellSize"] .ctl-num')).toHaveValue('31');
    // once loaded, the held values are validated: the bad angle becomes the default in the saved session
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('horain.params') || '{}').modes?.halftone?.angle)).toBe(45);
    await guard.assertClean(expect);
  });
});

test.describe('AI depth', () => {
  test('a model download that stalls times out and falls back to brightness, without console errors', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => localStorage.setItem('horain.depthAI', '1'));
    await gotoApp(page);
    await page.evaluate(async () => {
      const d = await import('/src/engine/depth.js');
      // a worker that never answers, and short limits for the test
      d.configureDepthAI({ workerUrl: '/tests/mocks/depth.silent.worker.js', stallMs: 800, timeoutMs: 5000 });
    });
    await loadFixture(page);
    await pickMode(page, 'lidar');
    await expect.poll(() => activeMode(page)).toBe('lidar');
    await page.locator('#controls [data-param="source"] select').selectOption('ai');
    await expect(page.locator('#toasts')).toContainText(/took too long|ha tardado demasiado/, { timeout: 10_000 });
    await expect(page.locator('#controls [data-param="source"] select')).toHaveValue('brightness');
    expect(await page.evaluate(async () => (await import('/src/engine/depth.js')).depthAIStatus())).toBe('failed');
    await settle(page);
    expect((await canvasStats(page)).variance).toBeGreaterThan(0);
    await guard.assertClean(expect);
  });
});

test.describe('hidden tab', () => {
  test('hiding the tab during a timeline video export still produces a complete file', async ({ page }) => {
    test.setTimeout(180_000);
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    await pickMode(page, 'matrix'); // animated: a still picture exports as a timeline
    await expect.poll(() => activeMode(page)).toBe('matrix');
    await settle(page);
    await page.click('[data-export="video"]');
    await page.waitForSelector('#export-dialog[open]');
    await page.selectOption('#vx-format', 'webm');
    await page.selectOption('#vx-height', '480');
    await page.locator('#vx-duration').fill('2');
    await page.locator('#vx-duration').dispatchEvent('input');
    const file = await captureDownload(page, async () => {
      await page.click('#vx-go');
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(1200);
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }, 120_000);
    const info = await inspectMedia(page, file.bytes);
    expect(info.duration).toBeGreaterThan(1.7);
    expect(info.duration).toBeLessThan(2.6);
    await guard.assertClean(expect);
  });
});
