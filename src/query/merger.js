// Module 2: Query Engine — Merger
// Traces: FR-006 (AC-006-03 tag by project, AC-006-04 merge across projects), FR-008
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 2
//      docs/requirements/REQ-GH-263-.../requirements-spec.md FR-006
//
// Pure functions — no I/O, no async. The merger is the policy layer for
// combining per-project VectorResult arrays into a single ranked SearchResult
// list:
//
//   1. Tag each result with its source project (AC-006-03).
//   2. Normalize raw scores across heterogeneous similarity metrics so
//      cross-project ranking is comparable.
//   3. Sort by normalized score, descending.
//   4. Trim to total_limit.
//
// Score normalization (v1, intentionally coarse):
//   - "cosine"  raw score is already in [-1, 1]; map to [0, 1] via (s + 1) / 2.
//               Most cosine-similarity adapters return values in [0, 1] already
//               (clamped); we accept either.
//   - "dot"     dot-product is unbounded; we apply a logistic squash
//               1 / (1 + exp(-s)) so larger values map nearer to 1. This is
//               coarse — for a tighter ranking, callers should normalize
//               vectors so dot-product ≡ cosine.
//   - "l2"      Euclidean distance: smaller is better, lower-bounded at 0.
//               Convert to a similarity in (0, 1] via 1 / (1 + s).
//   - default   if metric is unknown or absent, treat as cosine in [0, 1] and
//               clamp.
//
// CAVEAT: cross-project ranking when adapters report different metrics is
// inherently approximate in v1. The normalization keeps scores monotonic per
// metric but is not calibrated across metrics. Operators who need precise
// cross-project ordering should standardise on a single metric.

/**
 * @typedef {import('../vectordb/adapter.js').VectorResult} VectorResult
 * @typedef {{ content: string, score: number, project: string, source_type: string, source_url: string, related_sources: Array<{ path: string, relationship: string }> }} SearchResult
 */

const DEFAULT_TOTAL_LIMIT = 30;

/**
 * Map a raw similarity/distance score from a given metric into a comparable
 * similarity value in (approximately) [0, 1] where higher is better.
 *
 * @param {number} raw
 * @param {string} [metric]  "cosine" | "l2" | "dot" — unknown values fall back
 *                           to cosine-style clamping.
 * @returns {number}
 */
export function normalize(raw, metric) {
  if (typeof raw !== 'number' || Number.isNaN(raw)) return 0;
  switch (metric) {
    case 'l2': {
      // Euclidean distance: 0 = identical, larger = farther. Map to (0, 1].
      const d = raw < 0 ? 0 : raw;
      return 1 / (1 + d);
    }
    case 'dot': {
      // Logistic squash for unbounded dot-product scores.
      // Clamp the input to avoid Infinity in exp() for very large magnitudes.
      const s = Math.max(-50, Math.min(50, raw));
      return 1 / (1 + Math.exp(-s));
    }
    case 'cosine':
    default: {
      // Many cosine adapters already return [0, 1]; some return [-1, 1].
      // Accept either and clamp the output.
      const s = raw < -1 ? -1 : raw > 1 ? 1 : raw;
      const mapped = s < 0 ? (s + 1) / 2 : s; // [-1,0)->[0,0.5), [0,1]->[0,1]
      return mapped < 0 ? 0 : mapped > 1 ? 1 : mapped;
    }
  }
}

/**
 * Convert one VectorResult into a SearchResult, tagging it with its project.
 * @param {VectorResult} r
 * @param {string} projectId
 * @param {string} [metric]
 * @returns {SearchResult}
 */
function toSearchResult(r, projectId, metric) {
  const meta = (r && r.metadata) || {};
  const related = Array.isArray(meta.related_sources) ? meta.related_sources : [];
  return {
    content: r.content ?? meta.content ?? '',
    score: normalize(r.score, metric),
    project: projectId,
    source_type: meta.source_type ?? '',
    source_url: meta.source_url ?? '',
    related_sources: related.map((rs) => ({
      path: rs.path ?? '',
      relationship: rs.relationship ?? '',
    })),
  };
}

/**
 * Merge per-project VectorResult arrays into a single ranked, project-tagged
 * SearchResult list.
 *
 * @param {Record<string, { results: VectorResult[], metric?: string }>} perProjectResults
 * @param {{ total_limit?: number }} [options]
 * @returns {SearchResult[]}
 */
export function merge(perProjectResults, options = {}) {
  const totalLimit =
    typeof options.total_limit === 'number' && options.total_limit > 0
      ? options.total_limit
      : DEFAULT_TOTAL_LIMIT;

  if (!perProjectResults || typeof perProjectResults !== 'object') return [];

  /** @type {SearchResult[]} */
  const merged = [];
  for (const projectId of Object.keys(perProjectResults)) {
    const entry = perProjectResults[projectId];
    if (!entry) continue;
    const results = Array.isArray(entry.results) ? entry.results : [];
    const metric = entry.metric;
    for (const r of results) {
      if (!r) continue;
      merged.push(toSearchResult(r, projectId, metric));
    }
  }

  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, totalLimit);
}
