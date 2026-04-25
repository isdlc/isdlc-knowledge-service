// Module 5: Correlation Engine
// T017: path/name matching, import graph, iSDLC artifact traces, Confluence-title matching.
// Traces: FR-002 (AC-002-01, AC-002-02, AC-002-04)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 5
//
// Responsibility: Create relationship links between chunks from multiple
// sources within a single project.
//
// Design notes:
//   - Strategies are pure functions over (chunks) → links and live in
//     ./strategies.js so they can be unit-tested in isolation.
//   - The engine runs every strategy, collects raw links, then deduplicates
//     by (from_id, to_id, relationship). When two strategies produce the
//     same edge with different confidences, the higher confidence wins.
//   - Output preserves input order. Each output chunk gets a `related`
//     array — empty if no strategy linked it.

import { ALL_STRATEGIES, CONFIDENCE } from './strategies.js';

/**
 * @typedef {object} RelatedSource
 * @property {string} path
 * @property {string} source_type
 * @property {"spec"|"test"|"doc"|"impl"} relationship
 * @property {number} confidence
 */

/**
 * @typedef {import('../connectors/connector.js').NormalisedChunk & { related: RelatedSource[] }} CorrelatedChunk
 */

/**
 * Correlate chunks across sources within a single project.
 *
 * @param {Array<import('../connectors/connector.js').NormalisedChunk>} chunks
 * @param {object} [_projectConfig]   Reserved for future per-project tuning.
 * @returns {Promise<CorrelatedChunk[]>}
 */
export async function correlate(chunks, _projectConfig) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];

  // 1. Run every strategy and pool the raw links.
  /** @type {Array<import('./strategies.js').CorrelationLink>} */
  const raw = [];
  for (const strat of ALL_STRATEGIES) {
    try {
      const out = strat(chunks);
      if (Array.isArray(out)) raw.push(...out);
    } catch (err) {
      // Strategies must never crash the engine — degrade gracefully.
      // We intentionally swallow per-strategy errors here; observability
      // (metrics / structured logs) can be added in T028.
      void err;
    }
  }

  // 2. Deduplicate by (from_id, to_id, relationship). Highest confidence wins.
  /** @type {Map<string, import('./strategies.js').CorrelationLink>} */
  const dedup = new Map();
  for (const link of raw) {
    if (
      typeof link.from_id !== 'number' ||
      typeof link.to_id !== 'number' ||
      link.from_id === link.to_id
    ) {
      continue;
    }
    if (link.from_id < 0 || link.to_id < 0) continue;
    if (link.from_id >= chunks.length || link.to_id >= chunks.length) continue;
    const key = `${link.from_id}→${link.to_id}|${link.relationship}`;
    const existing = dedup.get(key);
    if (!existing || link.confidence > existing.confidence) {
      dedup.set(key, link);
    }
  }

  // 3. Attach related[] to each chunk, ranked by descending confidence.
  /** @type {CorrelatedChunk[]} */
  const out = chunks.map((c) => ({ ...c, related: [] }));
  for (const link of dedup.values()) {
    const target = chunks[link.to_id];
    if (!target) continue;
    out[link.from_id].related.push({
      path: target.path,
      source_type: target.source_type,
      relationship: link.relationship,
      confidence: link.confidence,
    });
  }
  for (const chunk of out) {
    chunk.related.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return a.relationship < b.relationship ? -1 : 1;
    });
  }
  return out;
}

export { CONFIDENCE };
