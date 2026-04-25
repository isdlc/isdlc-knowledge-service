// Deterministic embedding fake for integration / E2E tests.
// Traces: test-strategy.md §0.3, §15.3
//
// Produces a 384-dim float[] from a string by hashing characters with a small
// xorshift PRNG seeded by the FNV-1a hash of the input. Same text → same
// vector, character-by-character. Vectors are L2-normalised so cosine search
// against another normalised query vector is monotone in dot-product.
//
// Used by integration tests that exercise full pipelines without paying for
// real ONNX inference.

import { createHash } from 'node:crypto';

export const FAKE_DIMENSIONS = 384;
const MAX_INPUT_TOKENS = 512;

/**
 * Hash `s` to a 32-bit unsigned integer (FNV-1a).
 *
 * @param {string} s
 * @returns {number}
 */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic embed: hash text → seed PRNG → fill float[FAKE_DIMENSIONS].
 *
 * The vector is L2-normalised, so the cosine similarity between two outputs
 * is identical to the dot product. Real adapters do the same in production
 * (see ONNX adapter's L2-normalise step) so this matches the operational
 * geometry tests rely on.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function embedFake(text) {
  // Use SHA-256 for higher dispersion than xorshift on similar inputs.
  // Slice into chunks to feed FAKE_DIMENSIONS floats.
  const out = new Array(FAKE_DIMENSIONS);
  let pool = Buffer.alloc(0);
  let counter = 0;
  while (pool.length < FAKE_DIMENSIONS * 4) {
    const h = createHash('sha256');
    h.update(`${text}:${counter}`);
    pool = Buffer.concat([pool, h.digest()]);
    counter += 1;
  }
  // Map each 4-byte slot to a float in [-1, 1].
  for (let i = 0; i < FAKE_DIMENSIONS; i++) {
    const u = pool.readUInt32BE(i * 4);
    // 0..2^32-1 → -1..1
    out[i] = (u / 0xffffffff) * 2 - 1;
  }
  // L2-normalise.
  let norm = 0;
  for (let i = 0; i < FAKE_DIMENSIONS; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < FAKE_DIMENSIONS; i++) out[i] /= norm;
  return out;
}

/**
 * Construct a fake ModelAdapter that satisfies the contract used by the
 * pipeline, the worker, and the query engine:
 *   - embed(text) → number[]
 *   - batchEmbed(texts) → number[][]
 *   - getInfo() → { dimensions, max_input_tokens, name }
 *
 * The returned object exposes `calls` for assertions.
 */
export function createFakeModelAdapter(opts = {}) {
  const dims = opts.dimensions ?? FAKE_DIMENSIONS;
  const calls = { embed: 0, batchEmbed: 0 };
  return {
    name: 'fake-deterministic',
    embed: async (text) => {
      calls.embed += 1;
      // Honour the fixed dimension contract; truncate if the caller asked
      // for fewer dims (e.g. tests that simulate different model sizes).
      const v = embedFake(String(text ?? ''));
      return dims < FAKE_DIMENSIONS ? v.slice(0, dims) : v;
    },
    batchEmbed: async (texts) => {
      calls.batchEmbed += 1;
      const arr = Array.isArray(texts) ? texts : [];
      return arr.map((t) => {
        const v = embedFake(String(t ?? ''));
        return dims < FAKE_DIMENSIONS ? v.slice(0, dims) : v;
      });
    },
    getInfo: () => ({
      name: 'fake-deterministic',
      dimensions: dims,
      max_input_tokens: MAX_INPUT_TOKENS,
    }),
    calls,
  };
}
