// "Cropped reveal & pan": large pictures sit in a frame with overflow: hidden, scaled up (1.15-1.2x), and slide
// vertically at a different speed than the page while it scrolls (parallax), revealing what was hidden above and
// below. The motion is damped with a frame-rate independent lerp in a single requestAnimationFrame loop, only the
// frames on screen (IntersectionObserver) are updated, and with prefers-reduced-motion nothing moves.
//
// Markup:  <figure class="reveal" data-reveal="1.18"><img class="reveal-media" ...></figure>
//          data-reveal = the scale of the picture inside its frame (clamped to 1.05-1.4; default 1.18).

const DEFAULT_SCALE = 1.18;
const SMOOTH = 0.12;       // fraction of the remaining distance covered per 60 Hz frame
const EPS = 0.05;          // px: close enough, stop animating

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Shift of the picture for a frame whose box is `rect` in a viewport `vh` px tall, scaled by `scale`.
 * -1..1 progress through the viewport (entering from below = +1, leaving at the top = -1) maps to a translation in
 * [-max, +max], where max is the extra height on each side, so the picture never uncovers the frame.
 */
export function revealOffset(rect, vh, scale) {
  const range = (vh + rect.height) / 2 || 1;
  const p = clamp((rect.top + rect.height / 2 - vh / 2) / range, -1, 1);
  const max = ((scale - 1) * rect.height) / 2;
  return -p * max;
}

/**
 * @param {ParentNode} [root=document]
 * @param {{ selector?: string }} [opts]
 * @returns {{ refresh(): void, destroy(): void, items: Array }}
 */
export function initReveal(root = document, { selector = '[data-reveal]' } = {}) {
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = !!mq?.matches;
  const items = [];
  let raf = 0;
  let last = 0;

  for (const frame of root.querySelectorAll(selector)) {
    const media = frame.querySelector('.reveal-media') || frame.firstElementChild;
    if (!media) continue;
    const s = clamp(Number.parseFloat(frame.getAttribute('data-reveal')) || DEFAULT_SCALE, 1.05, 1.4);
    items.push({ frame, media, scale: s, y: 0, target: 0, visible: false });
  }

  const apply = (it) => {
    it.media.style.transform = `translate3d(0, ${it.y.toFixed(2)}px, 0) scale(${it.scale})`;
    it.frame.dataset.revealY = it.y.toFixed(1);
  };

  function measure() {
    const vh = window.innerHeight || document.documentElement.clientHeight;
    for (const it of items) {
      if (!it.visible) continue;
      const r = it.frame.getBoundingClientRect();
      if (!r.height) continue; // hidden view
      it.target = reduced ? 0 : revealOffset(r, vh, it.scale);
    }
  }

  function tick(now) {
    raf = 0;
    const dt = last ? Math.min(64, now - last) : 16.7;
    last = now;
    measure();
    const k = 1 - Math.pow(1 - SMOOTH, dt / 16.7);
    let moving = false;
    for (const it of items) {
      if (!it.visible) continue;
      const d = it.target - it.y;
      if (Math.abs(d) > EPS) {
        it.y += d * k;
        moving = true;
      } else {
        it.y = it.target;
      }
      apply(it);
    }
    if (moving) raf = requestAnimationFrame(tick);
    else last = 0;
  }

  function kick() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function still() {
    // reduced motion: no movement at all, the picture rests centred (still cropped)
    for (const it of items) { it.y = 0; it.target = 0; apply(it); }
  }

  const onScroll = () => { if (!reduced) kick(); };
  const onMotion = () => {
    reduced = !!mq?.matches;
    if (reduced) still();
    else kick();
  };

  let io = null;
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const it = items.find((x) => x.frame === e.target);
        if (it) it.visible = e.isIntersecting;
      }
      if (!reduced) kick();
    }, { rootMargin: '15% 0px 15% 0px' });
    for (const it of items) io.observe(it.frame);
  } else {
    for (const it of items) it.visible = true;
  }

  for (const it of items) {
    it.frame.classList.add('is-reveal-ready');
    apply(it);
  }
  if (reduced) still();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  mq?.addEventListener?.('change', onMotion);
  kick();

  return {
    items,
    refresh() { if (reduced) still(); else kick(); },
    destroy() {
      io?.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      mq?.removeEventListener?.('change', onMotion);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
