#!/usr/bin/env python3
"""Builds assets/sample/gran-ola-sheet.webp: the demo clip of the hero (black-and-white Great Wave, animated).

The source is Hokusai's The Great Wave off Kanagawa (public domain). The picture is turned into grayscale and only
the water is moved, as a displacement field that is periodic in time, so the loop has no seam:
  - a travelling swell (the whole sea rises and falls, with the phase running along x),
  - flow along the print's own lines (the blue stripes slide along their length, as water streams down a wave),
  - the crest claws reach forward and fall back,
  - a light jitter of the spray.
Sky, label, Mount Fuji and the horizon stay still.

Usage: tools/make_demo_wave.py SOURCE.jpg OUT.webp [--preview-dir DIR]
Needs numpy, scipy, scikit-image and Pillow (not shipped, only used to produce the asset).
"""
import argparse, math
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

FRAMES, COLS, FPS = 36, 6, 12
W, H = 480, 326  # output frame size; the sheet is COLS x ceil(FRAMES / COLS) frames

def smooth_noise(shape, sigma, rng):
    n = ndi.gaussian_filter(rng.standard_normal(shape), sigma)
    return n / (np.abs(n).max() + 1e-9)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('out'); ap.add_argument('--preview-dir')
    a = ap.parse_args()
    rgb = np.asarray(Image.open(a.src).convert('RGB')).astype(np.float32)
    h, w, _ = rgb.shape
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]

    # ---- grayscale with a little ink contrast (blues go deep, foam and paper stay light)
    gray = 0.299 * r + 0.587 * g + 0.114 * b
    lo, hi = np.percentile(gray, [1, 99.5])
    gray = np.clip((gray - lo) / (hi - lo), 0, 1)
    gray = gray ** 1.15
    gray = ndi.gaussian_filter(gray, 0.4)

    # ---- masks: sky/paper is warm (red above blue) and light; water is everything else
    sky = ((r - b) > 14) & (r > 165)
    sky = ndi.binary_opening(sky, iterations=2)
    sky = ndi.binary_closing(sky, iterations=3)
    lab, n = ndi.label(sky)
    keep = np.zeros_like(sky)
    for i in range(1, n + 1):  # keep sky regions that touch the top or the right edge, or are big
        m = lab == i
        if m.sum() > 0.01 * h * w or m[0].any() or m[:, -1].any():
            keep |= m
    water = ~keep
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    # Mount Fuji, its snow and the little boat beside it: nearly still (they sit far away)
    far = np.exp(-(((xx - 0.645 * w) / (0.10 * w)) ** 2 + ((yy - 0.69 * h) / (0.07 * h)) ** 2))
    # the title label and the signature at the top left never move
    label = np.zeros((h, w), np.float32)
    label[int(0.02 * h):int(0.37 * h), :int(0.115 * w)] = 1
    wt = ndi.gaussian_filter(water.astype(np.float32), 3.0) * (1 - 0.85 * far) * (1 - ndi.gaussian_filter(label, 2.0))

    # ---- orientation of the print's lines (structure tensor): displacement runs along them
    gx = ndi.sobel(ndi.gaussian_filter(gray, 1.2), axis=1)
    gy = ndi.sobel(ndi.gaussian_filter(gray, 1.2), axis=0)
    jxx, jyy, jxy = (ndi.gaussian_filter(v, 5) for v in (gx * gx, gy * gy, gx * gy))
    theta = 0.5 * np.arctan2(2 * jxy, jxx - jyy)          # dominant gradient direction
    tx, ty = -np.sin(theta), np.cos(theta)                  # tangent (along the lines)
    flip = tx < 0                                           # keep the flow pointing right/down overall
    tx, ty = np.where(flip, -tx, tx), np.where(flip, -ty, ty)
    coh = np.sqrt((jxx - jyy) ** 2 + 4 * jxy ** 2) / (jxx + jyy + 1e-6)  # how line-like each place is
    coh = np.clip(coh * 1.4, 0, 1)

    rng = np.random.default_rng(7)
    ph_noise = smooth_noise((h, w), 28, rng) * 2.4          # breaks the flow into drifting bands
    ph_noise2 = smooth_noise((h, w), 12, rng) * 3.0
    spray_a, spray_b = smooth_noise((h, w), 3.2, rng), smooth_noise((h, w), 3.2, rng)
    # the crest claws live up and to the right of the big wave
    crest = np.exp(-(((xx - 0.43 * w) / (0.17 * w)) ** 2 + ((yy - 0.24 * h) / (0.18 * h)) ** 2))
    curl_noise = 0.5 + 0.5 * smooth_noise((h, w), 6, rng)

    frames = []
    for k in range(FRAMES):
        t = 2 * math.pi * k / FRAMES
        # 1. swell: the sea rises and falls, phase travelling along x and y
        dy = 4.2 * np.sin(t - xx / w * 5.0 - yy / h * 2.0)
        dx = 2.2 * np.sin(t - xx / w * 4.0 + 1.3)
        # 2. flow along the lines
        flow = 5.5 * coh * np.sin(t + (xx * 0.021 + yy * 0.013) + ph_noise)
        flow += 2.5 * coh * np.sin(2 * t + ph_noise2)
        dx += flow * tx
        dy += flow * ty
        # 3. crest claws reach forward (right, down) and fall back
        reach = crest * (0.5 + 0.5 * np.sin(t - 0.8)) * (0.4 + 0.9 * curl_noise)
        dx += 9.0 * reach
        dy += 5.0 * reach
        # 4. spray jitter: every point loops around its own small circle
        dx += 1.6 * spray_a * np.sin(t + 3 * spray_b) * (0.5 + gray)
        dy += 1.6 * spray_b * np.cos(t + 3 * spray_a) * (0.5 + gray)
        # sample
        sx = xx - dx * wt
        sy = yy - dy * wt
        out = ndi.map_coordinates(gray, [sy, sx], order=1, mode='reflect')
        frames.append(out)

    im_frames = []
    for f in frames:
        im = Image.fromarray((np.clip(f, 0, 1) * 255).astype(np.uint8), 'L').resize((W, H), Image.LANCZOS)
        im_frames.append(im)

    rows = math.ceil(FRAMES / COLS)
    sheet = Image.new('L', (COLS * W, rows * H), 255)
    for i, im in enumerate(im_frames):
        sheet.paste(im, ((i % COLS) * W, (i // COLS) * H))
    sheet.save(a.out, 'WEBP', quality=82, method=6)
    if a.preview_dir:
        import os
        os.makedirs(a.preview_dir, exist_ok=True)
        for i in (0, 9, 18, 27):
            im_frames[i].save(os.path.join(a.preview_dir, f'f{i:02d}.png'))
        diff = np.abs(np.asarray(im_frames[0], np.float32) - np.asarray(im_frames[18], np.float32))
        Image.fromarray(np.clip(diff * 3, 0, 255).astype(np.uint8)).save(os.path.join(a.preview_dir, 'diff0-18.png'))
        Image.fromarray((np.clip(wt, 0, 1) * 255).astype(np.uint8)).resize((W, H)).save(os.path.join(a.preview_dir, 'mask.png'))
    first, last = np.asarray(im_frames[0], np.float32), np.asarray(im_frames[-1], np.float32)
    print('sheet', sheet.size, 'frames', FRAMES, 'mean |f0-f18|', float(np.abs(first - np.asarray(im_frames[18], np.float32)).mean()),
          'mean |f35-f0| (loop seam)', float(np.abs(last - first).mean()))

if __name__ == '__main__':
    main()
