// Module 10: Job Queue
// Responsibility: Durable async job queue. API enqueues, Worker dequeues.
// Implementation: SQLite-backed (BetterSqlite3)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 10
// Schema: docs/architecture/data-model.md §3.1

/**
 * @typedef {"queued"|"running"|"completed"|"failed"|"dead"} JobStatus
 */

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {"full_rebuild"|"incremental_refresh"|"add_content"} type
 * @property {object} payload
 * @property {JobStatus} status
 * @property {number} attempts
 * @property {string} enqueued_at
 */

/**
 * @param {string} type
 * @param {object} payload
 * @returns {Promise<string>}  Job ID
 */
export async function enqueue(type, payload) {
  throw new Error('Not implemented — see T004');
}

/** @returns {Promise<Job|null>} */
export async function dequeue() {
  throw new Error('Not implemented — see T004');
}

/** @param {string} id @param {object} result */
export async function complete(id, result) {
  throw new Error('Not implemented — see T004');
}

/** @param {string} id @param {{ code: string, message: string }} error */
export async function fail(id, error) {
  throw new Error('Not implemented — see T004');
}

/** @param {string} id @returns {Promise<Job|null>} */
export async function getStatus(id) {
  throw new Error('Not implemented — see T004');
}

/** @param {object} filters @returns {Promise<Job[]>} */
export async function listJobs(filters) {
  throw new Error('Not implemented — see T004');
}
