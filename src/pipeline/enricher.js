// T018: Embedding Pipeline — relationship-aware enricher.
// Traces: FR-002 (AC-002-02, AC-002-04)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 6
//
// Responsibility: prepend a compact "relationship preamble" to each
// sub-chunk's text BEFORE handing it to the model adapter. The preamble
// surfaces the chunk's project, source, path, and (when present) a ranked
// summary of the related sources discovered by the Correlation Engine.
//
// This is what makes the resulting embedding "relationship-aware":
// the model sees not just the chunk's own content but also the context of
// how it relates to the rest of the project. Two chunks with similar
// content but different relationship contexts will land at different
// points in the embedding space.
//
// Preamble format:
//
//   [Project: <project> | Source: <source_type> | Path: <path>{ | Related: <list>}]
//   <blank line>
//   <chunk text>
//
// `<list>` is a comma-separated `<relationship>: <path> (<confidence>)`
// sequence sorted by descending confidence. When the chunk has no related
// sources the `Related:` field is omitted entirely.

/**
 * @typedef {object} EnrichOptions
 * @property {string} [project]   Override `chunk.metadata.project`.
 */

/**
 * Build the relationship preamble + return preamble + "\n\n" + text.
 *
 * @param {import('../correlation/index.js').CorrelatedChunk} chunk
 * @param {string} text   The (sub-)chunk text being embedded.
 * @param {EnrichOptions} [options]
 * @returns {string}
 */
export function enrich(chunk, text, options = {}) {
  const project = resolveProject(chunk, options);
  const sourceType = chunk?.source_type ?? 'unknown';
  const path = chunk?.path ?? 'unknown';

  /** @type {string[]} */
  const fields = [
    `Project: ${project}`,
    `Source: ${sourceType}`,
    `Path: ${path}`,
  ];

  const relatedField = formatRelated(chunk?.related);
  if (relatedField) fields.push(`Related: ${relatedField}`);

  return `[${fields.join(' | ')}]\n\n${text}`;
}

/**
 * Resolve the project name with a stable precedence:
 *   options.project  >  chunk.metadata.project  >  "unknown"
 *
 * @param {import('../correlation/index.js').CorrelatedChunk} chunk
 * @param {EnrichOptions} options
 * @returns {string}
 */
function resolveProject(chunk, options) {
  if (options && typeof options.project === 'string' && options.project.length > 0) {
    return options.project;
  }
  const fromMeta = chunk?.metadata?.project;
  if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta;
  return 'unknown';
}

/**
 * Render the related list. Returns `null` when there is nothing to render.
 *
 * @param {Array<import('../correlation/index.js').RelatedSource> | undefined} related
 * @returns {string | null}
 */
function formatRelated(related) {
  if (!Array.isArray(related) || related.length === 0) return null;
  // The correlation engine already sorts by descending confidence, but we
  // re-sort defensively so this function stays correct even if the input
  // was hand-built (e.g. by tests or future strategies).
  const ordered = related.slice().sort((a, b) => {
    const ca = typeof a?.confidence === 'number' ? a.confidence : 0;
    const cb = typeof b?.confidence === 'number' ? b.confidence : 0;
    if (ca !== cb) return cb - ca;
    const pa = a?.path ?? '';
    const pb = b?.path ?? '';
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  const parts = ordered
    .map((r) => {
      const rel = r?.relationship ?? 'rel';
      const path = r?.path ?? 'unknown';
      const conf = typeof r?.confidence === 'number' ? r.confidence : 0;
      return `${rel}: ${path} (${formatConfidence(conf)})`;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Format a confidence number compactly: drops the trailing zero in 0.90 → 0.9.
 * @param {number} c
 */
function formatConfidence(c) {
  // Two decimals, then strip trailing zeros, then strip trailing dot.
  return c
    .toFixed(2)
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}
