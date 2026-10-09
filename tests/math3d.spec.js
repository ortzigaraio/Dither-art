// engine/math3d.js and engine/camera.js (PLAN.md 7 3D): projections of known points and orbit-camera invariants.
import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers.js';

test.describe('math3d', () => {
  test('perspective, orthographic, lookAt and inverse project known points exactly', async ({ page }) => {
    await gotoApp(page);
    const r = await page.evaluate(async () => {
      const m = await import('/src/engine/math3d.js');
      const round = (v) => Math.round(v * 1e4) / 1e4 + 0; // + 0 turns -0 into 0
      // eye at (0, 0, 5) looking at the origin, 90 degrees vertical fov, square 200 x 200 viewport
      const view = m.lookAt([0, 0, 5], [0, 0, 0], [0, 1, 0]);
      const proj = m.perspective(Math.PI / 2, 1, 0.1, 100);
      const vp = m.multiply(proj, view);
      const P = (p) => { const q = m.project(vp, p, 200, 200); return [round(q.x), round(q.y), round(q.z), q.inFront]; };
      // orthographic box of half-size 2 around the same camera
      const ovp = m.multiply(m.ortho(-2, 2, -2, 2, 0.1, 100), view);
      const O = (p) => { const q = m.project(ovp, p, 200, 200); return [round(q.x), round(q.y)]; };
      // inverse
      const inv = m.invert(vp);
      const id = m.multiply(inv, vp);
      let maxErr = 0;
      for (let i = 0; i < 16; i++) maxErr = Math.max(maxErr, Math.abs(id[i] - (i % 5 === 0 ? 1 : 0)));
      // lookAt basis is orthonormal for an arbitrary eye
      const v2 = m.lookAt([3, 4, -2], [0.5, -1, 0.25]);
      const rows = [[v2[0], v2[4], v2[8]], [v2[1], v2[5], v2[9]], [v2[2], v2[6], v2[10]]];
      const dots = [];
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) dots.push(round(rows[a][0] * rows[b][0] + rows[a][1] * rows[b][1] + rows[a][2] * rows[b][2]));
      return {
        origin: P([0, 0, 0]), right: P([1, 0, 0]), up: P([0, 1, 0]), corner: P([5, 5, 0]), behind: P([0, 0, 6]),
        nearZ: P([0, 0, 4.9])[2], farZ: P([0, 0, -50])[2],
        oOrigin: O([0, 0, 0]), oRight: O([1, 0, 0]), oFar: O([1, 0, -20]), maxErr, dots,
      };
    });
    expect(r.origin.slice(0, 2)).toEqual([100, 100]);
    // tan(45 deg) = 1: a point 1 unit right at distance 5 lands 100 * 1/5 px right of centre
    expect(r.right.slice(0, 2)).toEqual([120, 100]);
    expect(r.up.slice(0, 2)).toEqual([100, 80]); // screen y grows downwards
    expect(r.corner.slice(0, 2)).toEqual([200, 0]); // the corner of the frustum at that distance
    expect(r.behind[3]).toBe(false); // behind the eye
    expect(r.nearZ).toBeLessThan(r.farZ); // NDC depth grows with distance
    expect(r.nearZ).toBeGreaterThanOrEqual(-1);
    expect(r.farZ).toBeLessThanOrEqual(1);
    // orthographic: no foreshortening
    expect(r.oOrigin).toEqual([100, 100]);
    expect(r.oRight).toEqual([150, 100]);
    expect(r.oFar).toEqual([150, 100]);
    expect(r.maxErr).toBeLessThan(1e-5);
    expect(r.dots).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  test('orbit camera: distance, centring, auto-rotation, pitch limits, pan and ortho framing', async ({ page }) => {
    await gotoApp(page);
    const r = await page.evaluate(async () => {
      const m = await import('/src/engine/math3d.js');
      const out = { dist: [], centre: [], up: [] };
      for (const yaw of [-170, -45, 0, 30, 90, 179]) {
        for (const pitch of [-80, -10, 0, 25, 89]) {
          const cam = m.orbitCamera({ yaw, pitch, distance: 3.5, fov: 50 }, { aspect: 1.5 });
          out.dist.push(Math.hypot(cam.eye[0] - cam.target[0], cam.eye[1] - cam.target[1], cam.eye[2] - cam.target[2]));
          const c = m.project(cam.viewProj, cam.target, 300, 200);
          out.centre.push(Math.max(Math.abs(c.x - 150), Math.abs(c.y - 100)));
          // a point straight "up" of the target (camera up vector) projects above the centre, never below
          const u = m.project(cam.viewProj, [cam.target[0] + cam.up[0] * 0.3, cam.target[1] + cam.up[1] * 0.3, cam.target[2] + cam.up[2] * 0.3], 300, 200);
          out.up.push(u.y < c.y && Math.abs(u.x - c.x) < 1e-3);
        }
      }
      const a = m.orbitCamera({ yaw: 30, pitch: 10, distance: 3, fov: 45 }, { time: 0 });
      const b = m.orbitCamera({ yaw: 0, pitch: 10, distance: 3, fov: 45, autoRotate: 10 }, { time: 3 });
      out.autoRotate = Math.max(...a.eye.map((v, i) => Math.abs(v - b.eye[i])));
      out.yaw0 = m.orbitCamera({ yaw: 0, pitch: 0, distance: 2, fov: 45 }).eye.map((v) => Math.round(v * 1e6) / 1e6 + 0);
      out.yaw90 = m.orbitCamera({ yaw: 90, pitch: 0, distance: 2, fov: 45 }).eye.map((v) => Math.round(v * 1e6) / 1e6 + 0);
      out.clampedPitch = m.orbitCamera({ yaw: 0, pitch: 200, distance: 2, fov: 45 }).pitch;
      const pan = m.orbitCamera({ yaw: 0, pitch: 0, distance: 2, fov: 90, panX: 0.5, panY: -0.25 });
      out.panTarget = pan.target.map((v) => Math.round(v * 1e6) / 1e6 + 0);
      // orthographic orbit frames the same height as the perspective view at the target distance
      const o = m.orbitCamera({ yaw: 20, pitch: 30, distance: 4, fov: 60 }, { aspect: 1, projection: 'ortho' });
      const h = 4 * Math.tan(Math.PI / 6);
      const top = m.project(o.viewProj, [o.target[0] + o.up[0] * h, o.target[1] + o.up[1] * h, o.target[2] + o.up[2] * h], 100, 100);
      out.orthoTop = [Math.round(top.x * 1e3) / 1e3, Math.round(top.y * 1e3) / 1e3];
      return out;
    });
    for (const d of r.dist) expect(d).toBeCloseTo(3.5, 6);
    for (const c of r.centre) expect(c).toBeLessThan(1e-3);
    expect(r.up.every(Boolean)).toBe(true);
    expect(r.autoRotate).toBeLessThan(1e-6); // yaw 30 at t=0 == yaw 0 + 10 deg/s at t=3
    expect(r.yaw0).toEqual([0, 0, 2]);
    expect(r.yaw90).toEqual([2, 0, 0]);
    expect(r.clampedPitch).toBe(89);
    // pan moves the target along camera right (+x at yaw 0) and up, scaled by distance * tan(fov / 2) = 2
    expect(r.panTarget).toEqual([1, -0.5, 0]);
    expect(r.orthoTop).toEqual([50, 0]);
  });

  test('camera gestures map to clamped parameter changes', async ({ page }) => {
    await gotoApp(page);
    const r = await page.evaluate(async () => {
      const c = await import('/src/engine/camera.js');
      const cam = { yaw: 170, pitch: 80, distance: 3, panX: 1.95, panY: 0 };
      return {
        orbit: c.orbitBy(cam, -50, 100), // yaw wraps past 180, pitch clamps at 89
        orbitBack: c.orbitBy({ yaw: 0, pitch: 0 }, 10, -10),
        pan: c.panBy(cam, -100, 50, 400),
        dollyIn: c.dollyBy(cam, -10000).distance,
        dollyOut: c.dollyBy(cam, 10000).distance,
        dolly: c.dollyBy(cam, 100).distance,
        ids: c.CAMERA_IDS,
        reset: c.cameraParams({ yaw: 1 }).find((p) => p.id === 'resetCamera').resets,
      };
    });
    expect(r.orbit.yaw).toBe(-170);
    expect(r.orbit.pitch).toBe(89);
    expect(r.orbitBack).toEqual({ yaw: -4, pitch: -3 });
    expect(r.pan.panX).toBe(2); // clamped
    expect(r.pan.panY).toBeCloseTo(0.25, 5);
    expect(r.dollyIn).toBe(0.6);
    expect(r.dollyOut).toBe(12);
    expect(r.dolly).toBeGreaterThan(3);
    expect(r.reset).toEqual(r.ids);
  });
});
