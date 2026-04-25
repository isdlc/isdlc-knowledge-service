// Module 7: Amazon Bedrock Cloud Adapter (T007)
// Traces: FR-009, AC-009-03, ERR-MODEL-002
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 7
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md (ERR-MODEL-002)
//
// Implements ModelAdapter (see src/models/index.js JSDoc).
// Retry: 3 attempts with exponential backoff (100ms, 300ms, 900ms) on
// ThrottlingException / 429 / 5xx. After 3 failures, throws a ModelError with
// code 'ERR-MODEL-002'.
//
// Bedrock has no native batch embedding endpoint — batchEmbed dispatches one
// InvokeModelCommand per input.
//
// Body shape varies by model:
//   - amazon.titan-embed-text-* → request { inputText }, response { embedding: float[] }
//   - cohere.embed-*            → request { texts, input_type }, response { embeddings: float[][] }
//
// Mocking seam: `_clientFactory({ region, credentials })` returns a client whose
// `send(command) → { body: Uint8Array }` matches BedrockRuntimeClient. Tests stub
// the factory and emit synthetic JSON bodies.

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

import { ModelError, sleep, isRetryableHttp } from './_retry.js';

const MODEL_DIMENSIONS = Object.freeze({
  'amazon.titan-embed-text-v1': 1536,
  'amazon.titan-embed-text-v2:0': 1024,
  'cohere.embed-english-v3': 1024,
});

const DEFAULT_BACKOFF_MS = [100, 300, 900];

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

function isCohereOnBedrock(model) {
  return model.startsWith('cohere.');
}

export class BedrockAdapter {
  constructor(opts = {}) {
    const { region, credentials, model, _clientFactory, _backoffMs } = opts;

    if (!region || typeof region !== 'string') {
      throw new Error('BedrockAdapter: region is required');
    }
    if (!model || !(model in MODEL_DIMENSIONS)) {
      throw new Error(
        `BedrockAdapter: unknown model '${model}'. Supported: ${Object.keys(MODEL_DIMENSIONS).join(', ')}`,
      );
    }

    this.model = model;
    this._dimensions = MODEL_DIMENSIONS[model];
    this._backoffMs = Array.isArray(_backoffMs) ? _backoffMs : DEFAULT_BACKOFF_MS;

    const factory =
      typeof _clientFactory === 'function'
        ? _clientFactory
        : ({ region: r, credentials: c }) =>
            new BedrockRuntimeClient(c ? { region: r, credentials: c } : { region: r });

    this._client = factory({ region, credentials });
  }

  async embed(text) {
    const body = isCohereOnBedrock(this.model)
      ? { texts: [text], input_type: 'search_document' }
      : { inputText: text };

    const response = await this._invoke(body);
    if (isCohereOnBedrock(this.model)) {
      return response.embeddings[0];
    }
    return response.embedding;
  }

  async batchEmbed(texts) {
    if (isCohereOnBedrock(this.model)) {
      const response = await this._invoke({
        texts,
        input_type: 'search_document',
      });
      return response.embeddings;
    }
    // Titan: one Invoke per input.
    const out = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      const response = await this._invoke({ inputText: texts[i] });
      out[i] = response.embedding;
    }
    return out;
  }

  getInfo() {
    return {
      name: this.model,
      type: 'cloud',
      provider: 'bedrock',
      dimensions: this._dimensions,
    };
  }

  async _invoke(body) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const command = new InvokeModelCommand({
          modelId: this.model,
          accept: 'application/json',
          contentType: 'application/json',
          body: TEXT_ENCODER.encode(JSON.stringify(body)),
        });
        const result = await this._client.send(command);
        return JSON.parse(TEXT_DECODER.decode(result.body));
      } catch (err) {
        lastErr = err;
        if (!isRetryableHttp(err)) break;
        if (attempt < 2) await sleep(this._backoffMs[attempt] ?? 0);
      }
    }
    throw new ModelError({
      code: 'ERR-MODEL-002',
      provider: 'bedrock',
      cause: lastErr,
    });
  }
}
