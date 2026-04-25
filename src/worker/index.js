// Module 3: Worker
// Responsibility: Process jobs — full rebuilds, incremental refreshes, add_content.
// Job types: full_rebuild, incremental_refresh, add_content
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 3

/**
 * Start the Worker process (job loop).
 * @param {object} config
 * @returns {Promise<void>}
 */
export async function startWorker(config) {
  throw new Error('Not implemented — see T019');
}
