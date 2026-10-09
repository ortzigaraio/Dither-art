import { test, expect } from '@playwright/test';
import { watchPage, gotoApp } from './helpers.js';

// heavy.worker.js + engine/heavy.js: jobId, progress, cancellation, supersession, watchdog (PLAN.md 18.2)

const ABORT = 'AbortError';

test.describe('heavy worker', () => {
  test('runs a job in a module worker and reports progress', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const heavy = await import('/src/engine/heavy.js');
      const seen = [];
      const out = await heavy.run('debug.sleep', { ms: 120, steps: 6, echo: { a: [1, 2, 3] } }, { onProgress: (p) => seen.push(p) });
      return { out, seen, stats: heavy.stats() };
    });
    expect(res.out).toEqual({ slept: 120, echo: { a: [1, 2, 3] } });
    expect(res.seen.length).toBe(6);
    expect(res.seen).toEqual([...res.seen].sort((a, b) => a - b));
    expect(res.seen.at(-1)).toBe(1);
    expect(res.stats.hasWorker).toBe(true);
    expect(res.stats.spawned).toBe(1);
    await guard.assertClean(expect);
  });

  test('worker and main-thread results are identical to the synchronous dither.js', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const heavy = await import('/src/engine/heavy.js');
      const { quantize, quantizePalette } = await import('/src/engine/dither.js');
      const { petsciiMatch } = await import('/src/engine/petsciiMatch.js');
      const { GLYPH_BYTES, GLYPH_COUNT, PETSCII_PALETTES } = await import('/src/engine/petscii.js');
      const { hexToRgb } = await import('/src/engine/color.js');
      const w = 97, h = 61;
      const buffer = new Float32Array(w * h);
      for (let i = 0; i < buffer.length; i++) buffer[i] = ((i * 2654435761) % 1000) / 1000 * 0.5 + (i % w) / w * 0.5;
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = (i * 7) % 256; rgba[i * 4 + 1] = (i * 13) % 256; rgba[i * 4 + 2] = (i * 29) % 256; rgba[i * 4 + 3] = 255;
      }
      const palette = PETSCII_PALETTES.c64.colors.map(hexToRgb);
      const out = {};
      for (const algo of ['floyd-steinberg', 'jjn', 'atkinson', 'sierra-lite']) {
        const sync = Array.from(quantize(buffer, w, h, 2, algo, { serpentine: true, bias: 0.05 }));
        const viaWorker = Array.from(await heavy.run('quantize', { buffer, w, h, levels: 2, algorithm: algo, opts: { serpentine: true, bias: 0.05 } }));
        const viaMain = Array.from(await heavy.run('quantize', { buffer, w, h, levels: 2, algorithm: algo, opts: { serpentine: true, bias: 0.05 } }, { local: true }));
        out[algo] = JSON.stringify(sync) === JSON.stringify(viaWorker) && JSON.stringify(sync) === JSON.stringify(viaMain);
      }
      const ps = Array.from(quantizePalette(rgba, w, h, palette, 'floyd-steinberg', {}));
      const pw = Array.from(await heavy.run('quantizePalette', { rgba, w, h, palette, algorithm: 'floyd-steinberg', opts: {} }));
      out.palette = JSON.stringify(ps) === JSON.stringify(pw);

      // PETSCII matching: 12 x 7 cells
      const cols = 12, rows = 7;
      const pix = new Uint8ClampedArray(cols * 8 * rows * 8 * 4);
      for (let y = 0; y < rows * 8; y++) {
        for (let x = 0; x < cols * 8; x++) {
          const o = (y * cols * 8 + x) * 4;
          pix[o] = (x * 3 + y) % 256; pix[o + 1] = (y * 5) % 256; pix[o + 2] = (x * y) % 256; pix[o + 3] = 255;
        }
      }
      const enabled = new Uint8Array(GLYPH_COUNT).fill(1);
      const payload = { rgba: pix, cols, rows, palette, glyphs: GLYPH_BYTES, enabled, bg: -1 };
      const a = petsciiMatch(payload);
      const b = await heavy.run('petscii', payload);
      out.petscii = JSON.stringify(Array.from(a.glyph)) === JSON.stringify(Array.from(b.glyph))
        && JSON.stringify(Array.from(a.color)) === JSON.stringify(Array.from(b.color)) && a.bg === b.bg;
      return out;
    });
    expect(res).toEqual({ 'floyd-steinberg': true, jjn: true, atkinson: true, 'sierra-lite': true, palette: true, petscii: true });
  });

  test('cancelling by AbortSignal rejects at once, stops the work and keeps the worker', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const heavy = await import('/src/engine/heavy.js');
      const ac = new AbortController();
      const progress = [];
      const t0 = performance.now();
      const p = heavy.run('debug.sleep', { ms: 6000, steps: 60 }, { signal: ac.signal, onProgress: (v) => progress.push(v) });
      setTimeout(() => ac.abort(), 200);
      let name = null;
      try { await p; } catch (e) { name = e.name; }
      const took = performance.now() - t0;
      const seenAtCancel = progress.length;
      await new Promise((r) => setTimeout(r, 400));
      const after = progress.length;
      const next = await heavy.run('debug.sleep', { ms: 50, steps: 2, echo: 'still alive' });
      // an already aborted signal rejects immediately, without touching the worker
      const done = new AbortController();
      done.abort();
      let preName = null;
      try { await heavy.run('debug.sleep', { ms: 10 }, { signal: done.signal }); } catch (e) { preName = e.name; }
      return { name, took, seenAtCancel, after, next, preName, stats: heavy.stats() };
    });
    expect(res.name).toBe(ABORT);
    expect(res.took).toBeLessThan(1000);
    expect(res.seenAtCancel).toBeLessThan(30);
    expect(res.after).toBe(res.seenAtCancel); // no progress after cancelling
    expect(res.next.echo).toBe('still alive');
    expect(res.preName).toBe(ABORT);
    expect(res.stats.spawned).toBe(1); // the worker acknowledged the cancel: no restart needed
    expect(res.stats.terminated).toBe(0);
  });

  test('a real task (large error diffusion) is cancellable midway', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const heavy = await import('/src/engine/heavy.js');
      const w = 3000, h = 3000;
      const buffer = new Float32Array(w * h).fill(0.4);
      const progress = [];
      const ac = new AbortController();
      const p = heavy.run('quantize', { buffer, w, h, levels: 2, algorithm: 'jjn', opts: {} }, {
        signal: ac.signal,
        onProgress: (v) => { progress.push(v); if (v > 0.05) ac.abort(); },
      });
      let name = null;
      try { await p; } catch (e) { name = e.name; }
      await new Promise((r) => setTimeout(r, 600));
      return { name, last: progress.at(-1), count: progress.length, stats: heavy.stats() };
    });
    expect(res.name).toBe(ABORT);
    expect(res.count).toBeGreaterThan(0);
    expect(res.last).toBeLessThan(0.9); // it did not run to the end
    expect(res.stats.terminated).toBe(0);
  });

  test('a newer job of the same task (latestOnly) drops the older result', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const heavy = await import('/src/engine/heavy.js');
      const outcomes = [];
      const a = heavy.run('debug.sleep', { ms: 3000, steps: 60, echo: 'old' }, { latestOnly: true })
        .then((r) => outcomes.push(['a', r.echo]), (e) => outcomes.push(['a', e.name]));
      await new Promise((r) => setTimeout(r, 100));
      const b = heavy.run('debug.sleep', { ms: 100, steps: 4, echo: 'new' }, { latestOnly: true })
        .then((r) => outcomes.push(['b', r.echo]), (e) => outcomes.push(['b', e.name]));
      await Promise.all([a, b]);
      return outcomes;
    });
    expect(res).toContainEqual(['a', ABORT]);
    expect(res).toContainEqual(['b', 'new']);
    expect(res).not.toContainEqual(['a', 'old']);
  });

  test('watchdog: fires once after the limit, cancel() stops even a task that never yields', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const heavy = await import('/src/engine/heavy.js');
      const { LIMITS } = await import('/src/config.js');
      const calls = [];
      let fastCalls = 0;
      // a quick job under the limit never calls the hook
      await heavy.run('debug.sleep', { ms: 30, steps: 2 }, { watchdogMs: 2000, onWatchdog: () => { fastCalls++; } });
      await new Promise((r) => setTimeout(r, 50));

      const t0 = performance.now();
      const p = heavy.run('debug.block', { ms: 4000 }, {
        watchdogMs: 300,
        onWatchdog: (info) => { calls.push({ task: info.task, elapsed: info.elapsedMs, at: performance.now() - t0 }); info.cancel(); },
      });
      let name = null;
      try { await p; } catch (e) { name = e.name; }
      const took = performance.now() - t0;
      await new Promise((r) => setTimeout(r, 700)); // the hook must not fire again
      const afterKill = heavy.stats();
      const next = await heavy.run('debug.sleep', { ms: 20, steps: 2, echo: 'new worker' });
      return { limit: LIMITS.workerWatchdogMs, calls, fastCalls, name, took, afterKill, next, stats: heavy.stats() };
    });
    expect(res.limit).toBe(30000);
    expect(res.fastCalls).toBe(0);
    expect(res.calls).toHaveLength(1);
    expect(res.calls[0].task).toBe('debug.block');
    expect(res.calls[0].elapsed).toBeGreaterThanOrEqual(290);
    expect(res.name).toBe(ABORT);
    expect(res.took).toBeLessThan(2500); // far less than the 4 s block: the worker was terminated
    expect(res.afterKill.terminated).toBe(1);
    expect(res.next.echo).toBe('new worker');
    expect(res.stats.spawned).toBe(2);
    await guard.assertClean(expect);
  });

  test('the studio watchdog shows a Cancel button that cancels the job', async ({ page }) => {
    await gotoApp(page);
    const outcome = page.evaluate(async () => {
      const heavy = await import('/src/engine/heavy.js');
      // default handler (set by studio.js) with a short limit for this one job
      try { await heavy.run('debug.block', { ms: 5000 }, { watchdogMs: 250 }); return 'finished'; } catch (e) { return e.name; }
    });
    const toast = page.locator('.toast-warn .toast-action');
    await expect(toast).toBeVisible();
    await expect(page.locator('.toast-warn')).toContainText('30');
    await toast.click();
    expect(await outcome).toBe(ABORT);
  });

  test('errors in a task reject with their message; unknown tasks are rejected', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const heavy = await import('/src/engine/heavy.js');
      const msgs = [];
      for (const task of ['debug.fail', 'no.such.task']) {
        try { await heavy.run(task, {}); } catch (e) { msgs.push(e.message); }
      }
      const ok = await heavy.run('debug.sleep', { ms: 10, steps: 1, echo: 1 });
      return { msgs, ok };
    });
    expect(res.msgs[0]).toBe('debug failure');
    expect(res.msgs[1]).toContain('unknown task');
    expect(res.ok.echo).toBe(1);
  });

  test('without a worker the same tasks run on the main thread and can be cancelled', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const heavy = await import('/src/engine/heavy.js');
      heavy.setForceMain(true);
      const spawnedBefore = heavy.stats().spawned;
      const seen = [];
      const ok = await heavy.run('debug.sleep', { ms: 60, steps: 3, echo: 'main' }, { onProgress: (p) => seen.push(p) });
      const ac = new AbortController();
      const p = heavy.run('debug.sleep', { ms: 5000, steps: 50 }, { signal: ac.signal });
      setTimeout(() => ac.abort(), 100);
      let name = null;
      try { await p; } catch (e) { name = e.name; }
      heavy.setForceMain(false);
      return { ok, seen, name, spawnedDelta: heavy.stats().spawned - spawnedBefore };
    });
    expect(res.ok.echo).toBe('main');
    expect(res.seen).toHaveLength(3);
    expect(res.name).toBe(ABORT);
    expect(res.spawnedDelta).toBe(0);
  });
});

test.describe('pipeline and worker restarts', () => {
  test('a job killed by a worker restart (someone else cancelled) is "aborted, render again", not a mode error', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const { getMode } = await import('/src/modes/index.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const heavy = await import('/src/engine/heavy.js');
      const c = document.createElement('canvas');
      c.width = 640; c.height = 400;
      const g = c.getContext('2d');
      g.fillStyle = '#888'; g.fillRect(0, 0, 640, 400); g.fillStyle = '#fff'; g.fillRect(100, 100, 200, 150);
      const source = { id: 's', kind: 'image', width: 640, height: 400, version: 1, animated: false, frame: () => c, dispose() {} };
      const mode = getMode('petscii');
      const params = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: { ...defaultsOf(mode.params), grid: '80' } };
      let invalidated = 0;
      const pipe = createPipeline({ onInvalidate: () => { invalidated++; } });
      // a stuck job of another caller, cancelled while the PETSCII job runs on the same worker -> worker restarted
      const blocker = heavy.run('debug.block', { ms: 3000 }).catch((e) => e.name);
      const job = pipe.render({ source, mode, params, time: 0, quality: 'full', theme: { ink: '#c4f169', bg: '#15181e' } });
      await new Promise((r) => setTimeout(r, 30));
      heavy.cancelAll();
      const firstTry = await job;
      // what the studio does on onInvalidate(): render again (the restart can take one more job with it: up to 400 ms)
      let again = firstTry;
      for (let i = 0; i < 6 && again.retry; i++) {
        await new Promise((r) => setTimeout(r, 150));
        again = await pipe.render({ source, mode, params, time: 0, quality: 'full', theme: { ink: '#c4f169', bg: '#15181e' } });
      }
      return { first: { aborted: !!firstTry.aborted, retry: !!firstTry.retry, error: firstTry.error ? String(firstTry.error) : null }, invalidated, again: { ok: !!again.canvas && !again.error, aborted: !!again.aborted, retry: !!again.retry, error: again.error ? String(again.error) : null, w: again.width }, blocker: await blocker };
    });
    // the PETSCII job waits behind the stuck one; cancelAll() terminates the worker and fails both:
    // the pipeline reports "aborted, render again" (no error, no console.error) and asks for a re-render
    expect(res.first).toEqual({ aborted: true, retry: true, error: null });
    expect(res.invalidated).toBeGreaterThan(0);
    expect(res.again, JSON.stringify(res.again)).toMatchObject({ ok: true, error: null });
    await guard.assertClean(expect);
  });
});
