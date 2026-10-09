// 3D modes (PLAN.md 7.21-7.24): LiDAR PLY export, raymarch / volumetric text determinism and text exports.
// WebGL2 runs on SwiftShader here: resolutions stay small.
import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, renderMode, loadFixture, renderCount, captureDownload } from './helpers.js';

const PICTURE = {
  width: 160, height: 100,
  rects: [['#101010', 0, 0, 1, 1], ['#ffffff', 0.15, 0.2, 0.3, 0.5], ['#808080', 0.55, 0.3, 0.3, 0.4], ['#c04020', 0.6, 0.05, 0.2, 0.15]],
};

function parsePLY(text) {
  const [head, body = ''] = text.split('end_header\n');
  const header = head.split('\n').filter(Boolean);
  const count = Number(/element vertex (\d+)/.exec(head)?.[1]);
  const rows = body.split('\n').filter(Boolean).map((l) => l.split(' '));
  return { header, count, rows };
}

test.describe('LiDAR', () => {
  test('PLY: valid ASCII header, vertex count = points, x y z r g b per line, dropout and colour options', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const full = await renderMode(page, { mode: 'lidar', ...PICTURE, params: { mode: { dropout: 0, step: 4, colorBy: 'original' } }, outputs: ['ply'] });
    expect(full.error).toBeNull();
    const a = parsePLY(full.outputs.ply);
    expect(a.header.slice(0, 2)).toEqual(['ply', 'format ascii 1.0']);
    for (const prop of ['property float x', 'property float y', 'property float z', 'property uchar red', 'property uchar green', 'property uchar blue']) {
      expect(a.header).toContain(prop);
    }
    expect(a.count).toBe(full.meta.cols * full.meta.rows); // no dropout: every grid point
    expect(a.count).toBe(full.meta.points);
    expect(a.rows).toHaveLength(a.count);
    const badRows = a.rows.filter((r) => r.length !== 6
      || !r.slice(0, 3).every((v) => v !== '' && Number.isFinite(Number(v)))
      || !r.slice(3).every((v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 255; }));
    expect(badRows).toEqual([]);
    // original colours: the white rectangle and the red one are in the cloud
    const cols = new Set(a.rows.map((r) => r.slice(3).join(',')));
    expect(cols.has('255,255,255')).toBe(true);
    expect(cols.has('192,64,32')).toBe(true);
    // depth spans depthScale (bright = near = +z)
    const zs = a.rows.map((r) => Number(r[2]));
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.9);

    const drop = await renderMode(page, { mode: 'lidar', ...PICTURE, params: { mode: { dropout: 0.5, step: 4, colorBy: 'ink', ink: '#11aa33' } }, outputs: ['ply'] });
    const b = parsePLY(drop.outputs.ply);
    expect(b.count).toBe(drop.meta.points);
    expect(b.rows).toHaveLength(b.count);
    expect(b.count / a.count).toBeGreaterThan(0.4);
    expect(b.count / a.count).toBeLessThan(0.6);
    expect(new Set(b.rows.map((r) => r.slice(3).join(',')))).toEqual(new Set(['17,170,51']));
    await guard.assertClean(expect);
  });

  test('deterministic at a fixed time; the scan sweep moves with time', async ({ page }) => {
    await gotoApp(page);
    const spec = { mode: 'lidar', ...PICTURE, params: { mode: { step: 4, scanSpeed: 0.5, noise: 0.5 } }, times: [1.25, 1.25, 0.5] };
    const r1 = await renderMode(page, spec);
    const r2 = await renderMode(page, spec);
    expect(r1.frames[0].hash).toBe(r1.frames[1].hash);
    expect(r1.frames[0].hash).toBe(r2.frames[0].hash);
    expect(r1.frames[2].hash).not.toBe(r1.frames[0].hash);
  });

  test('PLY download from the studio', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const before = await renderCount(page);
    await page.click('#mode-list .mode-item[data-mode-id="lidar"]');
    await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b, before);
    const { name, bytes } = await captureDownload(page, () => page.click('[data-export="ply"]'));
    expect(name).toMatch(/^dither-lidar-\d{8}-\d{6}\.ply$/);
    const ply = parsePLY(bytes.toString('utf8'));
    expect(ply.count).toBeGreaterThan(1000);
    expect(ply.rows).toHaveLength(ply.count);
    await guard.assertClean(expect);
  });
});

test.describe('raymarch and volumetric text', () => {
  for (const [mode, extra] of [['raymarch', {}], ['raymarch', { shape: 'morph', displace: 0.5 }], ['volumetext', {}], ['volumetext', { charset: 'braille' }], ['volumetext', { charset: 'blocks', shading: 'toon' }]]) {
    test(`${mode} ${JSON.stringify(extra)}: same frame for the same time, another for another time`, async ({ page }) => {
      const guard = watchPage(page);
      await gotoApp(page);
      const spec = { mode, ...PICTURE, params: { global: { cols: 48 }, mode: extra }, times: [0.7, 0.7, 2.2], outputs: ['txt'] };
      const a = await renderMode(page, spec);
      const b = await renderMode(page, spec);
      expect(a.error).toBeNull();
      expect(a.frames[0].hash).toBe(a.frames[1].hash);
      expect(b.frames[0].hash).toBe(a.frames[0].hash);
      expect(a.frames[2].hash).not.toBe(a.frames[0].hash);
      expect(b.outputs.txt).toBe(a.outputs.txt);
      await guard.assertClean(expect);
    });
  }

  test('TXT has `rows` lines of `cols` characters (ASCII, Braille, blocks)', async ({ page }) => {
    await gotoApp(page);
    for (const [mode, extra, re] of [
      ['raymarch', {}, /^[ .:\-=+*#%@]+$/],
      ['volumetext', { charset: 'ascii' }, /^[ .:\-=+*#%@]+$/],
      ['volumetext', { charset: 'braille' }, /^[⠀-⣿]+$/],
      ['volumetext', { charset: 'blocks' }, /^[ ░▒▓█]+$/],
    ]) {
      const r = await renderMode(page, { mode, ...PICTURE, params: { global: { cols: 40 }, mode: extra }, time: 1, outputs: ['txt', 'html'] });
      expect(r.meta.cols, mode).toBe(40);
      const lines = r.outputs.txt.slice(0, -1).split('\n');
      expect(lines, `${mode} ${extra.charset}`).toHaveLength(r.meta.rows);
      for (const l of lines) expect(Array.from(l)).toHaveLength(40);
      const body = lines.join('');
      expect(body).toMatch(re);
      expect(body.replace(/[ ⠀]/g, '').length, `${mode} draws something`).toBeGreaterThan(20);
      expect(r.outputs.html).toContain('<pre');
    }
  });

  test('the donut is a ring: the centre of a face-on torus is empty and the ring is drawn', async ({ page }) => {
    await gotoApp(page);
    const r = await renderMode(page, {
      mode: 'raymarch', ...PICTURE,
      params: { global: { cols: 60 }, mode: { shape: 'torus', rotX: 0, rotY: 0, pitch: 89, yaw: 0, textureMix: 0, displace: 0 } },
      time: 0, outputs: ['txt'],
    });
    const lines = r.outputs.txt.slice(0, -1).split('\n');
    const cy = Math.floor(lines.length / 2);
    const row = Array.from(lines[cy]);
    expect(row[30]).toBe(' '); // the hole
    expect(row.slice(0, 30).some((c) => c !== ' ')).toBe(true);
    expect(row.slice(31).some((c) => c !== ' ')).toBe(true);
  });
});
