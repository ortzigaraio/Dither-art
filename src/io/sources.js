// Input sources (PLAN.md 8). Every source exposes the same small interface so the engine never
// cares where pixels come from:
//
//   { id, kind: 'image'|'video'|'webcam'|'demo', name, width, height,
//     version,     // bumps when the picture itself changes (cache key)
//     animated,    // true when frame(time) returns different pixels over time
//     frameId?,    // optional: changes whenever the pixels do (video frame number); overrides `time` in the cache key
//     frame(time)  -> CanvasImageSource (valid until the next call)
//     dispose() }
//
// Video and webcam sources are not `animated`: they push a new `frameId` (requestVideoFrameCallback) and call
// `onFrame`, so the scheduler renders only when a new picture arrives (PLAN.md 5.7).

import { LIMITS } from '../config.js';
import { FileError } from './validate.js';

let nextVersion = 1;

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Halve the image repeatedly (high-quality smoothing) until it fits in maxSide. */
function downscaleToCanvas(img, srcW, srcH, maxSide) {
  const k = Math.min(1, maxSide / Math.max(srcW, srcH));
  const dstW = Math.max(1, Math.round(srcW * k));
  const dstH = Math.max(1, Math.round(srcH * k));
  let cur = img;
  let cw = srcW;
  let ch = srcH;
  while (cw / 2 >= dstW && ch / 2 >= dstH) {
    const w = Math.ceil(cw / 2);
    const h = Math.ceil(ch / 2);
    const step = makeCanvas(w, h);
    const sctx = step.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(cur, 0, 0, w, h);
    cur = step;
    cw = w;
    ch = h;
  }
  const out = makeCanvas(dstW, dstH);
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(cur, 0, 0, dstW, dstH);
  return out;
}

export class ImageSource {
  /** Decode a validated image file. Throws FileError('decode'|'tooManyPixels'). */
  static async fromFile(file, info = {}) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Older engines reject the option value: retry plain (the browser then decides about EXIF rotation)
      try {
        bitmap = await createImageBitmap(file);
      } catch {
        throw new FileError('decode');
      }
    }
    if (bitmap.width < 1 || bitmap.height < 1) {
      bitmap.close();
      throw new FileError('decode');
    }
    if (bitmap.width * bitmap.height > LIMITS.imageMaxPixels) {
      bitmap.close();
      throw new FileError('tooManyPixels', { max: Math.round(LIMITS.imageMaxPixels / 1e6) });
    }
    const originalW = bitmap.width;
    const originalH = bitmap.height;
    let image = bitmap;
    let downscaled = false;
    if (Math.max(originalW, originalH) > LIMITS.imageWorkMaxSide) {
      image = downscaleToCanvas(bitmap, originalW, originalH, LIMITS.imageWorkMaxSide);
      bitmap.close();
      downscaled = true;
    }
    return new ImageSource(image, file.name, originalW, originalH, downscaled, info);
  }

  constructor(image, name, originalW, originalH, downscaled, info = {}) {
    this.id = 'image';
    this.kind = 'image';
    this.name = name || 'image';
    this.image = image;
    this.width = image.width;
    this.height = image.height;
    this.originalWidth = originalW;
    this.originalHeight = originalH;
    this.downscaled = downscaled;
    this.format = info.format || '';
    this.animated = false;
    this.version = nextVersion++;
  }

  frame() { return this.image; }

  dispose() {
    if (this.image && typeof this.image.close === 'function') this.image.close();
    this.image = null;
  }
}

/**
 * Procedural picture (no licensed files): gradients, a shaded sphere, a ring, bars and the letters DITHER
 * (set in mono capitals on purpose: the brand logo is never retyped with a font, PLAN.md 18.4).
 * With `animated: true` it moves with time; otherwise it renders one fixed frame.
 */
export class DemoSource {
  static async create(opts = {}) {
    try {
      await document.fonts.load('700 120px "Geist Mono"', 'DITHER');
    } catch { /* fall back to the system font */ }
    return new DemoSource(opts);
  }

  constructor({ animated = false, width = 960, height = 640, still = 1.4 } = {}) {
    this.id = 'demo';
    this.kind = 'demo';
    this.name = 'demo';
    this.width = width;
    this.height = height;
    this.animated = animated;
    this.still = still;
    this.version = nextVersion++;
    this.canvas = makeCanvas(width, height);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    this._lastT = null;
    this.draw(still);
  }

  frame(time = 0) {
    if (this.animated) {
      if (this._lastT !== time) this.draw(time);
    }
    return this.canvas;
  }

  draw(t) {
    this._lastT = t;
    const { ctx, width: W, height: H } = this;
    ctx.save();
    ctx.clearRect(0, 0, W, H);

    // Background: diagonal gradient + soft vignette
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#0a0d12');
    bg.addColorStop(0.55, '#2a313d');
    bg.addColorStop(1, '#566073');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Horizontal bars (equaliser) along the top
    const bars = 28;
    for (let i = 0; i < bars; i++) {
      const bw = W / bars;
      const h = (0.18 + 0.82 * Math.abs(Math.sin(i * 0.55 + t * 1.7))) * H * 0.2;
      ctx.fillStyle = `rgba(247,248,250,${0.14 + 0.5 * (i / bars)})`;
      ctx.fillRect(i * bw + 3, 0, bw - 6, h);
    }

    // Ground shadow + sphere (lit from the upper left)
    const sx = W * 0.5 + Math.cos(t * 0.7) * W * 0.2;
    const sy = H * 0.46 + Math.sin(t * 1.1) * H * 0.05;
    const r = H * 0.25;
    const shadow = ctx.createRadialGradient(sx, H * 0.78, 4, sx, H * 0.78, r * 1.25);
    shadow.addColorStop(0, 'rgba(0,0,0,.55)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.scale(1, 0.28);
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.arc(sx, (H * 0.78) / 0.28, r * 1.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const ball = ctx.createRadialGradient(sx - r * 0.38, sy - r * 0.42, r * 0.05, sx, sy, r);
    ball.addColorStop(0, '#ffffff');
    ball.addColorStop(0.22, '#d6dbe4');
    ball.addColorStop(0.62, '#7c8596');
    ball.addColorStop(1, '#161a21');
    ctx.fillStyle = ball;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();

    // A tilted ring around the sphere
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(-0.42 + Math.sin(t * 0.5) * 0.15);
    ctx.lineWidth = r * 0.12;
    const ring = ctx.createLinearGradient(-r * 1.5, 0, r * 1.5, 0);
    ring.addColorStop(0, 'rgba(247,248,250,.95)');
    ring.addColorStop(0.5, 'rgba(140,150,168,.7)');
    ring.addColorStop(1, 'rgba(247,248,250,.95)');
    ctx.strokeStyle = ring;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.55, r * 0.38, 0, Math.PI * 0.08, Math.PI * 0.92);
    ctx.stroke();
    ctx.restore();

    // Orbiting dots
    for (let i = 0; i < 3; i++) {
      const a = t * (0.9 + i * 0.35) + i * 2.1;
      const ox = W * 0.5 + Math.cos(a) * W * (0.36 - i * 0.05);
      const oy = H * 0.5 + Math.sin(a * 1.3) * H * (0.3 - i * 0.04);
      ctx.fillStyle = i === 1 ? '#f7f8fa' : 'rgba(247,248,250,.6)';
      ctx.beginPath();
      ctx.arc(ox, oy, 7 + i * 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // A rotating diamond on the left
    ctx.save();
    ctx.translate(W * 0.15, H * 0.5);
    ctx.rotate(t * 0.6);
    ctx.fillStyle = 'rgba(247,248,250,.88)';
    const d = H * 0.09;
    ctx.beginPath();
    ctx.moveTo(0, -d);
    ctx.lineTo(d, 0);
    ctx.lineTo(0, d);
    ctx.lineTo(-d, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Word mark along the bottom
    ctx.font = `700 ${Math.round(H * 0.2)}px "Geist Mono", "DejaVu Sans Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const tg = ctx.createLinearGradient(0, H * 0.7, 0, H);
    tg.addColorStop(0, '#ffffff');
    tg.addColorStop(1, '#aeb6c4');
    ctx.fillStyle = tg;
    ctx.fillText('DITHER', W / 2, H * 0.94);

    ctx.restore();
  }

  dispose() {
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}

// ---------------------------------------------------------------------------------------------------
// Video and webcam (PLAN.md 8, 18.2)
// ---------------------------------------------------------------------------------------------------

const hasRvfc = () => typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
const median = (a) => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)];
};

/**
 * Shared behaviour of the two <video>-backed sources: a frame counter fed by requestVideoFrameCallback
 * (or by polling currentTime with rAF where it does not exist) and the `onFrame` / `onState` hooks.
 */
class MediaElementSource {
  _initMedia(video) {
    this.video = video;
    this.version = nextVersion++;
    this.animated = false;
    this.frameId = 0;
    this.onFrame = null; // () => void, called for every new picture
    this.onState = null; // () => void, called when playback state / duration / volume change
    this._disposed = false;
    this._vfc = 0;
    this._raf = 0;
    this._lastPolled = -1;
    this._mediaTime = null;
    this._deltas = [];
    this._prevMedia = null;
    this._prevPresented = 0;
    this._frameWaiters = [];
    this._listeners = [];
  }

  _listen(type, fn) {
    this.video.addEventListener(type, fn);
    this._listeners.push([type, fn]);
  }

  _armFrames() {
    if (this._disposed) return;
    if (hasRvfc()) {
      const tick = (now, meta) => {
        this._vfc = 0;
        if (this._disposed) return;
        this._noteFrame(meta?.mediaTime ?? this.video.currentTime, meta?.presentedFrames);
        this._vfc = this.video.requestVideoFrameCallback(tick);
      };
      this._vfc = this.video.requestVideoFrameCallback(tick);
    } else {
      const poll = () => {
        this._raf = 0;
        if (this._disposed) return;
        if (this.video.currentTime !== this._lastPolled && this.video.readyState >= 2) {
          this._lastPolled = this.video.currentTime;
          this._noteFrame(this.video.currentTime, undefined);
        }
        this._raf = requestAnimationFrame(poll);
      };
      this._raf = requestAnimationFrame(poll);
    }
  }

  _noteFrame(mediaTime, presented) {
    // Frame rate estimate: the time between two consecutive presented frames (median of the last dozen)
    if (this._prevMedia !== null && presented !== undefined && presented - this._prevPresented === 1) {
      const d = mediaTime - this._prevMedia;
      if (d > 0.002 && d < 0.5) {
        this._deltas.push(d);
        if (this._deltas.length > 15) this._deltas.shift();
      }
    }
    this._prevMedia = mediaTime;
    if (presented !== undefined) this._prevPresented = presented;
    this._mediaTime = mediaTime;
    this.frameId++;
    const waiters = this._frameWaiters.splice(0);
    for (const w of waiters) w();
    this.onFrame?.();
  }

  /** Resolves when the next picture is presented (or after `ms`, for browsers that never report one). */
  _nextFrame(ms = 250) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { done(); }, ms);
      const done = () => { clearTimeout(timer); resolve(); };
      this._frameWaiters.push(done);
    });
  }

  /** Estimated frames per second (30 until enough frames were seen). */
  get fps() {
    if (this._deltas.length < 4) return 30;
    const raw = 1 / median(this._deltas);
    // Jitter makes the raw number wobble (14.9): snap to the usual rates
    const usual = [10, 12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
    const near = usual.find((u) => Math.abs(raw - u) / u < 0.025);
    return near ?? Math.round(raw * 10) / 10;
  }

  get currentTime() { return this.video.currentTime; }
  /** Time of the picture on screen: while paused that is the presented frame, not the exact seek position. */
  get shownTime() { return this.video.paused && this._mediaTime != null ? this._mediaTime : this.video.currentTime; }
  get paused() { return this.video.paused; }
  get muted() { return this.video.muted; }
  set muted(v) { this.video.muted = !!v; }

  _release() {
    this._disposed = true;
    if (this._vfc && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this._vfc);
    if (this._raf) cancelAnimationFrame(this._raf);
    this._vfc = this._raf = 0;
    for (const [type, fn] of this._listeners) this.video.removeEventListener(type, fn);
    this._listeners = [];
    for (const w of this._frameWaiters.splice(0)) w();
    this.onFrame = this.onState = null;
  }
}

function waitForMedia(video, events, errorMessage, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => cleanup(() => reject(new FileError(errorMessage))), ms);
    const ok = () => cleanup(resolve);
    const bad = () => cleanup(() => reject(new FileError(errorMessage)));
    function cleanup(fn) {
      clearTimeout(timer);
      for (const e of events) video.removeEventListener(e, ok);
      video.removeEventListener('error', bad);
      fn();
    }
    for (const e of events) video.addEventListener(e, ok);
    video.addEventListener('error', bad);
  });
}

export class VideoSource extends MediaElementSource {
  /** Open a validated video file. Throws FileError('videoDecode'). */
  static async fromFile(file, info = {}) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    try {
      const ready = waitForMedia(video, ['loadeddata'], 'videoDecode');
      video.src = url;
      await ready;
      if (!(video.videoWidth > 0 && video.videoHeight > 0)) throw new FileError('videoDecode');
      // Recorded WebM files report an infinite duration until the end has been seen once
      if (!Number.isFinite(video.duration)) {
        const fixed = waitForMedia(video, ['durationchange'], 'videoDecode', 4000).catch(() => {});
        video.currentTime = 1e101;
        await fixed;
        video.currentTime = 0;
      }
    } catch (err) {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      throw err instanceof FileError ? err : new FileError('videoDecode');
    }
    return new VideoSource(video, url, file, info);
  }

  constructor(video, url, file, info = {}) {
    super();
    this._initMedia(video);
    this.id = 'video';
    this.kind = 'video';
    this.name = file.name || 'video';
    this.file = file;
    this.url = url;
    this.format = info.format || '';
    this.width = video.videoWidth;
    this.height = video.videoHeight;
    // Browsers do not say whether there is sound: null = unknown, the export dialog finds out with Mediabunny
    this.hasAudio = video.mozHasAudio ?? null;
    for (const e of ['play', 'pause', 'ended', 'ratechange', 'volumechange', 'durationchange', 'seeked']) {
      this._listen(e, () => this.onState?.());
    }
    // A seek shows a new picture even while paused; browsers without requestVideoFrameCallback rely on this
    this._listen('seeked', () => {
      if (hasRvfc()) return; // the callback fires by itself
      this._noteFrame(this.video.currentTime, undefined);
    });
    this._armFrames();
  }

  frame() { return this.video; }

  get duration() { return this.video.duration; }
  get loop() { return this.video.loop; }
  set loop(v) { this.video.loop = !!v; }
  get playbackRate() { return this.video.playbackRate; }
  set playbackRate(v) { this.video.playbackRate = v; }

  async play() {
    try {
      if (this.video.ended) this.video.currentTime = 0;
      await this.video.play();
    } catch { /* autoplay refused: stays paused */ }
  }

  pause() { this.video.pause(); }

  /** Seek and resolve once the browser shows the new position. */
  seek(time) {
    const v = this.video;
    const target = Math.min(Math.max(0, time), Number.isFinite(v.duration) ? v.duration : time);
    return new Promise((resolve) => {
      const timer = setTimeout(done, 1500);
      function done() { clearTimeout(timer); v.removeEventListener('seeked', done); resolve(); }
      v.addEventListener('seeked', done);
      v.currentTime = target;
    });
  }

  /**
   * Show the next (dir = 1) or previous (dir = -1) picture while paused. The frame rate is only an estimate, so
   * the target moves on until the presented picture really changes.
   */
  async step(dir) {
    if (!this.video.paused) this.pause();
    const before = this._mediaTime ?? this.video.currentTime;
    const d = 1 / (this.fps || 30);
    const end = Number.isFinite(this.duration) ? this.duration : Infinity;
    let target = dir > 0 ? before + d * 1.05 : before - d * 0.5;
    for (let i = 0; i < 6; i++) {
      if (target < 0 || target > end) {
        if (this.video.loop) target = dir > 0 ? 0 : Math.max(0, end - d * 0.5);
        else return;
      }
      const shown = this._nextFrame();
      await this.seek(target);
      await shown;
      if (Math.abs((this._mediaTime ?? 0) - before) > d * 0.25) return;
      target += dir * d;
    }
  }

  dispose() {
    this._release();
    try { this.video.pause(); } catch { /* ignore */ }
    this.video.removeAttribute('src');
    this.video.load(); // drops the decoder
    URL.revokeObjectURL(this.url);
    this.url = '';
    this.file = null;
  }
}

export class WebcamSource extends MediaElementSource {
  /** Ask for the camera. Throws FileError('cameraDenied' | 'cameraNone' | 'cameraBusy' | 'cameraUnsupported'). */
  static async open({ deviceId = '' } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) throw new FileError('cameraUnsupported');
    let stream;
    try {
      const video = { width: { ideal: 1280 }, height: { ideal: 720 } };
      if (deviceId) video.deviceId = { exact: deviceId };
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new FileError('cameraDenied');
      if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new FileError('cameraNone');
      throw new FileError('cameraBusy');
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    try {
      const ready = waitForMedia(video, ['loadeddata'], 'cameraBusy');
      await video.play().catch(() => {});
      await ready;
      if (!(video.videoWidth > 0)) throw new FileError('cameraBusy');
    } catch (err) {
      stream.getTracks().forEach((tr) => tr.stop());
      video.srcObject = null;
      throw err instanceof FileError ? err : new FileError('cameraBusy');
    }
    return new WebcamSource(video, stream);
  }

  /** Cameras that can be chosen (labels are only available after permission was granted). */
  static async listCameras() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || '' , index: i }));
    } catch {
      return [];
    }
  }

  constructor(video, stream) {
    super();
    this._initMedia(video);
    this.id = 'webcam';
    this.kind = 'webcam';
    this.name = 'webcam';
    this.stream = stream;
    this.width = video.videoWidth;
    this.height = video.videoHeight;
    this.mirror = true; // selfie view by default
    this.canvas = makeCanvas(this.width, this.height);
    this.ctx = this.canvas.getContext('2d');
    this.onEnded = null; // () => void, the camera was unplugged or taken away
    this._drawn = -1;
    this._watchTracks(stream);
    this._armFrames();
  }

  _watchTracks(stream) {
    for (const tr of stream.getVideoTracks()) {
      tr.addEventListener('ended', () => { if (!this._disposed) this.onEnded?.(); });
    }
  }

  get deviceId() { return this.stream.getVideoTracks()[0]?.getSettings?.().deviceId || ''; }

  setMirror(on) {
    if (this.mirror === !!on) return;
    this.mirror = !!on;
    this._drawn = -1;
    this.frameId++;
    this.onFrame?.();
  }

  /** Switch camera: the new stream is opened first so a failure keeps the old one running. */
  async useDevice(deviceId) {
    const next = await WebcamSource.open({ deviceId });
    if (this._disposed) {
      // the source was dropped (another file, the demo...) while the new camera was opening: do not leave it on
      next.dispose();
      return;
    }
    const old = this.stream;
    this.stream = next.stream;
    this.video.srcObject = next.stream;
    next.video.srcObject = null;
    next._release();
    await this.video.play().catch(() => {});
    old.getTracks().forEach((tr) => tr.stop());
    this._watchTracks(this.stream);
    if (this.video.videoWidth) {
      this.width = this.video.videoWidth;
      this.height = this.video.videoHeight;
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
    this.version = nextVersion++;
    this.frameId++;
    this.onFrame?.();
  }

  frame() {
    const v = this.video;
    if (this._drawn !== this.frameId && v.readyState >= 2) {
      const g = this.ctx;
      g.save();
      if (this.mirror) { g.translate(this.canvas.width, 0); g.scale(-1, 1); }
      g.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
      g.restore();
      this._drawn = this.frameId;
    }
    return this.canvas;
  }

  get duration() { return Infinity; }

  dispose() {
    this._release();
    for (const tr of this.stream.getTracks()) tr.stop(); // turns the camera light off (PLAN.md 18.2)
    this.video.srcObject = null;
    this.canvas.width = this.canvas.height = 1;
  }
}
