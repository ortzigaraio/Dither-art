// PLAN.md 18: input validation, hostile external state, blocked storage and file-loading robustness.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  watchPage, gotoApp, loadFixture, renderCount, waitForRender, setControl, getControl, settle, FIXTURE_PNG, openChooser,
} from './helpers.js';

const b64url = (obj) => Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)).toString('base64url');

async function openWithHash(page, hash) {
  await page.goto(`/${hash}`);
  await page.waitForSelector('html[data-ready="true"]');
}

test.describe('5. hostile #s= state', () => {
  test('out-of-range values are clamped, enums fall back, unknown keys are dropped', async ({ page }) => {
    const guard = watchPage(page);
    await openWithHash(page, `#s=${b64url({
      v: 1,
      modeId: 'ascii',
      global: { cols: 99999, brightness: -40, contrast: 1e9, hue: 'abc', dither: 'rm -rf', thresholdOn: 'true', frame: 5000, evil: 1 },
      color: { colorMode: 'lasers', ink: 'url(javascript:alert(1))', bg: '#ABCDEF' },
      modes: { ascii: { gradient: 'nope', cellSize: 1e12, font: '../../etc/passwd', spaceDensity: -9, lineHeight: 'tall' } },
      extra: { a: 1 },
    })}`);
    await loadFixture(page);
    expect(await getControl(page, 'cols')).toBe(600);
    expect(await page.locator('#viewer-canvas').getAttribute('data-cols')).toBe('600');
    expect(await getControl(page, 'brightness')).toBe(0);
    expect(await getControl(page, 'contrast')).toBe(300);
    expect(await getControl(page, 'hue')).toBe(0);
    expect(await getControl(page, 'dither')).toBe('none');
    expect(await getControl(page, 'frame')).toBe(100);
    expect(await getControl(page, 'colorMode')).toBe('mono');
    expect(await getControl(page, 'gradient')).toBe('standard');
    expect(await getControl(page, 'cellSize')).toBe(32);
    expect(await getControl(page, 'font')).toBe('geist-mono');
    expect(await getControl(page, 'spaceDensity')).toBe(0);
    expect(await getControl(page, 'lineHeight')).toBe(1);
    expect((await getControl(page, 'bg')).toLowerCase()).toBe('#abcdef'); // a valid colour survives
    // the app keeps working: it rendered something
    expect(Number(await page.locator('#viewer-canvas').getAttribute('data-frame'))).toBeGreaterThan(0);
    await guard.assertClean(expect);
  });

  test('prototype pollution and script payloads are inert', async ({ page }) => {
    const guard = watchPage(page);
    const payload = '{"v":1,"modeId":"\\"><script>window.__pwned=1</script>","global":{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}},"cols":80},'
      + '"color":{"ink":"<img src=x onerror=window.__pwned=2>","gradStops":["<script>","#fff"]},'
      + '"modes":{"__proto__":{"polluted3":"yes"},"ascii":{"gradient":"custom","customGradient":"<script>window.__pwned=3</script><img src=x onerror=window.__pwned=4>"}}}';
    await openWithHash(page, `#s=${b64url(payload)}`);
    await loadFixture(page);
    const probe = await page.evaluate(() => ({
      pwned: window.__pwned,
      polluted: ({}).polluted ?? ({}).polluted2 ?? ({}).polluted3 ?? null,
      scripts: document.querySelectorAll('script').length,
      injected: document.querySelectorAll('#controls img, #controls script, #toasts img, #toasts script').length,
    }));
    expect(probe.pwned).toBeUndefined();
    expect(probe.polluted).toBeNull();
    expect(probe.scripts).toBe(2); // boot.js + main.js, nothing added
    expect(probe.injected).toBe(0);
    expect(await getControl(page, 'cols')).toBe(80);
    // the hostile text only exists as the value of a text field and as glyphs on the canvas
    expect(await getControl(page, 'customGradient')).toContain('<script>');
    await guard.assertClean(expect);
  });

  test('garbage links are ignored with a notice and no errors', async ({ page }) => {
    const hashes = [
      '#s=', '#s=%%%', '#s=abc', '#s=AAAA', `#s=${'A'.repeat(20000)}`, `#s=${b64url('not json at all')}`,
      `#s=${b64url('[1,2,3]')}`, `#s=${b64url('null')}`, `#s=${b64url({ v: 2 })}`, `#s=${b64url({ v: 1, global: [1, 2, 3] })}`,
      '#s=<script>alert(1)</script>', '#something-else',
    ];
    for (const hash of hashes) {
      const guard = watchPage(page);
      await openWithHash(page, hash);
      if (hash.startsWith('#s=') && !hash.includes('global') ) {
        // invalid links get a notice (a valid-but-empty share such as v:1 + bad global is simply sanitised)
        await expect(page.locator('.toast'), hash.slice(0, 40)).toBeVisible();
      }
      await page.setInputFiles('#file-input', FIXTURE_PNG);
      await page.waitForSelector('body[data-view="studio"]');
      await settle(page);
      expect(await getControl(page, 'cols')).toBe(120);
      await guard.assertClean(expect);
    }
  });

  test('a valid share link restores the settings it was made from', async ({ page, browser }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    await setControl(page, 'brightness', 137);
    await setControl(page, 'gradient', 'blocks');
    await setControl(page, 'colorMode', 'gradient');
    await setControl(page, 'dither', 'jjn');
    await page.click('[data-export="share"]');
    await expect(page.locator('.toast')).toBeVisible();
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toMatch(/#s=[A-Za-z0-9_-]+$/);
    expect(url.length).toBeLessThan(2000);

    // a brand-new browser context has empty storage, so only the link can carry the settings
    const ctx2 = await browser.newContext();
    const fresh = await ctx2.newPage();
    const guard2 = watchPage(fresh);
    await fresh.goto(url);
    await fresh.waitForSelector('html[data-ready="true"]');
    await loadFixture(fresh);
    expect(await getControl(fresh, 'brightness')).toBe(137);
    expect(await getControl(fresh, 'gradient')).toBe('blocks');
    expect(await getControl(fresh, 'colorMode')).toBe('gradient');
    expect(await getControl(fresh, 'dither')).toBe('jjn');
    await guard.assertClean(expect);
    await guard2.assertClean(expect);
    await ctx2.close();
  });
});

test.describe('storage', () => {
  test('the app works when localStorage is blocked', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
      });
    });
    await gotoApp(page);
    await page.selectOption('#theme-select', 'crt');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'crt');
    await page.click('.lang-toggle [data-lang="es"]');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await loadFixture(page);
    await setControl(page, 'brightness', 150);
    expect(await getControl(page, 'brightness')).toBe(150);
    await page.waitForTimeout(400); // the debounced save runs and must not throw
    await guard.assertClean(expect);
  });

  test('corrupt or hostile localStorage values are validated, not trusted', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => {
      localStorage.setItem('horain.theme', '<script>alert(1)</script>');
      localStorage.setItem('horain.lang', 'klingon');
      localStorage.setItem('horain.params', JSON.stringify({
        v: 1, modeId: 'nope', global: { cols: 'many', brightness: 9999 }, color: { ink: 'red' }, modes: { ascii: { cellSize: -3 } },
      }));
    });
    await gotoApp(page);
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(['horain', 'claro']).toContain(theme);
    expect(['es', 'en']).toContain(await page.locator('html').getAttribute('lang'));
    await loadFixture(page);
    expect(await getControl(page, 'cols')).toBe(120);
    expect(await getControl(page, 'brightness')).toBe(200);
    expect(await getControl(page, 'cellSize')).toBe(6);
    await guard.assertClean(expect);
  });

  test('settings are remembered across reloads', async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
    await setControl(page, 'contrast', 175);
    await setControl(page, 'font', 'courier');
    await setControl(page, 'colorMode', 'original');
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await loadFixture(page);
    expect(await getControl(page, 'contrast')).toBe(175);
    expect(await getControl(page, 'font')).toBe('courier');
    expect(await getControl(page, 'colorMode')).toBe('original');
  });
});

// ---------------------------------------------------------------------------------------------------
test.describe('18.1 file input', () => {
  const tinyGif = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');

  test('a corrupt image behind a valid header gets a toast and the app stays usable', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const png = Buffer.alloc(80);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12);
    png.writeUInt32BE(64, 16);
    png.writeUInt32BE(64, 20);
    await page.setInputFiles('#file-input', { name: 'broken.png', mimeType: 'image/png', buffer: png });
    await expect(page.locator('.toast-error')).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-view', 'home');
    // still usable afterwards
    await loadFixture(page);
    await guard.assertClean(expect);
  });

  test('an image over 100 megapixels is refused before decoding', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const png = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12);
    png.writeUInt32BE(30000, 16);
    png.writeUInt32BE(30000, 20);
    await page.setInputFiles('#file-input', { name: 'huge.png', mimeType: 'image/png', buffer: png });
    await expect(page.locator('.toast-error')).toContainText(/100/);
    await expect(page.locator('body')).toHaveAttribute('data-view', 'home');
    await guard.assertClean(expect);
  });

  test('SVG, PDF and a renamed executable are rejected whatever their extension', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const bad = [
      ['logo.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>')],
      ['doc.jpg', Buffer.from('%PDF-1.7\n1 0 obj\n')],
      ['run.webp', Buffer.from('MZ\x90\x00\x03\x00\x00\x00 this is a windows executable')],
      ['photo.heic', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(12)])],
    ];
    for (const [name, buffer] of bad) {
      await page.setInputFiles('#file-input', { name, mimeType: 'image/png', buffer });
      await expect(page.locator('.toast-error').last()).toBeVisible();
      await expect(page.locator('body')).toHaveAttribute('data-view', 'home');
      await page.evaluate(() => document.getElementById('toasts').replaceChildren());
    }
    await guard.assertClean(expect);
  });

  test('a real PNG with the wrong extension is accepted (type comes from the bytes)', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await page.setInputFiles('#file-input', { name: 'photo.txt', mimeType: 'text/plain', buffer: readFileSync(FIXTURE_PNG) });
    await page.waitForSelector('body[data-view="studio"]');
    await guard.assertClean(expect);
  });

  test('a hostile file name is shown as text, never as markup', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const name = '"><img src=x onerror=window.__pwned=1>.png';
    await page.setInputFiles('#file-input', { name, mimeType: 'image/png', buffer: readFileSync(FIXTURE_PNG) });
    await page.waitForSelector('body[data-view="studio"]');
    await expect(page.locator('[data-group="input"] .src-name')).toHaveText(name);
    const probe = await page.evaluate(() => ({ pwned: window.__pwned, imgs: document.querySelectorAll('#controls img, #toasts img').length }));
    expect(probe).toEqual({ pwned: undefined, imgs: 0 });
    await guard.assertClean(expect);
  });

  test('an animated GIF warns that only the first frame is used', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await page.setInputFiles('#file-input', { name: 'dot.gif', mimeType: 'image/gif', buffer: tinyGif });
    await page.waitForSelector('body[data-view="studio"]');
    await expect(page.locator('.toast')).toContainText(/first frame/i);
    await guard.assertClean(expect);
  });

  test('video files are recognised but explain that video is not available yet', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2')]);
    await page.setInputFiles('#file-input', { name: 'clip.mp4', mimeType: 'video/mp4', buffer: mp4 });
    await expect(page.locator('.toast')).toContainText(/video/i);
    await expect(page.locator('body')).toHaveAttribute('data-view', 'home');
    await guard.assertClean(expect);
  });

  test('a very large image is reduced for working and the user is told', async ({ page }) => {
    test.setTimeout(120_000);
    const guard = watchPage(page);
    await gotoApp(page);
    const b64 = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 5200;
      c.height = 3000;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 5200, 3000);
      grad.addColorStop(0, '#102030');
      grad.addColorStop(1, '#f0e0a0');
      g.fillStyle = grad;
      g.fillRect(0, 0, 5200, 3000);
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(2600, 1500, 900, 0, Math.PI * 2);
      g.fill();
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s);
    });
    await page.setInputFiles('#file-input', { name: 'big.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
    await page.waitForSelector('body[data-view="studio"]');
    await expect(page.locator('.toast')).toContainText(/4096/);
    await expect(page.locator('[data-group="input"] .src-line')).toContainText('4096×2363');
    await expect(page.locator('[data-group="input"] .src-line')).toContainText('5200×3000');
    await guard.assertClean(expect);
  });

  test('dropping several files uses the first one and says so', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const b64 = readFileSync(FIXTURE_PNG).toString('base64');
    await page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'one.png', { type: 'image/png' }));
      dt.items.add(new File([bytes], 'two.png', { type: 'image/png' }));
      for (const type of ['dragenter', 'dragover']) {
        document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      window.__draggingClass = document.body.classList.contains('is-dragging');
      document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, b64);
    expect(await page.evaluate(() => window.__draggingClass)).toBe(true);
    await page.waitForSelector('body[data-view="studio"]');
    await expect(page.locator('[data-group="input"] .src-name')).toHaveText('one.png');
    await expect(page.locator('.toast')).toContainText(/first/i);
    await expect(page.locator('body')).not.toHaveClass(/is-dragging/);
    await guard.assertClean(expect);
  });

  test('the whole document accepts a drop, also while the studio is open', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const b64 = readFileSync(FIXTURE_PNG).toString('base64');
    await page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
      document.querySelector('.viewer-viewport').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, b64);
    await expect(page.locator('[data-group="input"] .src-name')).toHaveText('dropped.png');
    await guard.assertClean(expect);
  });

  test('pasting an image from the clipboard opens it', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const b64 = readFileSync(FIXTURE_PNG).toString('base64');
    await page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    }, b64);
    await page.waitForSelector('body[data-view="studio"]');
    await guard.assertClean(expect);
  });

  test('the demo button opens the studio with the procedural picture', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await page.click('[data-action="demo"]');
    await page.waitForSelector('body[data-view="studio"]');
    await expect(page.locator('[data-group="input"] .src-name')).toHaveText(/demo/i);
    await expect(page.locator('[data-group="input"] .src-line')).toContainText('960×640');
    await page.waitForFunction(() => Number(document.getElementById('viewer-canvas').dataset.frame || 0) > 0);
    await guard.assertClean(expect);
  });

  test('"change file" reopens the picker and a new file replaces the old one', async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
    const chooser = await openChooser(page, () => page.click('#change-file'));
    await chooser.setFiles({ name: 'second.png', mimeType: 'image/png', buffer: readFileSync(FIXTURE_PNG) });
    await expect(page.locator('[data-group="input"] .src-name')).toHaveText('second.png');
  });
});

// ---------------------------------------------------------------------------------------------------
test.describe('18.2 runtime robustness', () => {
  test('uncaught errors become a toast and a console record, never a blank page', async ({ page }) => {
    await gotoApp(page);
    const logged = [];
    page.on('console', (m) => { if (m.type() === 'error') logged.push(m.text()); });
    await page.evaluate(() => {
      setTimeout(() => { throw new Error('synthetic failure'); }, 0);
      Promise.reject(new Error('synthetic rejection'));
    });
    await expect(page.locator('.toast-error')).toBeVisible();
    await expect.poll(() => logged.length).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#dropzone')).toBeVisible();
  });

  test('a mode that throws shows the original with the error chip and the studio keeps working', async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
    // break the mode's renderer from the outside, the way a bug in a future mode would
    await page.evaluate(async () => {
      const { default: ascii } = await import('/src/modes/ascii.js');
      window.__origRender = ascii.render;
      ascii.render = () => { throw new Error('mode exploded'); };
      console.error = () => {}; // the pipeline logs the failure; this test expects it
    });
    const n = await renderCount(page);
    await setControl(page, 'brightness', 130);
    await waitForRender(page, n);
    await expect(page.locator('#chip-error')).toBeVisible();
    const variance = await page.evaluate(() => {
      const c = document.getElementById('viewer-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i];
      return s;
    });
    expect(variance).toBeGreaterThan(0);
    // repair: next render clears the chip
    await page.evaluate(async () => {
      const { default: ascii } = await import('/src/modes/ascii.js');
      ascii.render = window.__origRender;
    });
    const n2 = await renderCount(page);
    await setControl(page, 'brightness', 120);
    await waitForRender(page, n2);
    await expect(page.locator('#chip-error')).toBeHidden();
  });

  test('slow renders lower the working resolution automatically (CALIDAD AUTO) but exports stay full quality', async ({ page }) => {
    test.setTimeout(120_000);
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    await page.evaluate(async () => {
      const { default: ascii } = await import('/src/modes/ascii.js');
      const orig = ascii.render;
      ascii.render = function slow(ctx, state) {
        if (!ctx.isExport) { const t = performance.now(); while (performance.now() - t < 230); }
        return orig.call(this, ctx, state);
      };
    });
    await expect(page.locator('#chip-auto')).toBeHidden();
    for (let i = 0; i < 8; i++) {
      const n = await renderCount(page);
      await setControl(page, 'brightness', 100 + ((i % 2) ? 5 : 10) + i);
      await waitForRender(page, n);
    }
    await expect(page.locator('#chip-auto')).toBeVisible();
    const cols = Number(await page.locator('#viewer-canvas').getAttribute('data-cols'));
    expect(cols).toBeLessThan(120);
    // the export is still full resolution: 120 columns
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-export="txt"]')]);
    const lines = readFileSync(await dl.path(), 'utf8').slice(0, -1).split('\n');
    expect(Array.from(lines[0])).toHaveLength(120);
    await guard.assertClean(expect);
  });

  test('dragging a file over the page shows the overlay with animated marching ants', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(8)], 'x.png', { type: 'image/png' }));
      document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      document.getElementById('dropzone').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await expect(page.locator('body')).toHaveClass(/is-dragging/);
    await expect(page.locator('#drop-overlay')).toBeVisible();
    await expect(page.locator('#dropzone')).toHaveClass(/is-dragover/);
    const anim = await page.locator('#dropzone .dz-ants rect').evaluate((el) => getComputedStyle(el).animationName);
    expect(anim).toBe('ants');
    const overlayAnim = await page.locator('.drop-overlay-box rect').evaluate((el) => getComputedStyle(el).animationName);
    expect(overlayAnim).toBe('ants');
    // leaving the window clears it
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(8)], 'x.png', { type: 'image/png' }));
      document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await expect(page.locator('body')).not.toHaveClass(/is-dragging/);
  });

  test('the studio renders only when something changed (idle = no frames)', async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
    const n = await settle(page);
    await page.waitForTimeout(700);
    expect(await renderCount(page)).toBe(n);
    await setControl(page, 'brightness', 140);
    await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b, n);
  });

  test('dragging a slider renders in draft quality and releasing it renders in full quality', async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
    await page.evaluate(async () => {
      const { default: ascii } = await import('/src/modes/ascii.js');
      const orig = ascii.render;
      window.__qualities = [];
      ascii.render = function spy(ctx, state) {
        window.__qualities.push(ctx.quality);
        return orig.call(this, ctx, state);
      };
    });
    const range = page.locator('[data-param="brightness"] .range');
    const box = await range.boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 6 });
    await page.waitForTimeout(150);
    const during = await page.evaluate(() => window.__qualities.slice());
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.__qualities.slice());
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((q) => q === 'draft')).toBe(true);
    expect(after[after.length - 1]).toBe('full');
  });

  test('the hard column limit holds even if the state says otherwise', async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
    const cols = await page.evaluate(async () => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const ascii = (await import('/src/modes/ascii.js')).default;
      const { DemoSource } = await import('/src/io/sources.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const src = await DemoSource.create({ animated: false });
      const pipe = createPipeline();
      const params = { global: { ...defaultsOf(IMAGE_PARAMS), cols: 5000 }, color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: defaultsOf(ascii.params) };
      const r = await pipe.render({ source: src, mode: ascii, params, theme: { ink: '#fff', bg: '#000' } });
      return r.meta.cols;
    });
    expect(cols).toBe(600);
  });

  test('export size is capped at 8192 px and the user is told', async ({ page }) => {
    test.setTimeout(120_000);
    await gotoApp(page);
    await loadFixture(page);
    await setControl(page, 'cols', 600);
    await page.locator('[data-export="png-scale"]').selectOption('4');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-export="png"]')]);
    const buf = readFileSync(await dl.path());
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    expect(Math.max(w, h)).toBeLessThanOrEqual(8192);
    expect(Math.max(w, h)).toBeGreaterThan(7000);
    await expect(page.locator('.toast').first()).toBeVisible();
  });

  test('rendering pauses while the tab is hidden and resumes after', async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
    // Hide the page the way the browser does, then change a setting: nothing renders until it is visible again
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const n = await renderCount(page);
    await setControl(page, 'brightness', 160);
    await page.waitForTimeout(400);
    expect(await renderCount(page)).toBe(n);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitForRender(page, n);
  });
});

test.describe('18.2 the page never looks alive but dead', () => {
  test('if the app script cannot run, a visible notice explains it', async ({ page }) => {
    test.setTimeout(30_000);
    await page.route('**/src/main.js', (route) => route.abort());
    await page.goto('/');
    await expect(page.locator('p.noscript[role="alert"]')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('p.noscript')).toContainText(/could not start|no ha podido arrancar/);
    // the static page (header, headline, dropzone text) is still there to read
    await expect(page.locator('#hero-title')).toBeVisible();
  });

  test('a healthy start never shows the notice', async ({ page }) => {
    test.setTimeout(30_000);
    await gotoApp(page);
    await page.waitForTimeout(6500); // the safety net fires at 6 s
    await expect(page.locator('p.noscript')).toHaveCount(0);
  });
});
