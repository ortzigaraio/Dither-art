// Generates the test fixtures (nothing licensed is committed). Run by global-setup.mjs when missing,
// or by hand: `node make-fixtures.mjs`. Output goes to tests/fixtures/ (gitignored).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, existsSync, readFile } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const fixturesDir = resolve(here, 'fixtures');
export const fixtureExists = (name) => existsSync(resolve(fixturesDir, name));

/** fixture.png: gradients + shapes + text, 800x600, deterministic. */
async function makeImage(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 600;
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, 800, 600);
    bg.addColorStop(0, '#0b1d3a');
    bg.addColorStop(0.5, '#c4f169');
    bg.addColorStop(1, '#ff6b5a');
    g.fillStyle = bg;
    g.fillRect(0, 0, 800, 600);

    const rad = g.createRadialGradient(300, 260, 10, 300, 300, 190);
    rad.addColorStop(0, '#ffffff');
    rad.addColorStop(0.5, '#4a6cf7');
    rad.addColorStop(1, '#0a0f2a');
    g.fillStyle = rad;
    g.beginPath();
    g.arc(300, 300, 190, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = '#111111';
    g.fillRect(520, 90, 200, 150);
    g.fillStyle = '#f7f8fa';
    g.beginPath();
    g.moveTo(560, 400);
    g.lineTo(700, 560);
    g.lineTo(520, 560);
    g.closePath();
    g.fill();

    g.strokeStyle = '#ffffff';
    g.lineWidth = 6;
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.moveTo(40 + i * 28, 20);
      g.lineTo(120 + i * 28, 140);
      g.stroke();
    }

    g.fillStyle = '#ffffff';
    g.font = '700 84px sans-serif';
    g.textBaseline = 'alphabetic';
    g.fillText('HORAIN', 70, 560);
    g.fillStyle = '#000000';
    g.font = '700 40px monospace';
    g.fillText('ASCII 0123', 480, 330);
    return c.toDataURL('image/png');
  });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

const repoRoot = resolve(here, '..');

/** Tiny static server for the repo root: the video fixture needs ES modules from vendor/ (file:// cannot import them).
 *  Also used by make-og-image.mjs and make-screenshots.mjs, which load the whole app. */
export function serveRepo() {
  const types = {
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  };
  const server = createServer((req, res) => {
    const rel0 = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = rel0.endsWith('/') ? `${rel0}index.html` : rel0;
    const file = resolve(repoRoot, '.' + rel);
    if (!file.startsWith(repoRoot)) { res.writeHead(403); res.end(); return; }
    readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const ext = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

/**
 * fixture.webm: 3 s, 320x240, 15 fps, VP9 (VP8 as a fallback) + a 440 Hz Opus tone, written with Mediabunny
 * (CanvasSource + AudioBufferSource) inside a page. The picture moves every frame so scrubbing is observable.
 */
async function makeVideo(page) {
  const b64 = await page.evaluate(async () => {
    const mb = await import('/vendor/mediabunny/1.59.1/mediabunny.min.mjs');
    const W = 320, H = 240, FPS = 15, SECONDS = 3, RATE = 48000;
    const vcodec = (await mb.canEncodeVideo('vp9', { width: W, height: H })) ? 'vp9' : 'vp8';
    const output = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    const video = new mb.CanvasSource(canvas, { codec: vcodec, bitrate: mb.QUALITY_HIGH });
    const audio = new mb.AudioBufferSource({ codec: 'opus', bitrate: 64000 });
    output.addVideoTrack(video, { frameRate: FPS });
    output.addAudioTrack(audio);
    await output.start();
    // 440 Hz tone, mono
    const tone = new AudioBuffer({ length: RATE * SECONDS, sampleRate: RATE, numberOfChannels: 1 });
    const ch = tone.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / RATE);
    await audio.add(tone);
    for (let i = 0; i < FPS * SECONDS; i++) {
      const t = i / FPS;
      const bg = g.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, '#0b1d3a');
      bg.addColorStop(1, '#c4f169');
      g.fillStyle = bg;
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(40 + (W - 80) * (t / SECONDS), H / 2 + Math.sin(t * 5) * 60, 34, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#111111';
      g.fillRect(20, 20 + i * 2, 90, 40);
      await video.add(t, 1 / FPS);
    }
    await output.finalize();
    const bytes = new Uint8Array(output.target.buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return Buffer.from(b64, 'base64');
}

export async function makeFixtures() {
  mkdirSync(fixturesDir, { recursive: true });
  const server = await serveRepo();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/tests/blank.html`);
    if (!fixtureExists('fixture.png')) writeFileSync(resolve(fixturesDir, 'fixture.png'), await makeImage(page));
    if (!fixtureExists('fixture.webm')) writeFileSync(resolve(fixturesDir, 'fixture.webm'), await makeVideo(page));
  } finally {
    await browser.close();
    server.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await makeFixtures();
  console.log('fixtures written to', fixturesDir);
}

