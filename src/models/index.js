// Module 7: Model Adapters
// Responsibility: Unified embedding interface — local or cloud.
// Implementations: OnnxLocalAdapter (FP4/FP16/FP32), OpenAiAdapter, CohereAdapter, BedrockAdapter
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 7

/**
 * @typedef {object} ModelInfo
 * @property {string} name
 * @property {"local"|"cloud"} type
 * @property {number} dimensions
 * @property {string} [precision]   // local only: "fp4" | "fp16" | "fp32"
 * @property {string} [provider]    // cloud only
 */

/**
 * @typedef {object} ModelAdapter
 * @property {(text: string) => Promise<number[]>} embed
 * @property {(texts: string[]) => Promise<number[][]>} batchEmbed
 * @property {() => ModelInfo} getInfo
 */

/**
 * Resolve a model adapter from project model_config.
 * @param {object} modelConfig
 * @returns {ModelAdapter}
 */
export function getAdapter(modelConfig) {
  throw new Error('Not implemented — see T006/T007');
}
