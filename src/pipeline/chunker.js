// T018: Embedding Pipeline — context-windowed chunker.
// Traces: FR-002 (AC-002-04)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 6
//
// Responsibility: split a single piece of text into overlapping sub-chunks
// that each fit inside the model's input window, preferring natural
// boundaries (paragraph > line > sentence) over arbitrary mid-token cuts.
//
// Token approximation: 1 token ≈ 4 characters. The chunker operates on
// characters internally; the caller's `max_tokens` is multiplied by 4 to
// derive `maxChars`. This is a deliberate over-approximation — most
// embedding models count tokens, not chars, and the 4× heuristic keeps us
// under typical model windows for English text. Cloud adapters that need
// stricter accounting can pre-tokenise upstream.

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_OVERLAP_RATIO = 0.1; // 10% of max_tokens
// Don't yield chunks smaller than this fraction of maxChars when a boundary
// is found — tiny early chunks waste batch capacity without aiding recall.
const MIN_BOUNDARY_FRACTION = 0.5;

/**
 * @typedef {object} SubChunk
 * @property {string} text   The substring covering [start, end).
 * @property {number} start  Inclusive character offset in the source.
 * @property {number} end    Exclusive character offset in the source.
 * @property {number} index  Sequential index, starting at 0.
 */

/**
 * @typedef {object} ChunkOptions
 * @property {number} [max_tokens]      Approximate token cap per sub-chunk (default 256).
 * @property {number} [overlap_tokens]  Approximate token overlap (default ~10% of max_tokens).
 */

/**
 * Split `content` into context-windowed sub-chunks.
 *
 * @param {string | null | undefined} content
 * @param {ChunkOptions} [options]
 * @returns {Generator<SubChunk>}
 */
export function* chunkContent(content, options = {}) {
  // Defensive: tolerate any falsy / non-string input.
  if (typeof content !== 'string') return;
  const trimmedLen = content.trim().length;
  if (trimmedLen === 0) return;

  const maxTokens = Math.max(1, Number(options.max_tokens) || DEFAULT_MAX_TOKENS);
  const overlapTokens =
    options.overlap_tokens === undefined
      ? Math.max(1, Math.round(maxTokens * DEFAULT_OVERLAP_RATIO))
      : Math.max(0, Number(options.overlap_tokens) || 0);

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = Math.min(overlapTokens * CHARS_PER_TOKEN, Math.floor(maxChars / 2));
  const minSize = Math.max(1, Math.floor(maxChars * MIN_BOUNDARY_FRACTION));

  let start = 0;
  let index = 0;
  const len = content.length;

  while (start < len) {
    // Final chunk: the rest fits inside one window.
    if (start + maxChars >= len) {
      yield { text: content.slice(start, len), start, end: len, index };
      return;
    }

    const targetEnd = start + maxChars;
    const lowerBound = start + minSize;

    // Look for the best natural boundary inside [lowerBound, targetEnd].
    // Order of preference: \n\n  >  \n  >  sentence end ([.!?] followed by
    // whitespace or EOF). We search backward from `targetEnd` so that the
    // chunk is as full as possible while still ending on a boundary.
    let cutEnd = -1;

    // Paragraph break.
    const paraIdx = content.lastIndexOf('\n\n', targetEnd);
    if (paraIdx >= lowerBound) {
      cutEnd = paraIdx + 2; // include the \n\n in the previous chunk's range
    }

    // Line break.
    if (cutEnd === -1) {
      const lineIdx = content.lastIndexOf('\n', targetEnd);
      if (lineIdx >= lowerBound) {
        cutEnd = lineIdx + 1;
      }
    }

    // Sentence end: scan backwards for [.!?] followed by whitespace.
    if (cutEnd === -1) {
      for (let i = targetEnd; i >= lowerBound; i--) {
        const ch = content[i];
        if (ch === '.' || ch === '!' || ch === '?') {
          const next = content[i + 1];
          if (next === undefined || /\s/.test(next)) {
            cutEnd = i + 1;
            break;
          }
        }
      }
    }

    // Fallback: hard cut at maxChars.
    if (cutEnd === -1) cutEnd = targetEnd;

    yield { text: content.slice(start, cutEnd), start, end: cutEnd, index };
    index += 1;

    // Advance with overlap. Always make forward progress (>= 1 char).
    const next = cutEnd - overlapChars;
    start = next > start ? next : cutEnd;
  }
}
