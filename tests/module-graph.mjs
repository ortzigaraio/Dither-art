// Static ES-module graph of the app (src/main.js and everything it imports with a static `import ... from`).
// Used by make-preload.mjs to write the <link rel="modulepreload"> block of index.html, and by perf.spec.js to check
// that the block still matches the code. Dynamic `import()` calls are not followed: they are lazy on purpose.
import { readFileSync } from 'node:fs';
import { dirname, resolve, relative, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const STATIC_RE = /(?:^|[;\n}])\s*(?:import|export)\s+(?:[\w*{}\s,$]+?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g;

/** Repo-relative paths ('src/...') of the static graph from `entry`, breadth-first (shallow modules first). */
export function staticGraph(entry = 'src/main.js') {
  const order = [];
  const seen = new Set();
  const queue = [resolve(repoRoot, entry)];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    order.push(relative(repoRoot, file).split(sep).join(posix.sep));
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(STATIC_RE)) queue.push(resolve(dirname(file), m[1]));
  }
  return order;
}
