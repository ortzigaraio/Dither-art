/* Dither mockups — "cropped reveal & pan" parallax.
 * Each .reveal frame clips its image (overflow hidden); the image is scaled
 * 1.15x and drifts at a different scroll speed. Movement is damped with lerp
 * so it eases toward the target instead of snapping. Frames also un-crop
 * (clip-path inset -> 0) the first time they enter the viewport.
 */
(function () {
  'use strict';
  const frames = [...document.querySelectorAll('.reveal')];
  if (!frames.length) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const items = frames.map((el) => ({
    el,
    img: el.querySelector('img'),
    speed: parseFloat(el.dataset.speed || '0.15'),
    cur: 0,
    target: 0,
  }));

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
    }), { threshold: 0.15 });
    frames.forEach((f) => io.observe(f));
  } else frames.forEach((f) => f.classList.add('is-in'));

  if (reduced) return;
  let running = false;
  function measure() {
    const vh = innerHeight;
    items.forEach((it) => {
      const r = it.el.getBoundingClientRect();
      const mid = r.top + r.height / 2 - vh / 2;   // px from viewport centre
      const max = r.height * 0.065;                  // stay inside the 1.15x overscan
      it.target = Math.max(-max, Math.min(max, -mid * it.speed));
    });
  }
  function tick() {
    let moving = false;
    items.forEach((it) => {
      it.cur += (it.target - it.cur) * 0.085;        // lerp damping
      if (Math.abs(it.target - it.cur) > 0.05) moving = true;
      if (it.img) it.img.style.transform = `translate3d(0, ${it.cur.toFixed(2)}px, 0) scale(1.15)`;
    });
    running = moving;
    if (moving) requestAnimationFrame(tick);
  }
  function onScroll() { measure(); if (!running) { running = true; requestAnimationFrame(tick); } }
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);
  onScroll();
})();
