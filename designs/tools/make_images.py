#!/usr/bin/env python3
"""Generate the treated images used by the design mockups in designs/.

Usage (from the repo root):  python designs/tools/make_images.py
Needs Pillow + numpy. Writes WebP files (max 1200 px) to designs/img/.
Effects: Floyd-Steinberg / Bayer dithering, halftone dots, engraved line
screens, film grain and duotone gradient maps.
"""
import os, sys
import numpy as np
from PIL import Image, ImageFilter, ImageOps

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'designs', 'img')
SRC = os.path.join(ROOT, 'assets', 'source')
os.makedirs(OUT, exist_ok=True)


def hexrgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def load(name, w, crop=None):
    im = Image.open(os.path.join(SRC, name)).convert('RGB')
    if crop:  # crop = (x0, y0, x1, y1) as fractions
        W, H = im.size
        im = im.crop((int(crop[0] * W), int(crop[1] * H), int(crop[2] * W), int(crop[3] * H)))
    w = min(w, 1200)
    h = round(im.height * w / im.width)
    if h > 1200:
        h = 1200; w = round(im.width * h / im.height)
    return im.resize((w, h), Image.LANCZOS)


def gray(im, contrast=1.0, gamma=1.0, autocontrast=True):
    g = ImageOps.grayscale(im)
    if autocontrast:
        g = ImageOps.autocontrast(g, cutoff=1)
    a = np.asarray(g, dtype=np.float32) / 255.0
    a = np.clip((a - 0.5) * contrast + 0.5, 0, 1) ** gamma
    return a


def mask_white(im, thr=232, grow=3):
    """1 where the painting is, 0 on the white paper background."""
    a = np.asarray(im, dtype=np.uint8).min(axis=2)
    m = Image.fromarray(((a < thr) * 255).astype(np.uint8))
    m = m.filter(ImageFilter.MaxFilter(grow)).filter(ImageFilter.MinFilter(grow))
    m = m.filter(ImageFilter.GaussianBlur(1.2))
    return np.asarray(m, dtype=np.float32) / 255.0


def ramp(g, colors):
    """Gradient map: g in [0,1] (0 = dark) -> RGB along the colour list."""
    cols = np.array([hexrgb(c) for c in colors], dtype=np.float32)
    n = len(cols) - 1
    x = np.clip(g, 0, 1) * n
    i = np.clip(np.floor(x).astype(int), 0, n - 1)
    f = (x - i)[..., None]
    return cols[i] * (1 - f) + cols[i + 1] * f


def to_img(rgb):
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), 'RGB')


def fs(g, colors):
    """Floyd-Steinberg dither of a tone map onto a fixed palette."""
    pal = Image.new('P', (1, 1))
    flat = []
    for c in colors:
        flat += list(hexrgb(c))
    pal.putpalette(flat + flat[:3] * (256 - len(colors)))
    rgb = to_img(ramp(g, colors))
    return rgb.quantize(palette=pal, dither=Image.Dither.FLOYDSTEINBERG).convert('RGB')


def bayer_matrix(n):
    m = np.array([[0]])
    while m.shape[0] < n:
        m = np.block([[4 * m, 4 * m + 2], [4 * m + 3, 4 * m + 1]])
    return (m + 0.5) / m.size


def bayer(g, colors, n=4, px=1):
    if px > 1:
        H, W = g.shape
        g = np.asarray(Image.fromarray((g * 255).astype(np.uint8)).resize((W // px, H // px), Image.BILINEAR), np.float32) / 255
    k = len(colors) - 1
    H, W = g.shape
    t = np.tile(bayer_matrix(n), (H // n + 1, W // n + 1))[:H, :W]
    idx = np.clip(np.floor(g * k + t), 0, k).astype(int)
    cols = np.array([hexrgb(c) for c in colors], np.uint8)
    im = Image.fromarray(cols[idx], 'RGB')
    if px > 1:
        im = im.resize((W * px, H * px), Image.NEAREST)
    return im


def _blur(g, r):
    return np.asarray(Image.fromarray((g * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r)), np.float32) / 255


def _upsample(a, s):
    H, W = a.shape
    return np.asarray(Image.fromarray((a * 255).astype(np.uint8)).resize((W * s, H * s), Image.BICUBIC), np.float32) / 255


def composite(ink_cov, ink, paper, s):
    """ink_cov: supersampled coverage (1 = ink). Downsample for antialiasing."""
    cov = Image.fromarray((np.clip(ink_cov, 0, 1) * 255).astype(np.uint8))
    H, W = ink_cov.shape
    cov = np.asarray(cov.resize((W // s, H // s), Image.BOX), np.float32)[..., None] / 255
    a, b = np.array(hexrgb(ink), np.float32), np.array(hexrgb(paper), np.float32)
    return to_img(b * (1 - cov) + a * cov)


def halftone(g, cell=8, angle=45, ink='#000', paper='#fff', s=3, gain=1.0):
    """Classic AM halftone: dot area follows darkness (1 - g)."""
    dark = 1 - _blur(g, cell * 0.35)
    H, W = g.shape
    S = cell * s
    yy, xx = np.mgrid[0:H * s, 0:W * s].astype(np.float32)
    th = np.deg2rad(angle)
    c, sn = np.cos(th), np.sin(th)
    u = xx * c + yy * sn
    v = -xx * sn + yy * c
    uc = (np.floor(u / S) + 0.5) * S
    vc = (np.floor(v / S) + 0.5) * S
    cx = uc * c - vc * sn
    cy = uc * sn + vc * c
    ix = np.clip((cx / s).astype(int), 0, W - 1)
    iy = np.clip((cy / s).astype(int), 0, H - 1)
    d = np.clip(dark[iy, ix] * gain, 0, 1)
    r = np.sqrt(d) * S * 0.6
    dist = np.hypot(u - uc, v - vc)
    cov = np.clip(r - dist + 0.5, 0, 1)
    return composite(cov, ink, paper, s)


def lines(g, period=6, angle=0, wave=0.0, ink='#000', paper='#fff', s=3, gain=1.0, mask=None):
    """Engraved line screen: line thickness follows darkness and the lines
    bend with the tone (wave) like a copper-plate engraving."""
    H, W = g.shape
    dark = np.clip((1 - g) * gain, 0, 1)
    if mask is not None:
        dark = dark * mask
    darkS = _upsample(dark, s)
    tone = _upsample(_blur(g, period * 1.5), s)
    yy, xx = np.mgrid[0:H * s, 0:W * s].astype(np.float32)
    th = np.deg2rad(angle)
    v = (-xx * np.sin(th) + yy * np.cos(th)) / (period * s)
    v = v + wave * tone
    f = np.abs((v % 1.0) - 0.5) * 2  # 0 at line centre .. 1 between lines
    half = darkS * 0.95
    px = 1.0 / (period * s) * 2
    cov = np.clip((half - f) / px + 0.5, 0, 1)
    return composite(cov, ink, paper, s)


def grain(g, sigma=0.16, seed=1, levels=('#0b0b0b', '#f2f0ea')):
    rng = np.random.default_rng(seed)
    n = rng.normal(0, sigma, g.shape).astype(np.float32)
    n = _blur(np.clip(n + 0.5, 0, 1), 0.6) - 0.5
    return fs(np.clip(g + n, 0, 1), list(levels))


def save(im, name, lossless=False, q=82):
    p = os.path.join(OUT, name + '.webp')
    if lossless:
        im.save(p, 'WEBP', lossless=True, quality=100, method=5)
    else:
        im.save(p, 'WEBP', quality=q, method=5)
    print(f'{name:28s} {im.size[0]}x{im.size[1]} {os.path.getsize(p) // 1024} KB')


C = 'clean/'
BLUE = '#1E1EFF'

JOBS = []
def job(f):
    JOBS.append(f); return f


@job
def hermes():
    # hero: the full harbour painting as blue engraved lines on black (light = ink)
    im = load('puerto-pescadores.webp', 1200)
    g = gray(im, 1.2)
    save(lines(1 - g ** 0.8, period=5, wave=0.55, ink=BLUE, paper='#000000', gain=1.1), 'h-hero', q=78)
    for src, name in [('herrero.webp', 'h-herrero'), ('labradores.webp', 'h-labradores'), ('campesinos.webp', 'h-campesinos')]:
        im = load(C + src, 760)
        m = mask_white(im)
        g = gray(im, 1.1)
        # white engraving on electric blue: light parts of the figure become white lines
        # white engraving on electric blue: the lit parts of the figure become white lines
        lit = np.clip(g, 0, 1) ** 0.7 * m
        save(lines(1 - lit, period=4.5, wave=0.45, ink='#FFFFFF', paper=BLUE, gain=1.15), name, q=80)
    im = load(C + 'remeros.webp', 700)
    m = mask_white(im)
    lit = np.clip(gray(im, 1.15), 0, 1) ** 0.75 * m
    save(halftone(1 - lit, cell=6, angle=45, ink=BLUE, paper='#000000', gain=1.2), 'h-remeros', q=80)


@job
def lowtech():
    pal = {
        'lt-campesinos': (C + 'campesinos.webp', ['#1f1b16', '#8c6f4f', '#e3d6bd', '#f4efe3']),
        'lt-puerto': (C + 'puerto.webp', ['#1f1b16', '#5a6b73', '#c9c3b2', '#f4efe3']),
        'lt-herrero': (C + 'herrero.webp', ['#1f1b16', '#7b4a3a', '#d7c6ae', '#f4efe3']),
        'lt-pescado': ('pescado.webp', ['#1f1b16', '#b0553a', '#e0c9a8', '#f4efe3']),
        'lt-labradores': (C + 'labradores.webp', ['#1f1b16', '#6f7a4c', '#d8d3b6', '#f4efe3']),
    }
    for name, (src, cols) in pal.items():
        im = load(src, 720)
        save(fs(gray(im, 1.25, 1.1), cols), name, lossless=True)


@job
def poolsuite():
    pastel = ['#2b2a4c', '#e86a92', '#f7a072', '#9ad1c9', '#fbe7c6', '#fffdf6']
    for name, src, w in [('ps-remeros', C + 'remeros.webp', 520), ('ps-puerto', C + 'puerto.webp', 640),
                         ('ps-pescado', 'pescado.webp', 560), ('ps-labradores', C + 'labradores.webp', 560),
                         ('ps-herrero', C + 'herrero.webp', 520)]:
        im = load(src, w)
        save(bayer(gray(im, 1.2), pastel, n=4, px=2), name, lossless=True)


@job
def gallery():
    save(halftone(gray(load(C + 'campesinos.webp', 800), 1.0, 0.6), cell=9, angle=15, ink='#ff2d1a', paper='#f5f1e8'), 'g-campesinos', q=80)
    save(bayer(gray(load(C + 'herrero.webp', 720), 1.3), ['#000000', '#c6ff00'], n=8), 'g-herrero', lossless=True)
    save(lines(gray(load('remeros.webp', 640), 1.2), period=5, angle=-30, wave=0.3, ink='#000000', paper='#f5f1e8'), 'g-remeros', q=70)
    save(fs(gray(load('labradores.webp', 760), 1.2), ['#000000', '#ffffff']), 'g-labradores', lossless=True)
    save(halftone(gray(load('pescado.webp', 700), 1.2), cell=7, angle=45, ink='#0a0a0a', paper='#ff4fd8'), 'g-pescado', q=65)
    save(lines(gray(load(C + 'puerto.webp', 820), 1.2), period=6, angle=90, wave=0.8, ink='#111111', paper='#ffe600'), 'g-puerto', q=80)
    save(bayer(gray(load(C + 'labradores.webp', 720), 1.2), ['#101010', '#2d5bff', '#f5f1e8'], n=4, px=2), 'g-labradores-clean', lossless=True)
    for n in ['herrero-rings', 'labrador-halftone', 'pescado-dither', 'puerto-hatch', 'remeros-lines']:
        im = Image.open(os.path.join(ROOT, 'assets', 'landing', n + '-800.webp')).convert('RGB')
        save(im, 'land-' + n, q=80)


@job
def aquirin():
    im = load('puerto-pescadores.webp', 1200)
    save(halftone(gray(im, 1.1), cell=6, angle=30, ink='#2a2724', paper='#ece7df'), 'a-hero', q=62)
    stone = ['#22201d', '#6e665c', '#bdb4a6', '#efebe4']
    for i, src in enumerate(['campesinos.webp', 'herrero.webp', 'labradores.webp', 'puerto.webp', 'remeros.webp']):
        im = load(C + src, 640)
        save(fs(gray(im, 1.2, 1.05), stone), f'a-acc-{i + 1}', lossless=True)
    im = load('puerto-pescadores.webp', 1100)
    save(im, 'a-compare-original', q=82)
    save(fs(gray(im, 1.2), ['#1d1b19', '#7d5b46', '#c9a77f', '#efe8dc']), 'a-compare-dither', lossless=True)
    save(lines(gray(load('herrero.webp', 900), 1.15), period=5, angle=0, wave=0.5, ink='#2a2724', paper='#ece7df'), 'a-work-herrero', q=80)
    save(bayer(gray(load('pescado.webp', 900), 1.2), ['#2a2724', '#a79c8c', '#ece7df'], n=8), 'a-work-pescado', lossless=True)


@job
def jeenyuhs():
    items = [('j-herrero', 'herrero.webp', 1200, None), ('j-labradores', 'labradores.webp', 1200, None),
             ('j-pescado', 'pescado.webp', 1000, None), ('j-remeros', 'remeros.webp', 900, None),
             ('j-puerto', 'puerto-pescadores.webp', 1200, None)]
    for name, src, w, crop in items:
        im = load(src, w, crop)
        save(grain(gray(im, 1.35, 1.05), 0.12), name, lossless=True)
    crops = [('herrero.webp', (0.05, 0.1, 0.55, 0.6)), ('labradores.webp', (0.3, 0.05, 0.8, 0.7)),
             ('pescado.webp', (0.0, 0.0, 0.6, 0.6)), ('remeros.webp', (0.1, 0.05, 0.9, 0.5)),
             ('puerto-pescadores.webp', (0.45, 0.1, 1.0, 0.75)), ('pescado.webp', (0.4, 0.45, 1.0, 1.0)),
             ('herrero.webp', (0.5, 0.2, 1.0, 0.8))]
    for i, (src, crop) in enumerate(crops):
        im = load(src, 360, crop)
        save(grain(gray(im, 1.4), 0.1, seed=i), f'j-frame-{i + 1}', lossless=True)


@job
def schemas():
    save(lines(gray(load('puerto-pescadores.webp', 1000), 1.1), period=4, angle=0, wave=0.9, ink='#13204a', paper='#f6f5f0'), 's-puerto', q=80)
    save(halftone(gray(load(C + 'herrero.webp', 700), 1.2), cell=7, angle=0, ink='#13204a', paper='#f6f5f0'), 's-herrero', q=80)
    save(bayer(gray(load('labradores.webp', 700), 1.2), ['#13204a', '#f6f5f0'], n=8), 's-labradores', lossless=True)
    save(lines(gray(load(C + 'remeros.webp', 560), 1.2), period=4, angle=90, wave=0.3, ink='#13204a', paper='#f6f5f0'), 's-remeros', q=80)
    save(fs(gray(load('pescado.webp', 600), 1.2), ['#13204a', '#e4572e', '#f6f5f0']), 's-pescado', lossless=True)


if __name__ == '__main__':
    only = set(sys.argv[1:])
    for f in JOBS:
        if not only or f.__name__ in only:
            f()
