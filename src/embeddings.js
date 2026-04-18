import { pipeline, env } from '@huggingface/transformers';
import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';

try {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.ort = null;
} catch {}

let modelCache = null;

async function getModel() {
  if (modelCache) return modelCache;
  console.error('[bundag] loading embeddings model (first run downloads ~90MB)...');
  modelCache = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return modelCache;
}

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

function keyFor(text) {
  return createHash('sha256').update(MODEL_ID).update('\0').update(text.normalize('NFC')).digest('hex');
}

const cache = new LRUCache({
  max: 5000,
  fetchMethod: async (_key, _stale, { context }) => {
    const model = await getModel();
    const out = await model([context.text], { pooling: 'mean', normalize: true });
    const [bs, d] = out.dims;
    return Array.from(out.data).slice(0, d);
  },
});

export async function embed(texts) {
  if (!Array.isArray(texts)) texts = [texts];
  if (!texts.length) return [];
  const clean = texts.map(t => (t || '').replace(/\n/g, ' ').slice(0, 8000));
  return Promise.all(clean.map(text => cache.fetch(keyFor(text), { context: { text } })));
}

export async function embedOne(text) {
  const [v] = await embed([text]);
  return v;
}

export const EMBED_DIM = 384;
