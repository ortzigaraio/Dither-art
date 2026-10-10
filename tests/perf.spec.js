// Load performance guards: the boot path is preloaded in parallel, and nothing outside it is fetched before the app
// is ready.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { preloadBlock } from './make-preload.mjs';
import { repoRoot, staticGraph } from './module-graph.mjs';
import { metaSource } from './make-mode-meta.mjs';
import { watchPage, gotoApp, loadFixture, settle, canvasStats } from './helpers.js';

test.describe('load performance', () => {
  test('index.html modulepreloads exactly the static module graph of src/main.js', () => {
    const html = readFileSync(resolve(repoRoot, 'index.html'), 'utf8');
    expect(html, 'run `cd tests && node make-preload.mjs`').toContain(preloadBlock());
  });

  test('src/modes/meta.js matches the mode modules', async ({ page }) => {
    await gotoApp(page);
    const fromModules = await page.evaluate(async () => {
      const { MODES } = await import('/src/modes/index.js');
      return MODES.map((m) => ({
        id: m.id, category: m.category, name: m.name, blurb: m.blurb, badges: m.badges || [], surface: m.surface === 'gl' ? 'gl' : '2d',
      }));
    });
    const meta = readFileSync(resolve(repoRoot, 'src/modes/meta.js'), 'utf8');
    expect(meta, 'run `cd tests && node make-mode-meta.mjs`').toBe(metaSource(fromModules));
  });

  test('the boot path carries only the default mode; the others load on demand', async ({ page }) => {
    const guard = watchPage(page);
    const fetched = [];
    page.on('request', (r) => fetched.push(new URL(r.url()).pathname));
    await page.addInitScript(() => { try { localStorage.clear(); } catch { /* blocked */ } });
    await gotoApp(page);
    const graph = staticGraph();
    const modeFiles = graph.filter((f) => f.startsWith('src/modes/') && !['src/modes/registry.js', 'src/modes/meta.js'].includes(f));
    expect(modeFiles).toEqual(['src/modes/ascii.js']);
    for (const lazy of ['src/io/exportVideo.js', 'src/ui/exportDialog.js', 'src/engine/heavyTasks.js']) expect(graph).not.toContain(lazy);
    // at boot no other mode file was requested (the gallery and the hero tour fetch theirs later, on their own)
    // switching mode loads that mode's code, and it renders
    await loadFixture(page);
    await page.click('#mode-list [data-mode-id="braille"]');
    await expect(page.locator('#mode-list [data-mode-id="braille"]')).toHaveAttribute('aria-current', 'true');
    await settle(page);
    expect(fetched.filter((u) => u.endsWith('/src/modes/braille.js')).length).toBe(1);
    expect((await canvasStats(page)).variance).toBeGreaterThan(0);
    await guard.assertClean(expect);
  });

  test('the preloaded modules are each fetched once, and the critical fonts are preloaded', async ({ page }) => {
    const guard = watchPage(page);
    const fetched = [];
    page.on('request', (r) => { if (r.url().endsWith('.js')) fetched.push(new URL(r.url()).pathname.slice(1)); });
    await gotoApp(page);
    // a preload that does not match the later import (wrong URL or credentials mode) would fetch the module twice
    const graph = staticGraph();
    for (const f of graph) expect(fetched.filter((x) => x === f).length, f).toBe(1);
    const fonts = await page.locator('link[rel="preload"][as="font"]').evaluateAll((ls) => ls.map((l) => l.getAttribute('href')));
    expect(fonts.length).toBeGreaterThanOrEqual(3);
    for (const f of fonts) expect((await page.request.get(f.replace('./', '/'))).ok()).toBe(true);
    await guard.assertClean(expect);
  });
});
