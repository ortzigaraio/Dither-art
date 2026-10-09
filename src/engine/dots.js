// Procedural Braille dot rendering (PLAN.md 7.2): dots are drawn from an anti-aliased sprite, so the result does not
// depend on any font. Each cell is 2 x 4 dots; `pitch` is the distance between dots in output pixels.

/** Braille dot bit for (column dx, row dy): (0,0)=0x01 (0,1)=0x02 (0,2)=0x04 (1,0)=0x08 (1,1)=0x10 (1,2)=0x20 (0,3)=0x40 (1,3)=0x80 */
export const DOT_BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

/** Alpha sprite (pitch x pitch, 0..255): a circle or a square of diameter/side `scale * pitch`, 4x4 supersampled. */
export function dotSprite(pitch, shape, scale) {
  const out = new Uint8Array(pitch * pitch);
  const half = (scale * pitch) / 2;
  const c = pitch / 2;
  const SS = 4;
  for (let y = 0; y < pitch; y++) {
    for (let x = 0; x < pitch; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS - c;
          const py = y + (sy + 0.5) / SS - c;
          if (shape === 'square' ? Math.abs(px) <= half && Math.abs(py) <= half : px * px + py * py <= half * half) hit++;
        }
      }
      out[y * pitch + x] = Math.round((hit / (SS * SS)) * 255);
    }
  }
  return out;
}

const div255 = (t) => ((t + 128) * 257) >> 16;

/**
 * Draw the dot grid into out.canvas (resized to cols*2*pitch x rows*4*pitch).
 * @param {{ canvas: HTMLCanvasElement, ctx2d: CanvasRenderingContext2D }} out
 * @param {object} g
 * @param {number} g.cols
 * @param {number} g.rows
 * @param {Uint8Array} g.bits       Braille bit mask per cell
 * @param {number} g.pitch
 * @param {'circle'|'square'} g.shape
 * @param {number} g.scale          dot size relative to the pitch (0.3..1)
 * @param {boolean} g.showEmpty     draw switched-off dots at 15 % opacity
 * @param {Uint8ClampedArray|null} g.rgba  colour per cell, or null for `ink`
 * @param {number[]} g.ink
 * @param {number[]|null} g.bg      null = transparent
 * @param {object} scratch          reusable buffers owned by the caller
 */
export function drawBrailleDots(out, g, scratch) {
  const { cols, rows, bits, pitch, shape, scale, showEmpty, rgba, ink, bg } = g;
  const W = cols * 2 * pitch;
  const H = rows * 4 * pitch;
  const canvas = out.canvas;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const key = `${pitch}|${shape}|${scale}`;
  if (scratch.spriteKey !== key) {
    scratch.spriteKey = key;
    scratch.sprite = dotSprite(pitch, shape, scale);
  }
  const sprite = scratch.sprite;
  if (!scratch.img || scratch.img.width !== W || scratch.img.height !== H) {
    scratch.img = new ImageData(W, H);
    scratch.u32 = new Uint32Array(scratch.img.data.buffer);
  }
  const u32 = scratch.u32;
  const bg32 = bg ? (255 << 24) | (bg[2] << 16) | (bg[1] << 8) | bg[0] : 0;
  u32.fill(bg32);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const cell = cy * cols + cx;
      const mask = bits[cell];
      if (mask === 0 && !showEmpty) continue;
      let r, gg, b;
      if (rgba) { r = rgba[cell * 4]; gg = rgba[cell * 4 + 1]; b = rgba[cell * 4 + 2]; } else { r = ink[0]; gg = ink[1]; b = ink[2]; }
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const on = (mask & DOT_BIT[dy][dx]) !== 0;
          if (!on && !showEmpty) continue;
          const gain = on ? 256 : 38; // 15 % of 255
          const x0 = (cx * 2 + dx) * pitch;
          const y0 = (cy * 4 + dy) * pitch;
          for (let sy = 0; sy < pitch; sy++) {
            let s = sy * pitch;
            let d = (y0 + sy) * W + x0;
            for (let sx = 0; sx < pitch; sx++, s++, d++) {
              let a = sprite[s];
              if (a === 0) continue;
              if (!on) a = (a * gain) >> 8;
              if (bg) {
                if (a === 255) { u32[d] = (255 << 24) | (b << 16) | (gg << 8) | r; continue; }
                const ia = 255 - a;
                u32[d] = (255 << 24) | (div255(bg[2] * ia + b * a) << 16) | (div255(bg[1] * ia + gg * a) << 8) | div255(bg[0] * ia + r * a);
              } else {
                u32[d] = (a << 24) | (b << 16) | (gg << 8) | r;
              }
            }
          }
        }
      }
    }
  }
  out.ctx2d.putImageData(scratch.img, 0, 0);
}
