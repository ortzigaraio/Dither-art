/* Schemas of Diffusion mockup: seeded generative overlays and diagrams. */
(function () {
  'use strict';
  const INK = '#13204a', ACC = '#e4572e';
  function rng(seed) { // mulberry32
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function fit(canvas) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const c = canvas.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [c, w, h];
  }

  /* Fig. 1 overlay: a gradient field sampled from the image itself. */
  const field = document.getElementById('field');
  const img = field && field.parentElement.querySelector('img');
  function drawField() {
    const [c, w, h] = fit(field);
    c.clearRect(0, 0, w, h);
    let L = null, sw = 0, sh = 0;
    try {
      sw = 200; sh = Math.round(200 * img.naturalHeight / img.naturalWidth);
      const o = document.createElement('canvas'); o.width = sw; o.height = sh;
      const oc = o.getContext('2d', { willReadFrequently: true });
      oc.filter = 'blur(2px)'; oc.drawImage(img, 0, 0, sw, sh);
      L = oc.getImageData(0, 0, sw, sh).data;
    } catch (e) { L = null; }
    const lum = (x, y) => {
      if (!L) return 0.5 + 0.5 * Math.sin(x * 0.05) * Math.cos(y * 0.04);
      x = Math.max(0, Math.min(sw - 1, x | 0)); y = Math.max(0, Math.min(sh - 1, y | 0));
      return L[(y * sw + x) * 4] / 255;
    };
    const r = rng(0x0D17);
    c.lineWidth = 1;
    for (let i = 0; i < 420; i++) {
      const u = r(), v = r();
      const x = u * sw, y = v * sh;
      const gx = lum(x + 2, y) - lum(x - 2, y), gy = lum(x, y + 2) - lum(x, y - 2);
      const m = Math.min(1, Math.hypot(gx, gy) * 4);
      const px = u * w, py = v * h;
      const len = 6 + m * 22, a = Math.atan2(gy, gx);
      c.strokeStyle = m > 0.5 ? ACC : 'rgba(19,32,74,.75)';
      c.beginPath(); c.moveTo(px, py); c.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len); c.stroke();
      c.beginPath(); c.arc(px, py, 1 + m * 2.4, 0, Math.PI * 2);
      c.fillStyle = m > 0.5 ? ACC : INK; c.fill();
    }
    // registration crosses
    c.strokeStyle = INK; c.lineWidth = 1;
    for (let gx = 0; gx <= 4; gx++) for (let gy = 0; gy <= 3; gy++) {
      const x = gx / 4 * (w - 20) + 10, y = gy / 3 * (h - 20) + 10;
      c.beginPath(); c.moveTo(x - 6, y); c.lineTo(x + 6, y); c.moveTo(x, y - 6); c.lineTo(x, y + 6); c.stroke();
    }
  }
  if (field && img) { if (img.complete) drawField(); else img.addEventListener('load', drawField); addEventListener('resize', drawField); }

  /* Fig. 3: Bayer 8x8 matrix. */
  const bayerEl = document.getElementById('bayer');
  if (bayerEl) {
    let m = [[0]];
    while (m.length < 8) {
      const n = m.length, out = [];
      for (let y = 0; y < n * 2; y++) { out.push([]); for (let x = 0; x < n * 2; x++) { const b = m[y % n][x % n] * 4; out[y].push(b + [[0, 2], [3, 1]][(y / n) | 0][(x / n) | 0]); } }
      m = out;
    }
    m.flat().forEach((v) => {
      const s = document.createElement('span');
      s.textContent = v;
      s.style.setProperty('--t', (v / 63).toFixed(3));
      if (v > 40) s.className = 'lt';
      bayerEl.appendChild(s);
    });
  }

  /* Fig. 4: Monte-Carlo residual error bands. */
  const un = document.getElementById('uncert');
  function drawUn() {
    const [c, w, h] = fit(un);
    c.clearRect(0, 0, w, h);
    const r = rng(42), N = 64, P = 90;
    const runs = [];
    for (let k = 0; k < N; k++) {
      const pts = []; let e = 0;
      for (let i = 0; i < P; i++) {
        e = e * 0.82 + (r() - 0.5) * 0.5 + Math.sin(i / 9) * 0.06;
        pts.push(e);
      }
      runs.push(pts);
    }
    const X = (i) => 28 + i / (P - 1) * (w - 40), Y = (v) => h / 2 - v * h * 0.55;
    c.strokeStyle = 'rgba(19,32,74,.25)'; c.lineWidth = 1;
    [-0.5, -0.25, 0, 0.25, 0.5].forEach((v) => { c.beginPath(); c.setLineDash(v ? [2, 4] : []); c.moveTo(28, Y(v)); c.lineTo(w - 12, Y(v)); c.stroke(); });
    c.setLineDash([]);
    c.fillStyle = INK; c.font = '10px "IBM Plex Mono", monospace';
    [-0.5, 0, 0.5].forEach((v) => c.fillText((v > 0 ? '+' : '') + v, 0, Y(v) + 3));
    runs.forEach((pts) => { c.strokeStyle = 'rgba(19,32,74,.13)'; c.beginPath(); pts.forEach((v, i) => (i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v)))); c.stroke(); });
    c.strokeStyle = ACC; c.lineWidth = 2; c.beginPath();
    for (let i = 0; i < P; i++) { const col = runs.map((p) => p[i]).sort((a, b) => a - b); const v = col[N >> 1]; i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v)); }
    c.stroke();
  }
  if (un) { drawUn(); addEventListener('resize', drawUn); }

  /* Fig. 5 histograms (seeded). */
  document.querySelectorAll('svg.hist').forEach((svg) => {
    const r = rng(+svg.dataset.seed);
    let d = '';
    for (let i = 0; i < 32; i++) {
      const v = Math.min(1, 0.15 + Math.abs(Math.sin(i / 5 + +svg.dataset.seed)) * 0.6 + r() * 0.25);
      d += `<rect x="${i * 3.125}" y="${24 - v * 24}" width="2.2" height="${v * 24}"/>`;
    }
    svg.innerHTML = d; // generated numbers only, no user input
  });
})();
