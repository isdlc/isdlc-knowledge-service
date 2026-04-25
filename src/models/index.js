// Module 7: Model Adapters — default factory.
// Responsibility: Unified embedding interface — local or cloud.
// Implementations: OnnxLocalAdapter, OpenAiAdapter, CohereAdapter, BedrockAdapter
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 7
//
// Credential resolution (Constitution V.5, VII.5): cloud adapters receive
// resolved strings; the api_key reference shape ({env: "..."}) is resolved at
// THIS factory boundary so adapters themselves stay unchanged.

import { resolveCredential } from '../credentials/resolver.js';

/**
 * @typedef {object} ModelInfo
 * @property {string} name
 * @property {"local"|"cloud"} type
 * @property {number} dimensions
 * @property {string} [precision]
 * @property {string} [provider]
 */

/**
 * @typedef {object} ModelAdapter
 * @property {(text: string) => Promise<number[]>} embed
 * @property {(texts: string[]) => Promise<number[][]>} batchEmbed
 * @property {() => ModelInfo} getInfo
 */

/**
 * Default factory: resolve a model adapter from project model_config.
 * Credentials in cloud configs are resolved via {env: "..."} references.
 *
 * @param {object} modelConfig
 * @returns {Promise<ModelAdapter>}
 */
export async function getAdapter(modelConfig) {
  if (!modelConfig || typeof modelConfig !== 'object') {
    throw new TypeError('getAdapter: modelConfig is required');
  }

  if (modelConfig.source === 'local') {
    const { OnnxLocalAdapter } = await import('./onnx-local.js');
    return new OnnxLocalAdapter({
      modelPath: modelConfig.model_path || modelConfig.url,
      precision: modelConfig.precision || 'fp32',
    });
  }

  // Cloud — resolve api_key reference at this boundary.
  const apiKey = resolveCredential(modelConfig.api_key);

  switch (modelConfig.backend) {
    case 'openai': {
      const { OpenAiAdapter } = await import('./openai.js');
      return new OpenAiAdapter({ apiKey, model: modelConfig.model });
    }
    case 'cohere': {
      const { CohereAdapter } = await import('./cohere.js');
      return new CohereAdapter({ apiKey, model: modelConfig.model });
    }
    case 'bedrock': {
      const { BedrockAdapter } = await import('./bedrock.js');
      return new BedrockAdapter({
        region: modelConfig.region,
        credentials: apiKey ? { accessKeyId: apiKey, secretAccessKey: resolveCredential(modelConfig.secret_access_key) } : undefined,
        model: modelConfig.model,
      });
    }
    default:
      throw new Error(`Unknown model backend: ${modelConfig.backend}`);
  }
}
