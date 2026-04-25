// Module 4: Source Connectors
// Responsibility: Pluggable crawlers producing normalised chunks.
// Implementations: GitConnector, SvnConnector, ConfluenceConnector,
//                  WebConnector, GDocsConnector, FilesystemConnector
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 4

/**
 * @typedef {object} NormalisedChunk
 * @property {string} content
 * @property {string} path
 * @property {string} source_type
 * @property {string} source_url
 * @property {string} last_modified
 * @property {object} metadata
 */

/**
 * @typedef {object} Connector
 * @property {(config: object) => Promise<NormalisedChunk[]>} crawl
 * @property {(config: object, since: string) => Promise<NormalisedChunk[]>} diff
 */

/**
 * Resolve a connector implementation by source type.
 * @param {string} type   "git" | "svn" | "confluence" | "website" | "gdocs" | "filesystem"
 * @returns {Connector}
 */
export function getConnector(type) {
  throw new Error('Not implemented — see T012-T016');
}
