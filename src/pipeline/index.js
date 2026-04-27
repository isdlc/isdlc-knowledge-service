// T018: Embedding Pipeline — orchestrator.
// Traces: FR-002 (AC-002-01, AC-002-02, AC-002-04)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 6
//
// Responsibility: take CorrelatedChunks → split each into context-windowed
// sub-chunks (chunker.js) → prepend a relationship preamble (enricher.js)
// → call the supplied ModelAdapter to produce vectors → yield EmbeddedChunks.
//
// The pipeline is async-iterable so downstream stages (Vector DB store) can
// pull chunks one batch at a time without materialising the whole project
// in memory.
//
// Stable IDs: each EmbeddedChunk carries a deterministic ID derived from
// `sha256(${project}:${path}:${chunkIndex})` (first 16 hex chars). Re-running
// the pipeline on the same logical input produces the same ID — this is the
// idempotency keystone (Constitution Article VI.2): re-embed = upsert.
//
// NOTE: the test-strategy v0 (UT-100) describes a content-hash-based ID
// shape (`sha256(project_id + '\n' + source_url + '\n' + content_hash)`).
// The task delegation for T018 is the authoritative spec and uses the
// (project, path, chunkIndex) shape, which gives the desired upsert-on-edit
// semantics: editing a file replaces the chunk in place rather than
// inserting a new vector. Tests under tests/integration that assert upsert
// behaviour should follow this id shape.

import { createHash } from 'node:crypto';

import { chunkContent } from './chunker.js';
import { enrich } from './enricher.js';
import { extractTraceabilityMetadata } from './metadata-vocabulary.js';

/**
 * @typedef {object} EmbeddedChunk
 * @property {string} id
 * @property {number[]} vector
 * @property {string} content                            The enriched text the model embedded.
 * @property {{ path: string, source_type: string, source_url: string,
 *              last_modified?: string, project?: string,
 *              chunk_index: number, sub_chunk_start: number,
 *              sub_chunk_end: number }} metadata
 * @property {Array<import('../correlation/index.js').RelatedSource>} related_sources
 */

/**
 * @typedef {object} EmbedOptions
 * @property {string} [project]   Override the project name resolved from
 *                                `chunk.metadata.project`. When neither is
 *                                supplied the project resolves to "unknown".
 * @property {import('./metadata-vocabulary.js').MetadataVocabularyConfig} [metadata_vocabulary]
 *                                Project-level custom linked_* fields.
 */

/**
 * Run the relationship-aware embedding pipeline.
 *
 * @param {Array<import('../correlation/index.js').CorrelatedChunk>} chunks
 * @param {{
 *   embed: (text: string) => Promise<number[]>,
 *   batchEmbed: (texts: string[]) => Promise<number[][]>,
 *   getInfo: () => { max_input_tokens?: number, dimensions?: number, [k: string]: unknown },
 * }} modelAdapter
 * @param {EmbedOptions} [options]
 * @returns {AsyncGenerator<EmbeddedChunk>}
 */
export async function* embed(chunks, modelAdapter, options = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) return;
  if (!modelAdapter || typeof modelAdapter.batchEmbed !== 'function') {
    throw new TypeError('embed(chunks, modelAdapter): modelAdapter.batchEmbed is required');
  }
  if (typeof modelAdapter.getInfo !== 'function') {
    throw new TypeError('embed(chunks, modelAdapter): modelAdapter.getInfo is required');
  }

  const info = modelAdapter.getInfo() || {};
  const maxTokens = Number.isFinite(info.max_input_tokens) ? info.max_input_tokens : undefined;

  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    const content = typeof chunk.content === 'string' ? chunk.content : '';
    if (content.trim().length === 0) continue;

    const project = resolveProject(chunk, options);

    // Split into sub-chunks driven by the model's input window.
    const subs = [...chunkContent(content, { max_tokens: maxTokens })];
    if (subs.length === 0) continue;

    // Enrich each sub-chunk with the relationship preamble. This is the
    // text the model actually sees.
    const enriched = subs.map((s) => enrich(chunk, s.text, { project }));

    // One batchEmbed call per parent chunk keeps the chunk_index numbering
    // self-contained and the batch sizing predictable.
    let vectors;
    try {
      vectors = await modelAdapter.batchEmbed(enriched);
    } catch (err) {
      // Re-throw — the worker is responsible for queue retry / fallback.
      throw err;
    }

    if (!Array.isArray(vectors) || vectors.length !== enriched.length) {
      throw new Error(
        `embed(): modelAdapter.batchEmbed returned ${
          Array.isArray(vectors) ? vectors.length : 'non-array'
        } vectors for ${enriched.length} inputs`,
      );
    }

    for (let i = 0; i < enriched.length; i++) {
      const sub = subs[i];
      yield {
        id: stableChunkId(project, chunk.path ?? '', i),
        vector: vectors[i],
        content: enriched[i],
        metadata: {
          ...extractTraceabilityMetadata(chunk.metadata, options.metadata_vocabulary),
          path: chunk.path ?? '',
          source_type: chunk.source_type ?? 'unknown',
          source_url: chunk.source_url ?? '',
          last_modified: chunk.last_modified,
          project,
          chunk_index: i,
          sub_chunk_start: sub.start,
          sub_chunk_end: sub.end,
        },
        related_sources: Array.isArray(chunk.related) ? chunk.related.slice() : [],
      };
    }
  }
}

/**
 * Stable, deterministic chunk ID.
 *
 *   sha256(`${project}:${path}:${chunkIndex}`).slice(0, 16)
 *
 * 16 hex chars = 64 bits — collision-resistant for any realistic project
 * size and short enough to be cheap as a primary key in sqlite-vec /
 * Qdrant / etc.
 *
 * @param {string} project
 * @param {string} path
 * @param {number} chunkIndex
 * @returns {string}
 */
export function stableChunkId(project, path, chunkIndex) {
  const key = `${project}:${path}:${chunkIndex}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * @param {import('../correlation/index.js').CorrelatedChunk} chunk
 * @param {EmbedOptions} options
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
