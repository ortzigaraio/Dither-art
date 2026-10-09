/* Dither Summer OS mockup: draggable windows, focus order, a fake player. */
(function () {
  'use strict';
  let z = 10;
  const desktop = document.getElementById('desktop');
  const isDesktop = () => matchMedia('(min-width: 900px)').matches;

  document.querySelectorAll('[data-win]').forEach((win) => {
    const bar = win.querySelector('.titlebar');
    win.addEventListener('pointerdown', () => { win.style.zIndex = ++z; focus(win); });
    bar.addEventListener('pointerdown', (e) => {
      if (!isDesktop() || e.target.closest('.close,.zoom')) return;
      e.preventDefault();
      const r = win.getBoundingClientRect(), d = desktop.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      bar.setPointerCapture(e.pointerId);
      win.classList.add('dragging');
      const move = (ev) => {
        const x = Math.max(0, Math.min(d.width - r.width, ev.clientX - d.left - ox));
        const y = Math.max(0, ev.clientY - d.top - oy);
        win.style.left = x + 'px'; win.style.top = y + 'px';
      };
      const up = () => { win.classList.remove('dragging'); bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });
    win.querySelector('.close').addEventListener('click', () => { win.classList.add('closing'); setTimeout(() => { win.classList.remove('closing'); }, 400); });
  });
  function focus(win) {
    document.querySelectorAll('[data-win]').forEach((w) => w.classList.toggle('active', w === win));
  }
  focus(document.querySelector('.player'));

  const play = document.getElementById('play'), eq = document.getElementById('eq');
  play.addEventListener('click', () => {
    const on = eq.classList.toggle('playing');
    play.textContent = on ? '❚❚' : '▶';
    play.setAttribute('aria-label', on ? 'Pause' : 'Play');
    document.querySelector('.player').classList.toggle('paused', !on);
  });
})();
