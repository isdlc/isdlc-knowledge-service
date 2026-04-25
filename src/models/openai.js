// Module 7: OpenAI Cloud Adapter (T007)
// Traces: FR-009, AC-009-03, ERR-MODEL-002
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 7
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md (ERR-MODEL-002)
//
// Implements ModelAdapter (see src/models/index.js JSDoc):
//   embed(text) → number[]
//   batchEmbed(texts) → number[][]
//   getInfo() → ModelInfo { name, type:'cloud', provider:'openai', dimensions }
//
// Retry: 3 attempts with exponential backoff (100ms, 300ms, 900ms) on 429 / 5xx.
// After 3 failures, throws a ModelError with code 'ERR-MODEL-002' (cloud API error).
//
// Mocking seam (testability): the constructor accepts an optional `_clientFactory`
// option which, when provided, is used to construct the underlying client instead of
// `new OpenAI({...})`. The factory must return an object whose
// `embeddings.create({ model, input }) → { data: [{ embedding, index? }] }` matches
// the openai npm package.
//
// `_backoffMs` overrides the per-attempt sleep durations (used by tests for speed).

import { OpenAI } from 'openai';

import { ModelError, sleep, isRetryableHttp } from './_retry.js';

const MODEL_DIMENSIONS = Object.freeze({
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
});

const DEFAULT_BACKOFF_MS = [100, 300, 900];

export class OpenAiAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {keyof typeof MODEL_DIMENSIONS} opts.model
   * @param {string} [opts.organization]
   * @param {(args: { apiKey: string, organization?: string }) => any} [opts._clientFactory]
   * @param {number[]} [opts._backoffMs]
   */
  constructor(opts = {}) {
    const { apiKey, model, organization, _clientFactory, _backoffMs } = opts;

    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('OpenAiAdapter: apiKey is required');
    }
    if (!model || !(model in MODEL_DIMENSIONS)) {
      throw new Error(
        `OpenAiAdapter: unknown model '${model}'. Supported: ${Object.keys(MODEL_DIMENSIONS).join(', ')}`,
      );
    }

    this.model = model;
    this._dimensions = MODEL_DIMENSIONS[model];
    this._backoffMs = Array.isArray(_backoffMs) ? _backoffMs : DEFAULT_BACKOFF_MS;

    const factory =
      typeof _clientFactory === 'function'
        ? _clientFactory
        : ({ apiKey: k, organization: o }) => new OpenAI({ apiKey: k, organization: o });

    this._client = factory({ apiKey, organization });
  }

  async embed(text) {
    const result = await this._call({ input: text });
    return result.data[0].embedding;
  }

  async batchEmbed(texts) {
    const result = await this._call({ input: texts });
    // Provider may return out-of-order; reorder by `index` when present.
    const out = new Array(texts.length);
    for (const item of result.data) {
      const i = typeof item.index === 'number' ? item.index : out.indexOf(undefined);
      out[i] = item.embedding;
    }
    return out;
  }

  getInfo() {
    return {
      name: this.model,
      type: 'cloud',
      provider: 'openai',
      dimensions: this._dimensions,
    };
  }

  async _call({ input }) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this._client.embeddings.create({ model: this.model, input });
      } catch (err) {
        lastErr = err;
        if (!isRetryableHttp(err)) break;
        if (attempt < 2) await sleep(this._backoffMs[attempt] ?? 0);
      }
    }
    throw new ModelError({
      code: 'ERR-MODEL-002',
      provider: 'openai',
      cause: lastErr,
    });
  }
}
