// Visit counter client (PLAN.md 17), against a mock Worker served by Playwright route interception.
// config.counterUrl stays '' in the repo: the tests serve a config.js with the URL set (the CSP already allows
// https://count.ortzigar.org, so the requests are exactly what production would send).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchPage, gotoApp } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const COUNTER = 'https://count.ortzigar.org';
const configSource = readFileSync(resolve(here, '../src/config.js'), 'utf8');

/** Serve config.js with counterUrl set, and a mock Worker. Returns the log of requests it received. */
async function mockCounter(page, { handler, counterUrl = COUNTER } = {}) {
  await page.route('**/src/config.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: configSource.replace("counterUrl: '',", `counterUrl: ${JSON.stringify(counterUrl)},`),
  }));
  const log = [];
  const state = { total: 1233, today: 41 };
  await page.route(`${COUNTER}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    log.push({ method: req.method(), path: url.pathname, credentials: req.headers().cookie ?? null });
    if (handler) return handler(route, state, log);
    if (req.method() === 'POST' && url.pathname === '/hit') { state.total++; state.today++; }
    else if (!(req.method() === 'GET' && url.pathname === '/count')) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': 'http://localhost:8080', 'Cache-Control': 'no-store' },
      body: JSON.stringify(state),
    });
  });
  return log;
}

const counter = (page) => page.locator('#visit-counter');

test.describe('visit counter', () => {
  test('hidden and silent when config.counterUrl is empty (the repo default)', async ({ page }) => {
    const guard = watchPage(page);
    const outside = [];
    page.on('request', (r) => { if (!r.url().startsWith('http://localhost:8080/')) outside.push(r.url()); });
    await gotoApp(page);
    await page.waitForTimeout(500);
    await expect(counter(page)).toBeHidden();
    expect(await counter(page).innerHTML()).toBe('');
    expect(outside).toEqual([]);
    expect(await page.evaluate(async () => (await import('/src/config.js')).config.counterUrl)).toBe('');
    await guard.assertClean(expect);
  });

  test('first visit of the day POSTs /hit, later visits that day only GET /count', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => { if (!sessionStorage.getItem('x')) { localStorage.clear(); sessionStorage.setItem('x', '1'); } });
    const log = await mockCounter(page);
    await gotoApp(page);
    await expect(counter(page)).toBeVisible();
    await expect(counter(page)).toHaveAttribute('data-total', '1234');
    expect(log).toEqual([{ method: 'POST', path: '/hit', credentials: null }]);
    // the odometer: 6 zero-padded digits, "today", aria-label with the total
    await expect(counter(page)).toHaveAttribute('aria-label', /1234/);
    await expect(counter(page).locator('.vc-digit')).toHaveCount(6);
    await expect(counter(page).locator('.vc-today')).toHaveText(/42/);
    await counter(page).scrollIntoViewIfNeeded();
    await expect(counter(page)).toHaveAttribute('data-rolled', 'true');
    // the digits roll to 001234
    await expect.poll(() => counter(page).locator('.vc-strip').evaluateAll((strips) => strips.map((s) => {
      const m = /translateY\((-?[\d.]+)%\)/.exec(s.style.transform);
      return m ? Math.round(-Number(m[1]) / 10) : -1;
    }).join(''))).toBe('001234');
    const day = await page.evaluate(() => localStorage.getItem('horain.visit'));
    expect(day).toBe(new Date().toISOString().slice(0, 10));

    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await expect(counter(page)).toHaveAttribute('data-total', '1234');
    expect(log.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /hit', 'GET /count']);

    // a visit remembered from another day counts again
    await page.evaluate(() => localStorage.setItem('horain.visit', '2001-01-01'));
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await expect(counter(page)).toHaveAttribute('data-total', '1235');
    expect(log.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /hit', 'GET /count', 'POST /hit']);

    // language switch relabels it
    await page.click('[data-lang="es"]');
    await expect(counter(page)).toHaveAttribute('aria-label', /Visitas totales: 1235/);
    await expect(counter(page).locator('.vc-today')).toHaveText('hoy: 43');
    await guard.assertClean(expect);
  });

  test('Global Privacy Control: shows the number but never counts (GET only)', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => {
      localStorage.clear();
      Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true });
    });
    const log = await mockCounter(page);
    await gotoApp(page);
    await expect(counter(page)).toHaveAttribute('data-total', '1233');
    expect(log.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /count']);
    expect(await page.evaluate(() => localStorage.getItem('horain.visit'))).toBe(null);
    await guard.assertClean(expect);
  });

  test('reduced motion: digits are set without the rolling animation', async ({ page }) => {
    const guard = watchPage(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockCounter(page);
    await gotoApp(page);
    await expect(counter(page)).toHaveClass(/vc-still/);
    await expect(counter(page)).toHaveAttribute('data-rolled', 'true');
    await guard.assertClean(expect);
  });

  test('storage blocked: still shows the number (it counts, it cannot remember)', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); }, configurable: true });
    });
    await mockCounter(page);
    await gotoApp(page);
    await expect(counter(page)).toHaveAttribute('data-total', '1234');
    await guard.assertClean(expect);
  });

  /**
   * Failures: the counter stays hidden and the app writes nothing to the console. The browser itself may report the
   * failed network request (that is not app output), so those lines are filtered out here and checked separately.
   */
  async function expectHiddenAndQuiet(page, handler, waitMs = 600) {
    const appErrors = [];
    page.on('console', (m) => {
      if (m.type() !== 'error' && m.type() !== 'warning') return;
      if (/^Failed to load resource/.test(m.text())) return; // browser network log, not the app
      appErrors.push(m.text());
    });
    page.on('pageerror', (e) => appErrors.push(e.message));
    await page.addInitScript(() => localStorage.clear());
    await mockCounter(page, { handler });
    await gotoApp(page);
    await page.waitForTimeout(waitMs);
    await expect(counter(page)).toBeHidden();
    expect(await counter(page).innerHTML()).toBe('');
    expect(await page.evaluate(() => localStorage.getItem('horain.visit'))).toBe(null);
    expect(await page.evaluate(() => window.__csp || [])).toEqual([]);
    expect(appErrors).toEqual([]);
    await expect(page.locator('#toasts .toast')).toHaveCount(0);
  }

  test('network failure -> hidden, no app errors', async ({ page }) => {
    await page.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective));
    });
    await expectHiddenAndQuiet(page, (route) => route.abort('connectionrefused'));
  });

  test('server error and malformed JSON -> hidden, no app errors', async ({ page }) => {
    await expectHiddenAndQuiet(page, (route) => route.fulfill({ status: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'oops' }));
  });

  test('bad payloads (negative, huge, strings, HTML) -> hidden', async ({ page }) => {
    let i = 0;
    const bodies = ['{"total":-1,"today":0}', '{"total":"<img src=x onerror=alert(1)>","today":1}', 'not json', '{"total":1e300,"today":1}'];
    await expectHiddenAndQuiet(page, (route) => route.fulfill({
      status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: bodies[i++ % bodies.length],
    }));
  });

  test('a Worker that never answers is abandoned after 4 s', async ({ page }) => {
    const t0 = Date.now();
    let aborted = false;
    page.on('requestfailed', (r) => { if (r.url().startsWith(COUNTER)) aborted = Date.now() - t0; });
    await expectHiddenAndQuiet(page, () => { /* never fulfil */ }, 5000);
    expect(aborted).toBeTruthy();
    expect(aborted).toBeGreaterThan(3500);
  });
});
