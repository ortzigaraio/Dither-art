// Hidden-line CAD wireframe (PLAN.md 7.22): the SVG holds only visible segments. Checked against an independent,
// analytic occlusion test: an orthographic camera at yaw 0 and pitch θ looks along d = (0, sin θ, cos θ) towards the
// eye, so a mesh point P of column i is hidden exactly when some point in front of it in the same column rises above
// the ray P + t·d, i.e. H[k][i] > H[j][i] + (z_k - z_j)·tan θ.
import { test, expect } from '@playwright/test';
import { watchPage, gotoApp } from './helpers.js';

/** Render hiddenwire for export on a synthetic picture and summarise mesh, classification and SVGs (in the page). */
async function probe(page, modeParams, pic) {
  return page.evaluate(async ({ mp, pic }) => {
    const { createPipeline } = await import('/src/engine/pipeline.js');
    const { getMode } = await import('/src/modes/index.js');
    const { defaultsOf } = await import('/src/state.js');
    const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
    const { COLOR_PARAMS } = await import('/src/engine/color.js');
    const c = document.createElement('canvas');
    c.width = pic.w; c.height = pic.h;
    const g = c.getContext('2d');
    for (const [col, x, y, w, h] of pic.rects) { g.fillStyle = col; g.fillRect(x * pic.w, y * pic.h, w * pic.w, h * pic.h); }
    const source = { id: 'p', kind: 'image', width: pic.w, height: pic.h, version: Math.random(), animated: false, frame: () => c, dispose() {} };
    const mode = getMode('hiddenwire');
    const pipe = createPipeline();
    const params = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: { ...defaultsOf(mode.params), ...mp } };
    const r = await pipe.render({ source, mode, params, time: 0, theme: { ink: '#fff', bg: '#000' }, isExport: true, quality: 'full' });
    const st = pipe.getState('hiddenwire');
    const m = st.mesh;
    const H = [];
    for (let j = 0; j < m.ny; j++) H.push(Array.from(m.heights.slice(j * m.nx, (j + 1) * m.nx)));
    const Z = Array.from({ length: m.ny }, (_, j) => m.pos[(j * m.nx) * 3 + 2]);
    const lengthOf = (layerId) => {
      const L = st.scene.layers.find((l) => l.id === layerId);
      const per = {};
      for (const p of L?.paths || []) {
        let len = 0;
        for (let i = 2; i < p.points.length; i += 2) len += Math.hypot(p.points[i] - p.points[i - 2], p.points[i + 1] - p.points[i - 1]);
        const k = `${p.kind}:${p.index}`;
        per[k] = (per[k] || 0) + len;
      }
      return per;
    };
    const svg = mode.toSVG(st, {});
    const plot = mode.toSVG(st, { plotter: true, page: 'a4' });
    const inspect = (text) => {
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const fills = Array.from(doc.querySelectorAll('[fill]')).map((e) => e.getAttribute('fill')).filter((f) => f !== 'none');
      return {
        error: !!doc.querySelector('parsererror'), layers: Array.from(doc.querySelectorAll('g[id]')).map((e) => e.id),
        paths: doc.querySelectorAll('path').length, rects: doc.querySelectorAll('rect').length, fills,
        dashed: Array.from(doc.querySelectorAll('g[stroke-dasharray]')).map((e) => e.id),
      };
    };
    const out = {
      error: r.error ? String(r.error) : null, nx: m.nx, ny: m.ny, H, Z, vis: lengthOf('visible'), hid: lengthOf('hidden'),
      rowPx: st.camera.w / st.camera.s, svg: inspect(svg), plot: inspect(plot),
    };
    pipe.dispose();
    return out;
  }, { mp: modeParams, pic });
}

// a dark (low, far) back and a bright (tall, near) wall over the bottom 45 % of the picture
const WALL = { w: 160, h: 100, rects: [['#000000', 0, 0, 1, 1], ['#ffffff', 0, 0.55, 1, 0.45]] };
const PITCH = 60;

test.describe('hidden-line wireframe', () => {
  test('SVG keeps only the visible segments (analytic occlusion of a wall), hidden ones go to the dashed layer', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const base = { topology: 'rows', camera: 'ortho', yaw: 0, pitch: PITCH, autoRotate: 0, distance: 3, heightScale: 2, meshRes: 60, lineWidth: 1 };
    const r = await probe(page, { ...base, hiddenDashed: true }, WALL);
    expect(r.error).toBeNull();
    const tan = Math.tan((PITCH * Math.PI) / 180);
    const margin = 0.06;
    const clearlyHidden = [];
    const clearlyVisible = [];
    for (let j = 0; j < r.ny; j++) {
      let hiddenAll = true;
      let visibleAll = true;
      for (let i = 3; i < r.nx - 3; i++) { // away from the side edges of the mesh
        let worst = -Infinity; // how far the highest point in front rises above the ray
        for (let k = j + 1; k < r.ny; k++) worst = Math.max(worst, r.H[k][i] - (r.H[j][i] + (r.Z[k] - r.Z[j]) * tan));
        if (!(worst > margin)) hiddenAll = false;
        if (!(worst < -margin)) visibleAll = false;
      }
      if (hiddenAll) clearlyHidden.push(j);
      if (visibleAll) clearlyVisible.push(j);
    }
    // the case is meaningful: rows on both sides of the occlusion
    expect(clearlyHidden.length).toBeGreaterThanOrEqual(5);
    expect(clearlyVisible.length).toBeGreaterThanOrEqual(5);
    // the rows behind the wall must not be in the visible layer, and must be in the dashed hidden layer
    for (const j of clearlyHidden) {
      expect(r.vis[`row:${j}`] || 0, `row ${j} hidden`).toBeLessThan(3);
      expect(r.hid[`row:${j}`] || 0, `row ${j} in the hidden layer`).toBeGreaterThan(r.rowPx * 0.6);
    }
    // the rows nobody hides are drawn (almost) entirely
    for (const j of clearlyVisible) {
      expect(r.vis[`row:${j}`] || 0, `row ${j} visible`).toBeGreaterThan(r.rowPx * 0.6);
      expect(r.hid[`row:${j}`] || 0, `row ${j} not hidden`).toBeLessThan(r.rowPx * 0.1);
    }
    expect(r.svg.error).toBe(false);
    expect(r.svg.layers).toEqual(expect.arrayContaining(['background', 'hidden', 'visible']));
    expect(r.svg.dashed).toEqual(['hidden']);

    // without hidden lines: the SVG has no hidden layer at all, and still the same visible rows
    const plain = await probe(page, { ...base, hiddenDashed: false }, WALL);
    expect(plain.svg.layers).not.toContain('hidden');
    for (const j of clearlyHidden) expect(plain.vis[`row:${j}`] || 0).toBeLessThan(3);
    await guard.assertClean(expect);
  });

  test('plotter SVG has strokes only (no fills, no background) and every topology parses', async ({ page }) => {
    await gotoApp(page);
    for (const topology of ['rows', 'cols', 'grid', 'triangles']) {
      for (const camera of ['perspective', 'isometric', 'front', 'top']) {
        const r = await probe(page, { topology, camera, meshRes: 24, style: 'paper' }, { w: 120, h: 90, rects: [['#222', 0, 0, 1, 1], ['#ddd', 0.3, 0.2, 0.4, 0.5]] });
        expect(r.error, `${topology}/${camera}`).toBeNull();
        expect(r.svg.error).toBe(false);
        expect(r.svg.paths, `${topology}/${camera} has paths`).toBeGreaterThan(0);
        expect(r.plot.error).toBe(false);
        expect(r.plot.fills, `${topology}/${camera} plotter fills`).toEqual([]);
        expect(r.plot.rects).toBe(0);
        expect(r.plot.layers).not.toContain('background');
        if (camera === 'front') continue; // seen exactly edge-on, columns collapse to (near) points: nothing to compare
        const kinds = new Set(Object.keys(r.vis).map((k) => k.split(':')[0]));
        const want = { rows: ['row'], cols: ['col'], grid: ['row', 'col'], triangles: ['row', 'col', 'diag'] }[topology];
        for (const k of want) expect(kinds.has(k), `${topology}/${camera} draws ${k}`).toBe(true);
        expect(kinds.size).toBe(want.length);
      }
    }
  });
});
