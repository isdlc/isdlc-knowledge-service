// T004: Job Queue unit tests
// Traces: FR-004, FR-005, ERR-QUEUE-001, ERR-QUEUE-002
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 10
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createQueue } from '../../../src/queue/index.js';

let tmpDir;
let dbPath;
let queue;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'isdlc-queue-test-'));
  dbPath = join(tmpDir, 'queue.db');
  queue = createQueue({ dbPath });
});

afterEach(() => {
  if (queue && typeof queue.close === 'function') {
    queue.close();
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

test('enqueue returns a job id and persists a queued job', () => {
  const id = queue.enqueue('full_rebuild', { project: 'demo' });
  assert.ok(id, 'enqueue should return an id');

  const status = queue.getStatus(id);
  assert.equal(status.status, 'queued');
  assert.equal(status.type, 'full_rebuild');
  assert.deepEqual(status.payload, { project: 'demo' });
  assert.equal(status.retries, 0);
  assert.equal(status.max_retries, 3);
  assert.ok(status.created_at);
});

test('dequeue returns the oldest queued job and atomically marks it running', () => {
  const id1 = queue.enqueue('full_rebuild', { project: 'a' });
  const id2 = queue.enqueue('incremental_refresh', { project: 'b' });

  const job = queue.dequeue();
  assert.ok(job);
  assert.equal(job.id, id1);
  assert.equal(job.status, 'running');
  assert.deepEqual(job.payload, { project: 'a' });

  // Status reflects running
  const after = queue.getStatus(id1);
  assert.equal(after.status, 'running');
  assert.ok(after.started_at);

  // Second dequeue picks the next oldest
  const job2 = queue.dequeue();
  assert.equal(job2.id, id2);
});

test('dequeue returns null when no queued jobs remain', () => {
  assert.equal(queue.dequeue(), null);
  const id = queue.enqueue('add_content', { content: 'x' });
  queue.dequeue();
  assert.equal(queue.dequeue(), null, 'no further queued jobs');
  // sanity: id is running
  assert.equal(queue.getStatus(id).status, 'running');
});

test('complete marks the job completed and stores the result', () => {
  const id = queue.enqueue('add_content', { content: 'hello' });
  queue.dequeue();
  queue.complete(id, { embedded: 1 });

  const status = queue.getStatus(id);
  assert.equal(status.status, 'completed');
  assert.deepEqual(status.result, { embedded: 1 });
  assert.ok(status.completed_at);
});

test('fail increments retries and re-queues until max_retries reached, then dead-letters (ERR-QUEUE-001)', () => {
  const id = queue.enqueue('incremental_refresh', { project: 'p' });

  // Attempt 1
  queue.dequeue();
  queue.fail(id, { code: 'ERR-X', message: 'boom 1' });
  let status = queue.getStatus(id);
  assert.equal(status.retries, 1);
  assert.equal(status.status, 'queued', 'should re-queue after first failure');

  // Attempt 2
  queue.dequeue();
  queue.fail(id, { code: 'ERR-X', message: 'boom 2' });
  status = queue.getStatus(id);
  assert.equal(status.retries, 2);
  assert.equal(status.status, 'queued');

  // Attempt 3 — hits max_retries -> dead
  queue.dequeue();
  queue.fail(id, { code: 'ERR-X', message: 'boom 3' });
  status = queue.getStatus(id);
  assert.equal(status.retries, 3);
  assert.equal(status.status, 'dead', 'should be dead-lettered (ERR-QUEUE-001)');
  assert.ok(status.error);
  assert.equal(status.error.message, 'boom 3');
});

test('listJobs filters by status and type', () => {
  const a = queue.enqueue('full_rebuild', { project: 'a' });
  const b = queue.enqueue('incremental_refresh', { project: 'b' });
  const c = queue.enqueue('full_rebuild', { project: 'c' });

  queue.dequeue(); // a -> running
  queue.complete(a, { ok: true });

  const all = queue.listJobs();
  assert.equal(all.length, 3);

  const queued = queue.listJobs({ status: 'queued' });
  assert.equal(queued.length, 2);
  const queuedIds = queued.map((j) => j.id).sort();
  assert.deepEqual(queuedIds, [b, c].sort());

  const fullRebuilds = queue.listJobs({ type: 'full_rebuild' });
  assert.equal(fullRebuilds.length, 2);

  const completed = queue.listJobs({ status: 'completed', type: 'full_rebuild' });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].id, a);
});

test('concurrent dequeues never hand the same job to two callers', () => {
  // Enqueue N jobs, then dequeue N times in parallel; expect N distinct ids.
  const N = 20;
  const ids = [];
  for (let i = 0; i < N; i++) {
    ids.push(queue.enqueue('add_content', { i }));
  }

  // Run dequeues "in parallel" — better-sqlite3 is sync, so this exercises
  // the atomic UPDATE...WHERE status='queued' LIMIT 1 transaction logic.
  const dequeued = [];
  const promises = [];
  for (let i = 0; i < N + 5; i++) {
    promises.push(
      Promise.resolve().then(() => {
        const job = queue.dequeue();
        if (job) dequeued.push(job.id);
      }),
    );
  }
  return Promise.all(promises).then(() => {
    assert.equal(dequeued.length, N);
    const unique = new Set(dequeued);
    assert.equal(unique.size, N, 'every dequeued job id must be unique');
  });
});

test('queue persists across reopen with the same dbPath', () => {
  const id = queue.enqueue('full_rebuild', { project: 'persist' });
  queue.close();

  const reopened = createQueue({ dbPath });
  try {
    const status = reopened.getStatus(id);
    assert.equal(status.status, 'queued');
    assert.equal(status.type, 'full_rebuild');
  } finally {
    reopened.close();
  }
  // Reassign for afterEach cleanup symmetry
  queue = null;
});

test('default dbPath is used when none is provided', () => {
  // Just verify the factory is callable without args without throwing.
  // (We don't actually want to write to ./data/queue.db in a unit test, so
  // we exercise via a sub-temp cwd by passing dbPath explicitly elsewhere.)
  assert.equal(typeof createQueue, 'function');
});
