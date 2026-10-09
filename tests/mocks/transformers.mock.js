// Test double of @huggingface/transformers 4.3.0 for the REAL src/workers/depth.worker.js (loaded through its
// same-origin `libUrl` override). It mimics the parts the worker uses, with the shapes of the 4.x package:
// pipeline('depth-estimation', model, { device, dtype, progress_callback }) and a result
// { predicted_depth: Tensor { dims: [H, W], data: Float32Array }, depth: RawImage (uint8, 1 channel) }.
// It refuses any other task / model / device, so a wrong call in the worker fails the test.
export const env = { allowLocalModels: true };

export class RawImage {
  constructor(data, width, height, channels) {
    if (!(data instanceof Uint8ClampedArray || data instanceof Uint8Array)) throw new Error('RawImage: bad data');
    if (data.length !== width * height * channels) throw new Error('RawImage: size mismatch');
    Object.assign(this, { data, width, height, channels });
  }
}

export async function pipeline(task, model, opts = {}) {
  if (task !== 'depth-estimation') throw new Error(`mock: unexpected task ${task}`);
  if (model !== 'onnx-community/depth-anything-v2-small') throw new Error(`mock: unexpected model ${model}`);
  if (!['wasm', 'webgpu'].includes(opts.device)) throw new Error(`mock: unexpected device ${opts.device}`);
  if (typeof opts.progress_callback !== 'function') throw new Error('mock: no progress callback');
  for (const p of [0, 40, 100]) opts.progress_callback({ status: 'progress_total', name: model, progress: p, loaded: p * 1e5, total: 1e7, files: {} });
  opts.progress_callback({ status: 'ready', task, model });
  return async (image) => {
    if (!(image instanceof RawImage) || image.channels !== 4) throw new Error('mock: expected an RGBA RawImage');
    const { width: w, height: h } = image;
    // inverse depth grows towards the bottom of the picture (raw values 2..5)
    const data = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = 2 + 3 * (y / Math.max(1, h - 1));
    return {
      predicted_depth: { dims: [h, w], type: 'float32', data, size: w * h },
      depth: new RawImage(new Uint8Array(w * h), w, h, 1),
    };
  };
}
