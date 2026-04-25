// T008: Model Manager — load, pin, unpin, LRU eviction, memory tracking.
// Traces: FR-011 (AC-011-01, AC-011-02, AC-011-03, AC-011-04, AC-011-05)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 8
//      docs/requirements/REQ-GH-263-.../requirements-spec.md (FR-011)
//
// Scope (per Module 8): the Model Manager is LOCAL-ONLY. Cloud adapters have
// no resident memory footprint to manage, so cloud configs bypass the cache,
// LRU, and pin registry. They are constructed on demand and returned directly.

import { ModelAdapter } from './adapter.js';
import { OnnxLocalAdapter } from './onnx-local.js';

/**
 * @typedef {object} ModelStatus
 * @property {string}        name
 * @property {boolean}       loaded
 * @property {boolean}       pinned
 * @property {number}        memory_mb
 * @property {number|null}   last_used   epoch ms; null if never used
 */

/**
 * @typedef {object} ModelConfig
 * @property {string}  name             friendly model identifier (cache key)
 * @property {"local"|"cloud"} type
 * @property {string}  [modelPath]      local only
 * @property {string}  [precision]      local only
 * @property {string}  [provider]       cloud only
 */

/**
 * Default factory for "local" — instantiates an OnnxLocalAdapter from config.
 * Tests inject their own factories via `adapterFactories` to avoid touching
 * onnxruntime-node.
 */
function defaultLocalFactory(config) {
  return new OnnxLocalAdapter({
    modelPath: config.modelPath,
    precision: config.precision,
    name: config.name,
    dimensions: config.dimensions,
    maxInputTokens: config.maxInputTokens,
    tokenizer: config.tokenizer,
    sessionLoader: config.sessionLoader,
  });
}

/**
 * Model Manager — local-only lifecycle (load / pin / unpin / LRU evict).
 *
 * Constructor options:
 *   - maxLoadedModels   number (default 3) — capacity of the LRU cache
 *   - adapterFactories  { local: (config) => ModelAdapter, cloud?: (config) => ModelAdapter }
 *                       Test seam. Defaults to wiring local -> OnnxLocalAdapter.
 *                       Cloud factory is optional; supply when getAdapter may
 *                       receive cloud configs.
 *   - clock             () => number  — test seam for last_used timestamps
 */
export class ModelManager {
  constructor(options = {}) {
    const {
      maxLoadedModels = 3,
      adapterFactories,
      clock = () => Date.now(),
    } = options;

    if (!Number.isInteger(maxLoadedModels) || maxLoadedModels < 1) {
      throw new TypeError('ModelManager: maxLoadedModels must be a positive integer');
    }

    this.maxLoadedModels = maxLoadedModels;
    this._clock = clock;
    this._factories = {
      local: defaultLocalFactory,
      ...(adapterFactories || {}),
    };

    /**
     * Loaded local adapters. Insertion order is irrelevant for eviction —
     * we evict by the smallest `last_used`. Pinned entries are skipped.
     * @type {Map<string, { adapter: ModelAdapter, pinned: boolean, last_used: number }>}
     */
    this._loaded = new Map();

    /**
     * Pin set is tracked independently so a model can be pinned BEFORE it is
     * loaded (AC-011-01: pinning intent is sticky). When the model is later
     * loaded via getAdapter, it inherits the pin.
     * @type {Set<string>}
     */
    this._pinned = new Set();
  }

  /**
   * Resolve (or load) the adapter for a given config.
   *
   * Local configs:
   *   - cache hit  -> bumps last_used, returns the cached adapter
   *   - cache miss -> evict LRU unpinned if at capacity, instantiate via
   *                   the configured factory, register, return.
   *
   * Cloud configs:
   *   - bypass the cache entirely; build via the cloud factory and return.
   *     Module 8 explicitly limits memory management to local models.
   *
   * @param {ModelConfig} config
   * @returns {ModelAdapter}
   */
  getAdapter(config) {
    if (!config || typeof config !== 'object') {
      throw new TypeError('ModelManager.getAdapter: config is required');
    }
    const { type, name } = config;
    if (type !== 'local' && type !== 'cloud') {
      throw new TypeError(
        `ModelManager.getAdapter: config.type must be "local" or "cloud" (got ${String(type)})`,
      );
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('ModelManager.getAdapter: config.name is required');
    }

    if (type === 'cloud') {
      // Local-only manager — cloud adapters bypass cache (AC-011-05 distinction).
      const factory = this._factories.cloud;
      if (typeof factory !== 'function') {
        throw new TypeError(
          'ModelManager: cloud adapter factory not configured. ' +
            'Cloud configs must be constructed by the caller, or supply ' +
            'adapterFactories.cloud at construction time.',
        );
      }
      return factory(config);
    }

    // Local path — cache hit?
    const existing = this._loaded.get(name);
    if (existing) {
      existing.last_used = this._clock();
      return existing.adapter;
    }

    // Cache miss — evict if necessary (LRU among unpinned).
    if (this._loaded.size >= this.maxLoadedModels) {
      this._evictLruUnpinned();
    }

    const factory = this._factories.local;
    if (typeof factory !== 'function') {
      throw new TypeError('ModelManager: local adapter factory missing');
    }
    const adapter = factory(config);
    if (!(adapter instanceof ModelAdapter)) {
      // Be lenient — duck-type-check for required methods. ModelAdapter
      // subclasses pass; mocks need only quack.
      if (
        typeof adapter?.embed !== 'function' ||
        typeof adapter?.batchEmbed !== 'function' ||
        typeof adapter?.getInfo !== 'function'
      ) {
        throw new TypeError(
          `ModelManager: factory for "${name}" returned an invalid adapter`,
        );
      }
    }

    this._loaded.set(name, {
      adapter,
      pinned: this._pinned.has(name),
      last_used: this._clock(),
    });
    return adapter;
  }

  /**
   * Pin a model so it cannot be evicted (AC-011-01).
   * Pinning a model that is not yet loaded records intent — when the model is
   * later loaded via getAdapter, it inherits the pin.
   * @param {string} name
   */
  pin(name) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('ModelManager.pin: name is required');
    }
    this._pinned.add(name);
    const entry = this._loaded.get(name);
    if (entry) entry.pinned = true;
  }

  /**
   * Unpin a model so LRU eviction may consider it again (AC-011-02).
   * No-op if not pinned. Does not unload the model.
   * @param {string} name
   */
  unpin(name) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('ModelManager.unpin: name is required');
    }
    this._pinned.delete(name);
    const entry = this._loaded.get(name);
    if (entry) entry.pinned = false;
  }

  /**
   * Snapshot of all known models (loaded + pin-only intent).
   * Powers the Web UI Monitoring tab (AC-011-03, AC-011-04).
   * @returns {ModelStatus[]}
   */
  getStatus() {
    /** @type {ModelStatus[]} */
    const out = [];

    for (const [name, entry] of this._loaded) {
      out.push({
        name,
        loaded: true,
        pinned: entry.pinned,
        memory_mb: this._memoryOf(entry.adapter),
        last_used: entry.last_used,
      });
    }

    // Pinned-but-not-yet-loaded models still appear in status so the UI can
    // surface the user's intent.
    for (const name of this._pinned) {
      if (!this._loaded.has(name)) {
        out.push({
          name,
          loaded: false,
          pinned: true,
          memory_mb: 0,
          last_used: null,
        });
      }
    }

    return out;
  }

  // --- internals ---------------------------------------------------------

  /**
   * Evict the least-recently-used UNPINNED entry. Throws if every loaded
   * model is pinned and we are at capacity (AC-011-01: pinned models are
   * never evicted; the caller must unpin first).
   */
  _evictLruUnpinned() {
    /** @type {string|null} */
    let victim = null;
    let oldest = Infinity;
    for (const [name, entry] of this._loaded) {
      if (entry.pinned) continue;
      if (entry.last_used < oldest) {
        oldest = entry.last_used;
        victim = name;
      }
    }
    if (victim === null) {
      throw new Error(
        'ModelManager: cannot load new model — cache is full and every ' +
          'loaded model is pinned. Unpin a model or raise maxLoadedModels.',
      );
    }
    this._loaded.delete(victim);
  }

  /**
   * Aggregate-friendly memory accessor. Adapters MAY expose getMemoryUsage();
   * if absent we fall back to ModelInfo.memory_mb, then 0.
   */
  _memoryOf(adapter) {
    try {
      if (typeof adapter.getMemoryUsage === 'function') {
        const v = adapter.getMemoryUsage();
        if (Number.isFinite(v)) return v;
      }
      const info = adapter.getInfo?.();
      if (info && Number.isFinite(info.memory_mb)) return info.memory_mb;
    } catch {
      // adapters under partial init — surface 0 rather than crash status.
    }
    return 0;
  }
}
