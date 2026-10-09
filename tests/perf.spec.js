// Load performance guards: the boot path is preloaded in parallel, and nothing outside it is fetched before the app
// is ready.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { preloadBlock } from './make-preload.mjs';
import { repoRoot, staticGraph } from './module-graph.mjs';
import { watchPage, gotoApp } from './helpers.js';

test.describe('load performance', () => {
  test('index.html modulepreloads exactly the static module graph of src/main.js', () => {
    const html = readFileSync(resolve(repoRoot, 'index.html'), 'utf8');
    expect(html, 'run `cd tests && node make-preload.mjs`').toContain(preloadBlock());
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
