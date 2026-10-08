// Input sources (PLAN.md 8). Every source exposes the same small interface so the engine never
// cares where pixels come from, and Phase 2 can add VideoSource / WebcamSource beside these:
//
//   { id, kind: 'image'|'video'|'webcam'|'demo', name, width, height,
//     version,     // bumps when the picture itself changes (cache key)
//     animated,    // true when frame(time) returns different pixels over time
//     frame(time)  -> CanvasImageSource (valid until the next call)
//     dispose() }

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
      throw new FileError('decode');
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
 * Procedural picture (no licensed files): gradients, a shaded sphere, a ring, bars and the letters HORAIN
 * (set in mono capitals on purpose: the brand logo is never retyped with a font, PLAN.md 18.4).
 * With `animated: true` it moves with time; otherwise it renders one fixed frame.
 */
export class DemoSource {
  static async create(opts = {}) {
    try {
      await document.fonts.load('700 120px "Geist Mono"', 'HORAIN');
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
    ctx.fillText('HORAIN', W / 2, H * 0.94);

    ctx.restore();
  }

  dispose() {
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}
