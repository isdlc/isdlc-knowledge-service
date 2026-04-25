// Module 9: Shared transient-error retry helper for cloud vector DB adapters.
// Traces: FR-009
// See: docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-VDB-001
//
// Used by opensearch.js, pinecone.js, qdrant-cloud.js, weaviate-cloud.js,
// milvus-cloud.js. Three attempts, exponential backoff (100/300/900 ms).
// Auth failures (401/403) are NOT transient and should be raised after a
// single attempt — callers wrap these specifically before throwing.

export const RETRY_DELAYS_MS = [100, 300, 900];

/**
 * Heuristic: is `err` a transient network/5xx error worth retrying?
 * Auth failures (401/403) are explicitly NOT transient.
 */
export function isTransient(err) {
  if (!err) return false;
  const status = err.statusCode || err.status || err.meta?.statusCode || err.response?.status;
  if (status === 401 || status === 403) return false;
  if (status === 408 || status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  const code = err.code || '';
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE'
  ) {
    return true;
  }
  const msg = (err.message || '').toLowerCase();
  if (/timeout|timed out|network|socket hang up|unreachable/.test(msg)) return true;
  return false;
}

/**
 * Retry an async operation up to 3 attempts on transient errors.
 *
 * @template T
 * @param {() => Promise<T>} op
 * @param {{ delays?: number[], sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<T>}
 */
export async function retry(op, opts = {}) {
  const delays = opts.delays || RETRY_DELAYS_MS;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === delays.length - 1) {
        throw err;
      }
      await sleep(delays[attempt]);
    }
  }
  throw lastErr;
}
