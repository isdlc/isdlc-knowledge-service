// Module 10: Job Queue — public entry point.
// Responsibility: Durable async job queue. API enqueues, Worker dequeues.
// Implementation: SQLite-backed (BetterSqlite3) — see ./queue.js
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 10
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
//      ERR-QUEUE-001 (dead letter), ERR-QUEUE-002 (lock retry)
//
// Public interface (all synchronous — better-sqlite3 is sync):
//   enqueue(type, payload) -> id           (auto-generated rowid as string)
//   dequeue() -> Job | null                (atomically marks 'running')
//   complete(id, result) -> void
//   fail(id, error) -> void                (increments retries; >=3 -> 'dead')
//   getStatus(id) -> Job | null
//   listJobs(filters) -> Job[]
//
// Job types: "full_rebuild" | "incremental_refresh" | "add_content"
//
// Job record schema:
//   { id, type, payload, status, retries, max_retries: 3,
//     created_at, started_at?, completed_at?, result?, error? }

export { createQueue } from './queue.js';
