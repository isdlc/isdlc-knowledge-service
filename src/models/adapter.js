// T006: Model Adapter — common interface and base class
// Traces: FR-002, FR-009, ERR-MODEL-001, ERR-MODEL-002, ERR-MODEL-003
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 7
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
//      docs/requirements/REQ-GH-263-.../requirements-spec.md (FR-009 AC-009-01, AC-009-02)

/**
 * @typedef {object} ModelInfo
 * @property {string} name
 * @property {"local"|"cloud"} type
 * @property {number} dimensions
 * @property {number} max_input_tokens
 * @property {string} [precision]   // local only: "fp4" | "fp16" | "fp32"
 * @property {string} [provider]    // cloud only
 * @property {number} [memory_mb]   // local only — estimated when loaded
 */

/**
 * Structured error carrying an iSDLC error-taxonomy code (ERR-MODEL-XXX).
 *
 * Adapters MUST throw ModelError (not bare Error) so the worker can branch on
 * `.code` for retry/fallback decisions per error-taxonomy.md.
 */
export class ModelError extends Error {
  /**
   * @param {string} code  — e.g. "ERR-MODEL-001"
   * @param {string} message
   * @param {object} [options]
   * @param {Error}  [options.cause]
   * @param {object} [options.details]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    if (options.cause) this.cause = options.cause;
    if (options.details) this.details = options.details;
  }
}

/**
 * Allowed local-model precisions (AC-009-02).
 */
export const ALLOWED_PRECISIONS = Object.freeze(['fp4', 'fp16', 'fp32']);

/**
 * Validate a non-empty string input for embed().
 * @param {unknown} text
 * @returns {string}
 */
export function validateText(text) {
  if (typeof text !== 'string') {
    throw new TypeError('embed(text): text must be a string');
  }
  if (text.length === 0) {
    throw new TypeError('embed(text): text must be non-empty');
  }
  return text;
}

/**
 * Validate a batch input for batchEmbed().
 * @param {unknown} texts
 * @returns {string[]}
 */
export function validateBatch(texts) {
  if (!Array.isArray(texts)) {
    throw new TypeError('batchEmbed(texts): texts must be an array');
  }
  if (texts.length === 0) {
    throw new TypeError('batchEmbed(texts): texts must be non-empty');
  }
  for (let i = 0; i < texts.length; i++) {
    if (typeof texts[i] !== 'string' || texts[i].length === 0) {
      throw new TypeError(`batchEmbed(texts): texts[${i}] must be a non-empty string`);
    }
  }
  return /** @type {string[]} */ (texts);
}

/**
 * Validate a precision string for local adapters (AC-009-02).
 * @param {unknown} precision
 * @returns {"fp4"|"fp16"|"fp32"}
 */
export function validatePrecision(precision) {
  if (!ALLOWED_PRECISIONS.includes(/** @type {string} */ (precision))) {
    throw new TypeError(
      `precision must be one of ${ALLOWED_PRECISIONS.join(', ')} (got ${String(precision)})`,
    );
  }
  return /** @type {"fp4"|"fp16"|"fp32"} */ (precision);
}

/**
 * Abstract base class. Concrete adapters (OnnxLocalAdapter, OpenAiAdapter, …)
 * MUST implement `embed`, `batchEmbed`, and `getInfo`.
 *
 * The base class provides argument validation hooks via the `validate*` helpers
 * above. Subclasses are free to add their own validation in addition.
 */
export class ModelAdapter {
  // eslint-disable-next-line no-unused-vars
  async embed(_text) {
    throw new Error('ModelAdapter.embed() must be implemented by subclass');
  }

  // eslint-disable-next-line no-unused-vars
  async batchEmbed(_texts) {
    throw new Error('ModelAdapter.batchEmbed() must be implemented by subclass');
  }

  /** @returns {ModelInfo} */
  getInfo() {
    throw new Error('ModelAdapter.getInfo() must be implemented by subclass');
  }
}
