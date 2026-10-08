# vendor/

Third-party ES modules, copied from their npm packages so the site has no runtime CDN dependency
(better privacy, strict CSP with `'self'`, works offline and in sandboxed test environments).

| Package | Version | License | Files | Local changes |
|---|---|---|---|---|
| [mediabunny](https://www.npmjs.com/package/mediabunny) | 1.59.1 | MPL-2.0 | `dist/bundles/mediabunny.min.mjs` | none |
| [d3-delaunay](https://www.npmjs.com/package/d3-delaunay) | 6.0.4 | ISC | `src/*.js` | `delaunay.js`: bare import `"delaunator"` → relative path |
| [delaunator](https://www.npmjs.com/package/delaunator) | 5.1.0 | ISC | `index.js` | bare import `'robust-predicates'` → relative path |
| [robust-predicates](https://www.npmjs.com/package/robust-predicates) | 3.0.3 | Unlicense | `index.js`, `esm/*.js` | none |

Bare specifiers were rewritten to relative paths because module workers don't support import maps,
and `heavy.worker.js` needs `d3-delaunay`.

Import them with relative paths, for example:

```js
import { Delaunay } from '../../vendor/d3-delaunay/6.0.4/index.js';
const mb = await import('../../vendor/mediabunny/1.59.1/mediabunny.min.mjs');
```

To update a package, download the new tarball from the npm registry, replace its folder (the version is part of the path),
repeat the edits listed above, and update this table.

`@huggingface/transformers` is **not** vendored, because it's large and pulls ONNX Runtime WASM files.
It's loaded on demand from jsDelivr inside `src/workers/depth.worker.js`, and only when the user clicks "Mejorar con IA".
