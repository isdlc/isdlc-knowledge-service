// T006: ONNX local model adapter — FP4 / FP16 / FP32
// Traces: FR-002, FR-009 (AC-009-01, AC-009-02), ERR-MODEL-001, ERR-MODEL-003
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 7
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md

import { existsSync, statSync } from 'node:fs';
import {
  ModelAdapter,
  ModelError,
  validateText,
  validateBatch,
  validatePrecision,
} from './adapter.js';

/**
 * @typedef {(text: string) => (number[] | { input_ids: number[], attention_mask?: number[] })} TokenizerFn
 *   A tokenizer is a function that converts a string into either:
 *     - an array of token ids, or
 *     - an object with `input_ids` (and optional `attention_mask`).
 *   Real tokenizer wiring (BERT WordPiece, etc.) is per-model and lives downstream
 *   (in the Model Manager / pipeline). The adapter accepts a tokenizer fn so it
 *   can stay agnostic. If no tokenizer is supplied, a passthrough character-code
 *   tokenizer is used (sufficient for tests; never used in production).
 */

/** Default ONNX session loader — lazy-imported so tests can monkey-patch. */
async function defaultSessionLoader(modelPath) {
  // Lazy ESM import — onnxruntime-node is heavy and we only want to pay the
  // load cost when actually embedding.
  const ort = await import('onnxruntime-node');
  return ort.InferenceSession.create(modelPath);
}

/** Passthrough character-code tokenizer (test-only fallback). */
function passthroughTokenizer(text) {
  const ids = [];
  for (let i = 0; i < text.length; i++) ids.push(text.charCodeAt(i));
  return { input_ids: ids, attention_mask: ids.map(() => 1) };
}

/** Per-precision rough memory estimate (MB) — informational only. */
function estimateMemoryMb(precision) {
  switch (precision) {
    case 'fp4':
      return 60;
    case 'fp16':
      return 120;
    case 'fp32':
    default:
      return 240;
  }
}

/**
 * ONNX local adapter. Lazy-loads the session on first embed/batchEmbed call.
 *
 * Constructor options:
 *   - modelPath        absolute path to the .onnx file (required)
 *   - precision        "fp4" | "fp16" | "fp32"          (required, AC-009-02)
 *   - name             friendly model name              (default: basename(modelPath))
 *   - dimensions       output embedding dimensions      (default: 384)
 *   - maxInputTokens   tokenizer truncation limit       (default: 512)
 *   - tokenizer        TokenizerFn                      (optional)
 *   - sessionLoader    (path) => Promise<Session>       (test-injection seam)
 *
 * The sessionLoader seam is the key testability hook: tests pass a fake loader
 * that returns an object exposing `run({...}) -> { last_hidden_state | sentence_embedding | output }`.
 */
export class OnnxLocalAdapter extends ModelAdapter {
  constructor(options = {}) {
    super();
    const {
      modelPath,
      precision,
      name,
      dimensions = 384,
      maxInputTokens = 512,
      tokenizer,
      sessionLoader = defaultSessionLoader,
    } = options;

    if (typeof modelPath !== 'string' || modelPath.length === 0) {
      throw new TypeError('OnnxLocalAdapter: modelPath is required');
    }
    this.modelPath = modelPath;
    this.precision = validatePrecision(precision);
    this.name = name || basename(modelPath);
    this.dimensions = dimensions;
    this.maxInputTokens = maxInputTokens;
    this.tokenizer = typeof tokenizer === 'function' ? tokenizer : passthroughTokenizer;
    this._sessionLoader = sessionLoader;

    /** @type {unknown} */
    this._session = null;
    this._loaded = false;
  }

  /**
   * Load the ONNX session. Idempotent. Lazy — called on first embed/batchEmbed.
   *
   * Errors:
   *   - ERR-MODEL-003: model file does not exist on disk
   *   - ERR-MODEL-001: session loader threw (corrupt / incompatible / etc.)
   */
  async loadModel() {
    if (this._loaded) return;

    if (!existsSync(this.modelPath)) {
      throw new ModelError(
        'ERR-MODEL-003',
        `Model file not found: ${this.modelPath}`,
        { details: { modelPath: this.modelPath } },
      );
    }

    try {
      this._session = await this._sessionLoader(this.modelPath);
    } catch (cause) {
      throw new ModelError(
        'ERR-MODEL-001',
        `Failed to load ONNX session for ${this.name}: ${cause?.message ?? cause}`,
        { cause, details: { modelPath: this.modelPath, precision: this.precision } },
      );
    }
    this._loaded = true;
  }

  /**
   * Embed a single string. Returns a `dimensions`-length vector.
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async embed(text) {
    validateText(text);
    const [vec] = await this.batchEmbed([text]);
    return vec;
  }

  /**
   * Embed a batch in a single session.run call (efficiency requirement).
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async batchEmbed(texts) {
    validateBatch(texts);
    await this.loadModel();

    const tokenized = texts.map((t) => this._normaliseTokens(this.tokenizer(t)));
    const feeds = this._buildFeeds(tokenized);

    let output;
    try {
      output = await this._session.run(feeds);
    } catch (cause) {
      throw new ModelError(
        'ERR-MODEL-001',
        `ONNX session.run failed for ${this.name}: ${cause?.message ?? cause}`,
        { cause, details: { batchSize: texts.length } },
      );
    }

    return this._extractEmbeddings(output, texts.length);
  }

  /** @returns {import('./adapter.js').ModelInfo} */
  getInfo() {
    return {
      name: this.name,
      type: 'local',
      dimensions: this.dimensions,
      max_input_tokens: this.maxInputTokens,
      precision: this.precision,
      memory_mb: this._loaded ? this.getMemoryUsage() : estimateMemoryMb(this.precision),
    };
  }

  /**
   * Best-effort RSS-based estimate while the session is loaded. Returns the
   * precision-based estimate when the session has not been loaded yet.
   * @returns {number}
   */
  getMemoryUsage() {
    if (!this._loaded) return estimateMemoryMb(this.precision);
    try {
      const rss = process.memoryUsage().rss;
      return Math.round(rss / (1024 * 1024));
    } catch {
      return estimateMemoryMb(this.precision);
    }
  }

  // --- internals -----------------------------------------------------------

  _normaliseTokens(t) {
    if (Array.isArray(t)) {
      return { input_ids: t, attention_mask: t.map(() => 1) };
    }
    if (t && Array.isArray(t.input_ids)) {
      return {
        input_ids: t.input_ids,
        attention_mask: Array.isArray(t.attention_mask)
          ? t.attention_mask
          : t.input_ids.map(() => 1),
      };
    }
    throw new TypeError('tokenizer must return number[] or { input_ids, attention_mask? }');
  }

  _buildFeeds(tokenized) {
    // Pad to the longest sequence in the batch (capped at maxInputTokens).
    const maxLen = Math.min(
      this.maxInputTokens,
      tokenized.reduce((m, t) => Math.max(m, t.input_ids.length), 1),
    );
    const inputIds = new BigInt64Array(tokenized.length * maxLen);
    const attentionMask = new BigInt64Array(tokenized.length * maxLen);

    for (let row = 0; row < tokenized.length; row++) {
      const ids = tokenized[row].input_ids.slice(0, maxLen);
      const mask = tokenized[row].attention_mask.slice(0, maxLen);
      for (let col = 0; col < ids.length; col++) {
        inputIds[row * maxLen + col] = BigInt(ids[col]);
        attentionMask[row * maxLen + col] = BigInt(mask[col]);
      }
    }

    return {
      input_ids: { data: inputIds, dims: [tokenized.length, maxLen] },
      attention_mask: { data: attentionMask, dims: [tokenized.length, maxLen] },
    };
  }

  _extractEmbeddings(output, batchSize) {
    // Common ONNX embedding output names (in order of preference).
    const candidateKeys = [
      'sentence_embedding',
      'pooler_output',
      'last_hidden_state',
      'output',
      'embeddings',
    ];
    let tensor = null;
    for (const key of candidateKeys) {
      if (output && output[key]) {
        tensor = output[key];
        break;
      }
    }
    if (!tensor) {
      // Fall back to the first value in the output map.
      const first = output && Object.values(output)[0];
      if (first) tensor = first;
    }
    if (!tensor) {
      throw new ModelError(
        'ERR-MODEL-001',
        `ONNX output had no recognisable embedding tensor for ${this.name}`,
      );
    }

    const data = tensor.data ?? tensor;
    const dims = tensor.dims;

    // Shape variants we accept:
    //   [batch, dimensions]                       — sentence-level pooled output
    //   [batch, seq_len, dimensions]              — token-level; we mean-pool
    //   flat array of length batch * dimensions   — assume pooled
    if (Array.isArray(dims) && dims.length === 2) {
      const dim = dims[1];
      this.dimensions = dim;
      return this._sliceFlat(data, batchSize, dim);
    }
    if (Array.isArray(dims) && dims.length === 3) {
      const seq = dims[1];
      const dim = dims[2];
      this.dimensions = dim;
      return this._meanPool(data, batchSize, seq, dim);
    }

    // No dims info — best-effort flat slice using configured dimensions.
    return this._sliceFlat(data, batchSize, this.dimensions);
  }

  _sliceFlat(data, batchSize, dim) {
    const out = [];
    for (let i = 0; i < batchSize; i++) {
      const row = new Array(dim);
      for (let j = 0; j < dim; j++) row[j] = Number(data[i * dim + j]);
      out.push(row);
    }
    return out;
  }

  _meanPool(data, batchSize, seqLen, dim) {
    const out = [];
    for (let i = 0; i < batchSize; i++) {
      const row = new Array(dim).fill(0);
      for (let s = 0; s < seqLen; s++) {
        const base = (i * seqLen + s) * dim;
        for (let d = 0; d < dim; d++) row[d] += Number(data[base + d]);
      }
      for (let d = 0; d < dim; d++) row[d] /= seqLen;
      out.push(row);
    }
    return out;
  }
}

function basename(p) {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return slash >= 0 ? p.slice(slash + 1) : p;
}
