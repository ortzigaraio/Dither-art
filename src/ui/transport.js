// Transport bar under the viewer (PLAN.md 4.3, 4.7): play / pause, frame step, scrubber, loop, speed, mute for video files;
// camera picker, mirror and REC for the webcam. Keyboard: Space = play/pause, Left/Right = previous/next frame (paused).
// State is mirrored in data attributes on the bar so it can be inspected and styled.

import { t, onLangChange } from '../i18n/i18n.js';
import { formatClock } from '../io/clock.js';

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const SCRUB_STEPS = 1000;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const isTyping = (target) => {
  if (!(target instanceof Element)) return false;
  if (target.closest('input:not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]')) return true;
  return false;
};

/**
 * @param {{ host: HTMLElement, onRecordToggle: () => void, onCameraChange: (id:string) => void }} hooks
 */
export function createTransport({ host, onRecordToggle, onCameraChange }) {
  let source = null;
  let scrubbing = false;
  let seekBusy = false;
  let seekPending = null;
  let cameras = [];
  let recording = false;
  let recStart = 0;
  let recTimer = 0;
  let built = null;

  function build() {
    host.textContent = '';
    const q = {};
    host.setAttribute('role', 'toolbar');
    host.setAttribute('aria-label', t('transport.label'));

    // ---- video controls
    q.video = el('div', 'tp-group tp-video');
    q.prev = el('button', 'btn btn-ghost btn-sm tp-btn', '|◂');
    q.prev.type = 'button';
    q.prev.id = 'tp-prev';
    q.prev.setAttribute('aria-label', t('transport.prev'));
    q.prev.title = `${t('transport.prev')} (←)`;
    q.play = el('button', 'btn btn-primary btn-sm tp-btn tp-play', '▶');
    q.play.type = 'button';
    q.play.id = 'tp-play';
    q.next = el('button', 'btn btn-ghost btn-sm tp-btn', '▸|');
    q.next.type = 'button';
    q.next.id = 'tp-next';
    q.next.setAttribute('aria-label', t('transport.next'));
    q.next.title = `${t('transport.next')} (→)`;
    q.scrub = el('input', 'tp-scrub');
    q.scrub.type = 'range';
    q.scrub.id = 'tp-scrub';
    q.scrub.min = '0';
    q.scrub.max = String(SCRUB_STEPS);
    q.scrub.step = '1';
    q.scrub.value = '0';
    q.scrub.setAttribute('aria-label', t('transport.scrub'));
    q.time = el('span', 'tp-time mono', '00:00 / 00:00');
    q.time.id = 'tp-time';
    q.loop = el('button', 'btn btn-ghost btn-sm tp-btn', '⟲');
    q.loop.type = 'button';
    q.loop.id = 'tp-loop';
    q.loop.setAttribute('aria-label', t('transport.loop'));
    q.loop.title = t('transport.loop');
    const speedWrap = el('div', 'select-wrap tp-speed');
    q.speed = el('select', 'select');
    q.speed.id = 'tp-speed';
    q.speed.setAttribute('aria-label', t('transport.speed'));
    for (const sp of SPEEDS) {
      const o = el('option', null, `${sp}×`);
      o.value = String(sp);
      q.speed.appendChild(o);
    }
    q.speed.value = '1';
    speedWrap.appendChild(q.speed);
    q.mute = el('button', 'btn btn-ghost btn-sm tp-btn', '');
    q.mute.type = 'button';
    q.mute.id = 'tp-mute';
    q.video.append(q.prev, q.play, q.next, q.scrub, q.time, q.loop, speedWrap, q.mute);

    // ---- webcam controls
    q.cam = el('div', 'tp-group tp-cam');
    const camWrap = el('div', 'select-wrap tp-camera');
    q.camera = el('select', 'select');
    q.camera.id = 'tp-camera';
    q.camera.setAttribute('aria-label', t('transport.camera'));
    camWrap.appendChild(q.camera);
    q.mirror = el('button', 'btn btn-ghost btn-sm', t('transport.mirror'));
    q.mirror.type = 'button';
    q.mirror.id = 'tp-mirror';
    q.record = el('button', 'btn btn-primary btn-sm tp-rec', '');
    q.record.type = 'button';
    q.record.id = 'tp-record';
    q.recTime = el('span', 'tp-time mono', '');
    q.recTime.id = 'tp-rec-time';
    q.cam.append(camWrap, q.mirror, q.record, q.recTime);

    host.append(q.video, q.cam);

    // ---- events
    q.play.addEventListener('click', togglePlay);
    q.prev.addEventListener('click', () => source?.step?.(-1));
    q.next.addEventListener('click', () => source?.step?.(1));
    q.loop.addEventListener('click', () => { if (source) { source.loop = !source.loop; update(); } });
    q.speed.addEventListener('change', () => { if (source) source.playbackRate = Number(q.speed.value); });
    q.mute.addEventListener('click', () => { if (source) { source.muted = !source.muted; update(); } });
    q.scrub.addEventListener('pointerdown', () => { scrubbing = true; });
    const endScrub = () => { scrubbing = false; };
    q.scrub.addEventListener('pointerup', endScrub);
    q.scrub.addEventListener('pointercancel', endScrub);
    q.scrub.addEventListener('blur', endScrub);
    q.scrub.addEventListener('input', () => {
      if (!source || !Number.isFinite(source.duration)) return;
      seekTo((Number(q.scrub.value) / SCRUB_STEPS) * source.duration);
    });
    q.mirror.addEventListener('click', () => { if (source?.setMirror) { source.setMirror(!source.mirror); update(); } });
    q.camera.addEventListener('change', () => onCameraChange?.(q.camera.value));
    q.record.addEventListener('click', () => onRecordToggle?.());
    return q;
  }

  /** Seeks one at a time: while the browser is busy only the latest wanted position is kept. */
  async function seekTo(time) {
    if (seekBusy) { seekPending = time; return; }
    seekBusy = true;
    try {
      await source?.seek?.(time);
      while (seekPending !== null) {
        const next = seekPending;
        seekPending = null;
        await source?.seek?.(next);
      }
    } finally {
      seekBusy = false;
    }
    update();
  }

  function togglePlay() {
    if (!source?.play) return;
    if (source.paused) source.play();
    else source.pause();
  }

  function labels() {
    if (!built) return;
    const playing = source && !source.paused;
    built.play.textContent = playing ? '❚❚' : '▶';
    built.play.setAttribute('aria-label', t(playing ? 'transport.pause' : 'transport.play'));
    built.play.title = `${t(playing ? 'transport.pause' : 'transport.play')} (${t('transport.space')})`;
    const muted = source ? source.muted : true;
    built.mute.textContent = t(muted ? 'transport.muted' : 'transport.sound');
    built.mute.setAttribute('aria-pressed', String(muted));
    built.mute.setAttribute('aria-label', t(muted ? 'transport.unmute' : 'transport.mute'));
    built.loop.setAttribute('aria-pressed', String(!!source?.loop));
    built.mirror.setAttribute('aria-pressed', String(!!source?.mirror));
    built.record.textContent = t(recording ? 'transport.stopRec' : 'transport.rec');
    built.record.setAttribute('aria-pressed', String(recording));
    built.camera.disabled = recording;
  }

  function update() {
    if (!built || !source) return;
    const kind = source.kind;
    host.dataset.kind = kind;
    if (kind === 'video') {
      const dur = Number.isFinite(source.duration) ? source.duration : 0;
      const cur = source.shownTime;
      host.dataset.state = source.paused ? 'paused' : 'playing';
      host.dataset.time = cur.toFixed(3);
      if (!scrubbing) built.scrub.value = String(dur ? Math.round((cur / dur) * SCRUB_STEPS) : 0);
      built.scrub.disabled = !dur;
      built.prev.disabled = built.next.disabled = !source.paused;
      built.time.textContent = `${formatClock(Math.floor(cur))} / ${formatClock(dur)}`;
      built.speed.value = String(source.playbackRate);
    }
    labels();
  }

  function setRecording(on) {
    recording = on;
    host.dataset.recording = String(on);
    clearInterval(recTimer);
    built.recTime.textContent = '';
    if (on) {
      recStart = performance.now();
      const tick = () => { built.recTime.textContent = formatClock((performance.now() - recStart) / 1000); };
      tick();
      recTimer = setInterval(tick, 500);
    }
    labels();
  }

  function fillCameras() {
    built.camera.textContent = '';
    cameras.forEach((c, i) => {
      const o = el('option', null, c.label || t('transport.cameraN', { n: i + 1 }));
      o.value = c.id;
      built.camera.appendChild(o);
    });
    const cur = source?.deviceId;
    if (cur && cameras.some((c) => c.id === cur)) built.camera.value = cur;
    built.camera.parentElement.hidden = cameras.length < 2;
  }

  // ---- keyboard ----------------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (!source || source.kind !== 'video') return;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.body.dataset.view !== 'studio' || host.hidden) return;
    if (document.querySelector('dialog[open]')) return;
    if (isTyping(e.target)) return;
    if (e.key === ' ' || e.code === 'Space') {
      // Space on a button or on a link already means "click"
      if (e.target instanceof Element && e.target.closest('button, a, summary, [role="slider"], input')) return;
      e.preventDefault();
      togglePlay();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && source.paused) {
      if (e.target instanceof Element && e.target.closest('#tp-scrub, [role="slider"], .split-handle, .group-body, .mode-list')) return;
      // The viewer pans with the arrow keys: for video the frame step wins while paused
      e.preventDefault();
      e.stopImmediatePropagation();
      source.step(e.key === 'ArrowRight' ? 1 : -1);
    }
  }, true);

  onLangChange(() => {
    if (!built) return;
    const keepSource = source;
    const wasRecording = recording;
    built = build();
    source = keepSource;
    setRecording(wasRecording);
    if (cameras.length) fillCameras();
    update();
  });

  return {
    /** Show the right controls for `next` (video, webcam, or nothing for pictures). */
    setSource(next) {
      if (source) { source.onState = null; }
      source = next;
      clearInterval(recTimer);
      recording = false;
      const live = !!next && (next.kind === 'video' || next.kind === 'webcam');
      host.hidden = !live;
      if (!live) {
        host.textContent = '';
        built = null;
        delete host.dataset.kind;
        delete host.dataset.state;
        return;
      }
      built ||= build();
      built.video.hidden = next.kind !== 'video';
      built.cam.hidden = next.kind !== 'webcam';
      host.dataset.recording = 'false';
      built.recTime.textContent = '';
      if (next.kind === 'video') {
        next.onState = update;
        next.loop = true;
      }
      update();
    },

    /** Called by the studio on every new picture: keeps the scrubber and the clock in step. */
    tick() { update(); },
    setCameras(list) {
      cameras = list;
      if (built) fillCameras();
    },
    setRecording,
    get recording() { return recording; },
    togglePlay,
  };
}
