/* Dither — ASCII image effect (design mockup component).
 *
 * Turns an image into a live grid of glyphs that shimmers, resolves in on load
 * and reacts to the cursor: glyphs near the pointer scramble, swell and take an
 * accent colour, with a damped (lerp) follow so the lens trails the cursor.
 *
 * Usage (auto-init):
 *   <canvas class="ascii-fx" data-src="img/x.webp" data-cell="9" data-fg="#111"
 *           data-bg="#fff" data-accent="#1E1EFF" data-invert="0" data-fit="cover"></canvas>
 * Or manually:  AsciiEffect.mount(canvas, { src, cell, fg, bg, accent, invert, fit, chars, radius })
 * The canvas takes the size of its CSS box. Plain script (no module) so it also
 * works when the mockups are opened from disk; getImageData then needs http.
 */
(function () {
  'use strict';
  const DEFAULTS = {
    chars: ' .`:-=+*cox#%@',
    cell: 9,            // glyph cell width in CSS px (height = cell * 1.6)
    fg: '#111111',
    bg: 'transparent',
    accent: '#1E1EFF',
    invert: false,      // true for light glyphs on a dark background
    fit: 'cover',
    radius: 140,        // cursor lens radius in CSS px
    font: '"Geist Mono", "JetBrains Mono", ui-monospace, monospace',
    contrast: 1.25,
  };
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function hash(i, t) { // cheap deterministic noise 0..1
    const x = Math.sin(i * 127.1 + t * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function mount(canvas, opts) {
    const o = Object.assign({}, DEFAULTS);
    Object.keys(opts || {}).forEach((k) => { if (opts[k] !== undefined && opts[k] !== '') o[k] = opts[k]; });
    const ctx = canvas.getContext('2d');
    const img = new Image();
    let cols = 0, rows = 0, cw = 0, ch = 0, dpr = 1;
    let lum = null;           // Float32Array of brightness 0..1 per cell
    let atlas = null;         // glyph sprite sheet [fg row, accent row]
    let start = performance.now();
    let visible = true, raf = 0;
    const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999, k: 0, tk: 0 };

    function buildAtlas() {
      const n = o.chars.length;
      atlas = document.createElement('canvas');
      atlas.width = Math.ceil(cw * dpr) * n;
      atlas.height = Math.ceil(ch * dpr) * 2;
      const a = atlas.getContext('2d');
      a.scale(dpr, dpr);
      a.font = `500 ${Math.round(ch * 0.82)}px ${o.font}`;
      a.textAlign = 'center';
      a.textBaseline = 'middle';
      [o.fg, o.accent].forEach((col, r) => {
        a.fillStyle = col;
        for (let i = 0; i < n; i++) a.fillText(o.chars[i], i * Math.ceil(cw * dpr) / dpr + cw / 2, r * Math.ceil(ch * dpr) / dpr + ch / 2);
      });
    }

    function sample() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h || !img.naturalWidth) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      cw = o.cell; ch = o.cell * 1.6;
      cols = Math.max(4, Math.floor(w / cw));
      rows = Math.max(4, Math.floor(h / ch));
      cw = w / cols; ch = h / rows;
      const off = document.createElement('canvas');
      off.width = cols; off.height = rows;
      const oc = off.getContext('2d', { willReadFrequently: true });
      oc.fillStyle = '#fff';
      oc.fillRect(0, 0, cols, rows);
      // fit the image into the grid, correcting for the glyph aspect ratio
      const ia = img.naturalWidth / img.naturalHeight, ga = (cols * cw) / (rows * ch);
      let dw = cols, dh = rows, dx = 0, dy = 0;
      const cover = o.fit === 'cover';
      if ((ia > ga) === cover) { dw = rows * ia * (ch / cw); dx = (cols - dw) / 2; }
      else { dh = cols / ia * (cw / ch); dy = (rows - dh) / 2; }
      oc.drawImage(img, dx, dy, dw, dh);
      lum = new Float32Array(cols * rows);
      try {
        const d = oc.getImageData(0, 0, cols, rows).data;
        for (let i = 0; i < cols * rows; i++) {
          let l = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
          l = Math.min(1, Math.max(0, (l - 0.5) * o.contrast + 0.5));
          lum[i] = o.invert ? l : 1 - l; // density: 1 = densest glyph
        }
      } catch (e) { // file:// taints the canvas: fall back to a generated gradient
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++)
          lum[y * cols + x] = 0.5 + 0.5 * Math.sin(x * 0.15) * Math.cos(y * 0.2);
      }
      buildAtlas();
      start = performance.now();
    }

    function frame(now) {
      raf = 0;
      if (!lum || !atlas) return;
      const t = (now - start) / 1000;
      const w = canvas.width / dpr, h = canvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (o.bg === 'transparent') ctx.clearRect(0, 0, w, h);
      else { ctx.fillStyle = o.bg; ctx.fillRect(0, 0, w, h); }
      // damped cursor (lerp) and lens strength
      mouse.x += (mouse.tx - mouse.x) * 0.14;
      mouse.y += (mouse.ty - mouse.y) * 0.14;
      mouse.k += (mouse.tk - mouse.k) * 0.08;
      const n = o.chars.length - 1;
      const R = o.radius, R2 = R * R;
      const intro = reduced ? 1 : Math.min(1, t / 1.4);
      const gw = Math.ceil(cw * dpr), gh = Math.ceil(ch * dpr);
      const tick = Math.floor(t * 12);
      for (let y = 0; y < rows; y++) {
        const py = y * ch;
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          let v = lum[i];
          const px = x * cw;
          // intro: a diagonal wipe resolves random glyphs into the image
          const wipe = intro * 1.6 - (x / cols * 0.6 + y / rows * 0.4);
          let accent = 0;
          if (wipe < 0.25) {
            if (wipe < 0 && hash(i, 0) > 0.08) continue;
            v = hash(i, tick);
            accent = 1;
          }
          // idle shimmer: a slow diagonal wave nudges the density
          if (!reduced && v > 0.06) v += Math.sin(t * 1.6 + x * 0.18 - y * 0.11) * 0.045;
          let ox = 0, oy = 0;
          if (mouse.k > 0.01) {
            const dx = px + cw / 2 - mouse.x, dy = py + ch / 2 - mouse.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < R2) {
              const f = (1 - Math.sqrt(d2) / R) * mouse.k;
              const f2 = f * f;
              v = v + f2 * 0.6 * (hash(i, tick) - 0.3);
              if (hash(i, tick + 7) < f2 * 0.9) accent = 1;
              const d = Math.sqrt(d2) || 1;
              ox = dx / d * f2 * cw * 1.4; oy = dy / d * f2 * ch * 0.9;
            }
          }
          const gi = Math.max(0, Math.min(n, Math.round(v * n)));
          if (gi === 0 && !accent) continue;
          ctx.drawImage(atlas, gi * gw, accent * gh, gw, gh, px + ox, py + oy, cw, ch);
        }
      }
      if (visible && !reduced) raf = requestAnimationFrame(frame);
    }

    function kick() { if (!raf) raf = requestAnimationFrame(frame); }

    function onMove(e) {
      const r = canvas.getBoundingClientRect();
      mouse.tx = e.clientX - r.left; mouse.ty = e.clientY - r.top;
      if (mouse.k < 0.02) { mouse.x = mouse.tx; mouse.y = mouse.ty; }
      mouse.tk = 1; kick();
    }
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onMove);
    canvas.addEventListener('pointerleave', () => { mouse.tk = 0; kick(); });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) kick(); }).observe(canvas);
    }
    if ('ResizeObserver' in window) {
      let last = '';
      new ResizeObserver(() => {
        const k = canvas.clientWidth + 'x' + canvas.clientHeight;
        if (k !== last) { last = k; sample(); kick(); }
      }).observe(canvas);
    }
    img.onload = () => {
      const go = () => { sample(); kick(); };
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(go); else go();
    };
    img.src = o.src;
    return { resample: sample };
  }

  function auto() {
    document.querySelectorAll('canvas.ascii-fx').forEach((c) => {
      const d = c.dataset;
      mount(c, {
        src: d.src,
        cell: d.cell ? +d.cell : undefined,
        fg: d.fg, bg: d.bg, accent: d.accent,
        invert: d.invert === '1',
        fit: d.fit, chars: d.chars,
        radius: d.radius ? +d.radius : undefined,
      });
    });
  }
  window.AsciiEffect = { mount };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto); else auto();
})();
