// Module 8: Model Manager
// Responsibility: Model lifecycle — load, pin, LRU evict, memory tracking. Local models only.
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 8

/**
 * @typedef {object} ModelStatus
 * @property {Array<{ name: string, loaded: boolean, pinned: boolean, memory_mb: number, dimensions: number }>} models
 * @property {number} total_memory_mb
 * @property {number} available_memory_mb
 */

/**
 * Get a (possibly newly loaded) model adapter, recording usage for LRU.
 * @param {object} config
 * @returns {import('./index.js').ModelAdapter}
 */
export function getAdapter(config) {
  throw new Error('Not implemented — see T008');
}

/** @param {string} name */
export function pin(name) {
  throw new Error('Not implemented — see T008');
}

/** @param {string} name */
export function unpin(name) {
  throw new Error('Not implemented — see T008');
}

/** @returns {ModelStatus} */
export function getStatus() {
  throw new Error('Not implemented — see T008');
}
