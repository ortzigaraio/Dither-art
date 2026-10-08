import { defineConfig, devices } from '@playwright/test';

// The browser is preinstalled (PLAYWRIGHT_BROWSERS_PATH); never run `playwright install`.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.js',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  globalSetup: './global-setup.mjs',
  webServer: {
    command: 'python3 -m http.server 8080',
    cwd: '..',
    url: 'http://localhost:8080/',
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: 20_000,
  },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:8080',
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
    trace: 'off',
  },
  projects: [{ name: 'chromium' }],
});
