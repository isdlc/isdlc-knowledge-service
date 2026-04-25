// T012: Source Connector — abstract interface.
// Traces: FR-003 (AC-003-01, AC-003-07)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 4
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
//
// This module defines the contract every concrete connector (Git, SVN,
// Confluence, Web, GDocs, Filesystem) must satisfy. Connectors yield
// NormalisedChunk objects via async generators so large sources can be
// processed in a streaming fashion without materialising every chunk in
// memory at once.

/**
 * @typedef {object} NormalisedChunk
 * @property {string} content       Raw textual content of the chunk.
 * @property {string} path          Logical path inside the source (e.g. "src/foo.ts").
 * @property {string} source_type   Connector identifier ("git" | "svn" | …).
 * @property {string} source_url    Stable URL identifying this chunk in its source.
 * @property {string} last_modified ISO-8601 timestamp of the last modification.
 * @property {object} metadata      Connector-specific metadata bag.
 */

/**
 * @typedef {object} DiffEntry
 * @property {NormalisedChunk} chunk
 * @property {"add"|"modify"|"delete"} action
 */

/**
 * Errors thrown by connectors carry a stable code drawn from the error
 * taxonomy so the worker / API can degrade gracefully and surface a
 * meaningful message in the refresh history.
 *
 * Codes used by connectors:
 *   ERR-CONN-001  Source unreachable (network failure, repo not found, …).
 *   ERR-CONN-002  Authentication failed (invalid creds / expired token).
 */
export class ConnectorError extends Error {
  /**
   * @param {string} code     Stable taxonomy code (e.g. "ERR-CONN-001").
   * @param {string} message  Human-readable description.
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ConnectorError';
    this.code = code;
    if (options.cause !== undefined && this.cause === undefined) {
      // Older Node versions (<16.9) ignore the second arg; assign explicitly
      // so the cause is always discoverable.
      this.cause = options.cause;
    }
  }
}

/**
 * Abstract base class for all source connectors. Direct instantiation is
 * forbidden; subclasses must override both `crawl` and `diff`.
 *
 * Subclasses must implement:
 *   crawl(config)            -> AsyncIterable<NormalisedChunk>
 *   diff(config, since)      -> AsyncIterable<DiffEntry>
 *
 * Returning async generators (rather than arrays) keeps memory bounded for
 * large sources — the embedding pipeline can pull chunks one at a time.
 */
export class SourceConnector {
  constructor() {
    if (new.target === SourceConnector) {
      throw new Error(
        'SourceConnector is abstract — instantiate a concrete subclass instead',
      );
    }
  }

  /**
   * Full crawl. Concrete subclasses override.
   * @param {object} _config
   * @returns {AsyncIterable<NormalisedChunk>}
   */
  // eslint-disable-next-line require-yield, no-unused-vars
  async *crawl(_config) {
    throw new Error('SourceConnector.crawl() not implemented — abstract method');
  }

  /**
   * Incremental diff since a previous revision marker.
   * @param {object} _config
   * @param {string} _since   Connector-specific revision marker.
   * @returns {AsyncIterable<DiffEntry>}
   */
  // eslint-disable-next-line require-yield, no-unused-vars
  async *diff(_config, _since) {
    throw new Error('SourceConnector.diff() not implemented — abstract method');
  }
}
