// PETSCII cell matching (PLAN.md 7.4). Pure functions without DOM access: they run on the main thread for small
// grids and inside heavy.worker.js above 40x25 cells, with identical results.
//
// Each cell is an 8x8 block of pixels. For every glyph the "on" pixels get one foreground colour (the palette colour
// nearest to their mean) and the "off" pixels get the single global background colour. The glyph with the least
// summed squared RGB error wins; ties keep the lowest glyph index (index 0 is the empty glyph).

function nearestIndex(palette, r, g, b) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i];
    const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Most frequent palette colour of the picture (RGBA W x H). */
export function autoBackground(rgba, W, H, palette) {
  const count = new Float64Array(palette.length);
  const cache = new Int16Array(32768).fill(-1); // 5 bits per channel
  for (let i = 0, n = W * H; i < n; i++) {
    const o = i * 4;
    const key = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3);
    let idx = cache[key];
    if (idx < 0) idx = cache[key] = nearestIndex(palette, rgba[o], rgba[o + 1], rgba[o + 2]);
    count[idx]++;
  }
  let best = 0;
  for (let i = 1; i < count.length; i++) if (count[i] > count[best]) best = i;
  return best;
}

/**
 * Match cell rows y0..y1-1.
 * @param {{ rgba: Uint8ClampedArray, cols: number, palette: number[][], glyphs: Uint8Array, enabled: Uint8Array }} p
 * @param {number} bg palette index of the global background
 * @param {Uint16Array} glyphOut glyph index per cell
 * @param {Uint8Array} colorOut palette index of the foreground per cell
 */
export function matchRows(p, bg, y0, y1, glyphOut, colorOut) {
  const { rgba, cols, palette, glyphs, enabled } = p;
  const W = cols * 8;
  const nG = enabled.length;
  const B = palette[bg];
  const cr = new Float64Array(64);
  const cg = new Float64Array(64);
  const cb = new Float64Array(64);
  for (let cy = y0; cy < y1; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let totBg = 0;
      for (let py = 0; py < 8; py++) {
        let o = ((cy * 8 + py) * W + cx * 8) * 4;
        for (let px = 0; px < 8; px++, o += 4) {
          const i = py * 8 + px;
          const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
          cr[i] = r; cg[i] = g; cb[i] = b;
          totBg += (r - B[0]) ** 2 + (g - B[1]) ** 2 + (b - B[2]) ** 2;
        }
      }
      let bestErr = Infinity;
      let bestGlyph = 0;
      let bestColor = bg;
      for (let g = 0; g < nG; g++) {
        if (!enabled[g]) continue;
        let n = 0, s1r = 0, s1g = 0, s1b = 0, s2 = 0, sb = 0;
        for (let py = 0; py < 8; py++) {
          const byte = glyphs[g * 8 + py];
          if (!byte) continue;
          for (let px = 0; px < 8; px++) {
            if (!(byte & (0x80 >> px))) continue;
            const i = py * 8 + px;
            const r = cr[i], gg = cg[i], b = cb[i];
            n++;
            s1r += r; s1g += gg; s1b += b;
            s2 += r * r + gg * gg + b * b;
            sb += (r - B[0]) ** 2 + (gg - B[1]) ** 2 + (b - B[2]) ** 2;
          }
        }
        let err;
        let fg = bg;
        if (n === 0) {
          err = totBg;
        } else {
          fg = nearestIndex(palette, s1r / n, s1g / n, s1b / n);
          const F = palette[fg];
          const onErr = s2 - 2 * (F[0] * s1r + F[1] * s1g + F[2] * s1b) + n * (F[0] * F[0] + F[1] * F[1] + F[2] * F[2]);
          err = totBg - sb + onErr;
        }
        if (err < bestErr - 1e-9) { bestErr = err; bestGlyph = g; bestColor = fg; }
      }
      const cell = cy * cols + cx;
      glyphOut[cell] = bestGlyph;
      colorOut[cell] = bestColor;
    }
  }
}

/** Synchronous version of the whole match (main thread). Returns { glyph, color, bg }. */
export function petsciiMatch(p) {
  const { cols, rows } = p;
  const bg = p.bg >= 0 && p.bg < p.palette.length ? p.bg : autoBackground(p.rgba, cols * 8, rows * 8, p.palette);
  const glyph = new Uint16Array(cols * rows);
  const color = new Uint8Array(cols * rows);
  matchRows(p, bg, 0, rows, glyph, color);
  return { glyph, color, bg };
}
