/* dith-er mockup: running timecode and chapter highlighting. */
(function () {
  'use strict';
  const tc = document.getElementById('tc');
  const t0 = performance.now() - 12 * 1000 - 4 / 24 * 1000;
  const pad = (n) => String(n).padStart(2, '0');
  setInterval(() => {
    const s = (performance.now() - t0) / 1000;
    tc.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s) % 60)}:${pad(Math.floor(s * 24) % 24)}`;
  }, 1000 / 24);

  const links = [...document.querySelectorAll('.chapters a')];
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) links.forEach((a) => a.classList.toggle('on', a.dataset.ch === e.target.id));
    }), { rootMargin: '-45% 0px -45% 0px' });
    links.forEach((a) => { const s = document.getElementById(a.dataset.ch); if (s) io.observe(s); });
  }
})();
