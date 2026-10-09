/* Dither Studio mockup: spring accordion, before/after compare, soft reveals. */
(function () {
  'use strict';

  /* Spring easing as a CSS linear() curve. `bounce` is the overshoot in %:
     bounce 10 -> the panel overshoots its target by ~10% before settling. */
  function springCurve(bounce) {
    const os = Math.max(0.001, bounce / 100);
    const zeta = -Math.log(os) / Math.sqrt(Math.PI * Math.PI + Math.log(os) ** 2);
    const w = 2 * Math.PI / 0.62; // natural frequency for ~0.9 s settle
    const wd = w * Math.sqrt(1 - zeta * zeta);
    const pts = [];
    const N = 48;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const v = 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + (zeta * w / wd) * Math.sin(wd * t));
      pts.push(+(i === N ? 1 : v).toFixed(4));
    }
    return 'linear(' + pts.join(', ') + ')';
  }

  document.querySelectorAll('.accordion').forEach((acc) => {
    const open = +acc.dataset.open, reach = +acc.dataset.reach, bounce = +acc.dataset.bounce;
    acc.style.setProperty('--spring', springCurve(bounce));
    const panels = [...acc.querySelectorAll('.panel')];
    const n = panels.length;
    function layout(hi) {
      panels.forEach((p, j) => {
        let g = 100 / n;
        if (hi >= 0) {
          const near = panels.filter((_, k) => Math.abs(k - hi) === 1).length;
          const far = n - 1 - near;
          if (j === hi) g = open;
          else if (Math.abs(j - hi) === 1) g = reach / near;
          else g = far ? (100 - open - reach) / far : 0;
        }
        p.style.flexGrow = g.toFixed(3);
        p.classList.toggle('is-open', j === hi);
      });
    }
    panels.forEach((p, i) => {
      p.addEventListener('pointerenter', () => layout(i));
      p.addEventListener('focus', () => layout(i));
    });
    acc.addEventListener('pointerleave', () => layout(-1));
    layout(-1);
  });

  document.querySelectorAll('.compare').forEach((c) => {
    const range = c.querySelector('.c-range');
    let target = 50, cur = 50, raf = 0;
    const step = () => {
      cur += (target - cur) * 0.22;
      c.style.setProperty('--pos', cur.toFixed(2) + '%');
      raf = Math.abs(target - cur) > 0.05 ? requestAnimationFrame(step) : 0;
    };
    const set = (v) => { target = Math.max(0, Math.min(100, v)); range.value = target; if (!raf) raf = requestAnimationFrame(step); };
    range.addEventListener('input', () => set(+range.value));
    c.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' && !e.buttons) return;
      const r = c.getBoundingClientRect();
      set((e.clientX - r.left) / r.width * 100);
    });
    c.addEventListener('pointerdown', (e) => { const r = c.getBoundingClientRect(); set((e.clientX - r.left) / r.width * 100); });
  });

  const els = document.querySelectorAll('.fade');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { threshold: 0.12 });
    els.forEach((el) => io.observe(el));
  } else els.forEach((el) => el.classList.add('in'));
  requestAnimationFrame(() => document.body.classList.add('loaded'));
})();
