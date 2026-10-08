import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PNG = resolve(here, 'fixtures/fixture.png');
export const SCREENSHOT_DIR = resolve(here, 'screenshots');

/**
 * Collects everything that must stay empty on a healthy page: console errors, uncaught
 * exceptions, failed same-origin requests (404...) and CSP violations.
 */
export function watchPage(page) {
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });
  return {
    problems,
    async cspViolations() {
      return page.evaluate(() => window.__csp || []);
    },
    async assertClean(expect) {
      const csp = await this.cspViolations();
      expect(csp, 'CSP violations').toEqual([]);
      expect(problems, 'console errors / failed requests').toEqual([]);
    },
  };
}

/** Wait until the app finished booting (main.js sets data-ready on <html>). */
export async function gotoApp(page, path = '/') {
  await page.goto(path);
  await page.waitForSelector('html[data-ready="true"]');
}
