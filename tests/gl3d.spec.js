// 3D modes in the studio (PLAN.md 4.6, 18.2): WebGL context loss and restore, browsers without WebGL2, and the camera
// interaction (drag = orbit, Shift + drag = pan, wheel = distance, reset, toggle back to viewer zoom / pan).
import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, loadFixture, renderCount, settle, canvasStats, getControl } from './helpers.js';

const GL_MODES = ['lidar', 'hiddenwire', 'raymarch', 'volumetext'];

async function pick(page, id) {
  const before = await renderCount(page);
  await page.click(`#mode-list .mode-item[data-mode-id="${id}"]`);
  await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b, before);
  await settle(page);
}

test.describe('WebGL context loss', () => {
  for (const id of ['hiddenwire', 'raymarch']) {
    test(`${id}: a lost context is reported, restored and rendered again`, async ({ page }) => {
      const guard = watchPage(page);
      // test instrumentation: remember every WebGL2 context the page creates
      await page.addInitScript(() => {
        const orig = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
          const c = orig.call(this, type, ...rest);
          if (type === 'webgl2' && c) (window.__gl2 = window.__gl2 || []).push(c);
          return c;
        };
      });
      await gotoApp(page);
      await loadFixture(page);
      await pick(page, id);
      const before = await canvasStats(page);
      expect(before.variance).toBeGreaterThan(0);

      const lost = await page.evaluate(async () => {
        const live = (window.__gl2 || []).filter((g) => !g.isContextLost());
        const exts = live.map((g) => g.getExtension('WEBGL_lose_context'));
        window.__lose = live.map((g, i) => [g, exts[i]]); // the extension cannot be fetched once the context is lost
        await Promise.all(live.map((g, i) => new Promise((res) => { g.canvas.addEventListener('webglcontextlost', res, { once: true }); exts[i].loseContext(); })));
        return exts.length;
      });
      expect(lost).toBeGreaterThanOrEqual(1);
      await expect(page.locator('.toast', { hasText: 'graphics context was lost' })).toBeVisible();
      await page.waitForTimeout(300); // renders while lost keep the last frame (no error chip)
      await expect(page.locator('#chip-error')).toBeHidden();
      const framesLost = await renderCount(page);

      await page.evaluate(async () => {
        await Promise.all(window.__lose.map(([g, ext]) => new Promise((res) => {
          g.canvas.addEventListener('webglcontextrestored', res, { once: true });
          ext.restoreContext();
        })));
      });
      await expect(page.locator('.toast', { hasText: 'Graphics restored.' })).toBeVisible();
      await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b, framesLost);
      await settle(page);
      const after = await canvasStats(page);
      expect(after.variance).toBeGreaterThan(0);
      expect(after.colors).toBeGreaterThan(1);
      await expect(page.locator('#chip-error')).toBeHidden();
      if (id === 'hiddenwire') expect(after.hash).toBe(before.hash); // same picture as before the loss
      await guard.assertClean(expect);
    });
  }
});

test.describe('without WebGL2', () => {
  test('3D modes are listed disabled with the reason; a remembered 3D mode falls back to ASCII', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
        if (type === 'webgl2') return null;
        return orig.call(this, type, ...rest);
      };
      localStorage.setItem('horain.params', JSON.stringify({ v: 1, modeId: 'lidar' }));
    });
    await gotoApp(page);
    for (const id of GL_MODES) {
      const card = page.locator(`#mode-grid .mode-card[data-mode-id="${id}"]`);
      await expect(card).toHaveAttribute('aria-disabled', 'true');
      await expect(card).toContainText('needs WebGL2');
    }
    await loadFixture(page);
    await expect(page.locator('.toast', { hasText: 'needs WebGL2' }).first()).toBeVisible();
    await expect(page.locator('#mode-list .mode-item[data-mode-id="ascii"]')).toHaveAttribute('aria-current', 'true');
    for (const id of GL_MODES) {
      const item = page.locator(`#mode-list .mode-item[data-mode-id="${id}"]`);
      await expect(item).toHaveAttribute('aria-disabled', 'true');
      await expect(item).toContainText('needs WebGL2');
      expect(await page.locator(`#mode-select option[value="${id}"]`).evaluate((o) => o.disabled)).toBe(true);
    }
    await page.click('#mode-list .mode-item[data-mode-id="raymarch"]', { force: true }); // aria-disabled: still clickable, explains
    await page.waitForTimeout(300);
    await expect(page.locator('#mode-list .mode-item[data-mode-id="ascii"]')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#chip-error')).toBeHidden();
    // every other mode still works
    await page.click('#mode-list .mode-item[data-mode-id="braille"]');
    await expect(page.locator('#mode-list .mode-item[data-mode-id="braille"]')).toHaveAttribute('aria-current', 'true');
    await guard.assertClean(expect);
  });
});

test.describe('camera interaction', () => {
  test('drag orbits, Shift + drag pans, the wheel moves the camera; reset; toggle back to viewer zoom and pan', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    await expect(page.locator('#vw-camera')).toBeHidden(); // ASCII: no camera
    await pick(page, 'hiddenwire');
    const cam = page.locator('#vw-camera');
    await expect(cam).toBeVisible();
    await expect(cam).toHaveAttribute('aria-pressed', 'true');
    const zoom0 = await page.locator('#vw-zoom').textContent();
    const hash0 = (await canvasStats(page)).hash;
    const box = await page.locator('#viewer-viewport').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const yaw0 = await getControl(page, 'yaw');
    const pitch0 = await getControl(page, 'pitch');

    // orbit: 100 px right, 50 px down
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 100, cy + 50, { steps: 10 });
    await page.mouse.up();
    await settle(page);
    expect(await getControl(page, 'yaw')).toBe(yaw0 - 40);
    expect(await getControl(page, 'pitch')).toBe(pitch0 + 15);
    expect((await canvasStats(page)).hash).not.toBe(hash0);

    // pan with Shift
    await page.keyboard.down('Shift');
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 80, cy - 40, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await settle(page);
    expect(await getControl(page, 'panX')).toBeGreaterThan(0.1);
    expect(await getControl(page, 'panY')).toBeLessThan(-0.05);
    expect(await getControl(page, 'yaw')).toBe(yaw0 - 40); // panning does not orbit

    // wheel = camera distance, not the viewer zoom
    const d0 = await getControl(page, 'distance');
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, 400);
    await settle(page);
    expect(await getControl(page, 'distance')).toBeGreaterThan(d0);
    expect(await page.locator('#vw-zoom').textContent()).toBe(zoom0);

    // reset camera
    await page.locator('[data-group="mode"] [data-action="resetCamera"]').click();
    await settle(page);
    expect(await getControl(page, 'yaw')).toBe(yaw0);
    expect(await getControl(page, 'pitch')).toBe(pitch0);
    expect(await getControl(page, 'distance')).toBe(d0);
    expect(await getControl(page, 'panX')).toBe(0);
    expect((await canvasStats(page)).hash).toBe(hash0);

    // camera off: the same gestures zoom and pan the viewer again
    await cam.click();
    await expect(cam).toHaveAttribute('aria-pressed', 'false');
    const t0 = await page.locator('#viewer-world').evaluate((e) => e.style.transform);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy + 30, { steps: 6 });
    await page.mouse.up();
    expect(await page.locator('#viewer-world').evaluate((e) => e.style.transform)).not.toBe(t0);
    expect(await getControl(page, 'yaw')).toBe(yaw0);
    await page.mouse.wheel(0, -300);
    await expect(page.locator('#vw-zoom')).not.toHaveText(zoom0);
    expect(await getControl(page, 'distance')).toBe(d0);
    await guard.assertClean(expect);
  });
});
