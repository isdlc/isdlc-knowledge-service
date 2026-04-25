// Module 7: Cohere Cloud Adapter (T007)
// Traces: FR-009, AC-009-03, ERR-MODEL-002
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 7
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md (ERR-MODEL-002)
//
// Implements ModelAdapter (see src/models/index.js JSDoc).
// Retry: 3 attempts with exponential backoff (100ms, 300ms, 900ms) on 429 / 5xx.
// After 3 failures, throws a ModelError with code 'ERR-MODEL-002'.
//
// Mocking seam: `_clientFactory({ apiKey })` returns a client whose
// `embed({ texts, model, inputType }) → { embeddings: float[][] }` matches the
// `cohere-ai` v7 SDK CohereClient. Tests inject a stub.

import { CohereClient } from 'cohere-ai';

import { ModelError, sleep, isRetryableHttp } from './_retry.js';

// Both v3 English and Multilingual return 1024-dim embeddings.
const MODEL_DIMENSIONS = Object.freeze({
  'embed-english-v3.0': 1024,
  'embed-multilingual-v3.0': 1024,
});

const DEFAULT_BACKOFF_MS = [100, 300, 900];

export class CohereAdapter {
  constructor(opts = {}) {
    const { apiKey, model, _clientFactory, _backoffMs } = opts;

    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('CohereAdapter: apiKey is required');
    }
    if (!model || !(model in MODEL_DIMENSIONS)) {
      throw new Error(
        `CohereAdapter: unknown model '${model}'. Supported: ${Object.keys(MODEL_DIMENSIONS).join(', ')}`,
      );
    }

    this.model = model;
    this._dimensions = MODEL_DIMENSIONS[model];
    this._backoffMs = Array.isArray(_backoffMs) ? _backoffMs : DEFAULT_BACKOFF_MS;

    const factory =
      typeof _clientFactory === 'function'
        ? _clientFactory
        : ({ apiKey: k }) => new CohereClient({ token: k });

    this._client = factory({ apiKey });
  }

  async embed(text) {
    const out = await this.batchEmbed([text]);
    return out[0];
  }

  async batchEmbed(texts) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await this._client.embed({
          texts,
          model: this.model,
          inputType: 'search_document',
        });
        return result.embeddings;
      } catch (err) {
        lastErr = err;
        if (!isRetryableHttp(err)) break;
        if (attempt < 2) await sleep(this._backoffMs[attempt] ?? 0);
      }
    }
    throw new ModelError({
      code: 'ERR-MODEL-002',
      provider: 'cohere',
      cause: lastErr,
    });
  }

  getInfo() {
    return {
      name: this.model,
      type: 'cloud',
      provider: 'cohere',
      dimensions: this._dimensions,
    };
  }
}
