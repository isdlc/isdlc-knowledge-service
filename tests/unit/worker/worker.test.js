// T019: Worker — job loop tests.
// Traces: FR-004, FR-005

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startWorker } from '../../../src/worker/index.js';

/* ------------------------------------------------------------------ */
/* Test seam: deterministic queue                                     */
/* ------------------------------------------------------------------ */

function makeQueue(jobs = []) {
  const calls = { dequeue: 0, complete: [], fail: [] };
  const remaining = [...jobs];
  return {
    dequeue() {
      calls.dequeue++;
      return remaining.shift() || null;
    },
    complete(id, result) { calls.complete.push({ id, result }); },
    fail(id, error) { calls.fail.push({ id, message: error?.message ?? String(error), code: error?.code }); },
    push(job) { remaining.push(job); },
    calls,
  };
}

function makeNoopDeps(extra = {}) {
  return {
    configStore: { async getProject() { return null; }, async addRefreshRecord() {} },
    connectorFactory: { get() { return { async *crawl() {}, async *diff() {} }; } },
    correlationEngine: { async correlate(c) { return c; } },
    pipeline: { async *embed() {} },
    vectorDbFactory: () => ({ async deleteAll() {}, async store() {}, async delete() {} }),
    modelManager: { getAdapter() { return {}; } },
    ...extra,
  };
}

function fastWait() {
  // Yield to the macrotask queue so test-driven setTimeouts can interleave.
  // A bare Promise.resolve() only yields to microtasks, which would starve
  // any setTimeout-based assertions.
  return new Promise((resolve) => setImmediate(resolve));
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

test('startWorker() throws when queue.dequeue is missing', () => {
  assert.throws(() => startWorker({ queue: {} }), /dequeue/);
});

test('startWorker() throws when queue.complete or queue.fail is missing', () => {
  assert.throws(() => startWorker({ queue: { dequeue: () => null } }), /complete|fail/);
});

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

test('worker dispatches job to handler matching job.type and calls queue.complete on success', async () => {
  const queue = makeQueue([
    { id: '1', type: 'full_rebuild', payload: { project_id: 'p1' } },
  ]);
  const handlerCalls = [];
  const w = startWorker({
    queue,
    ...makeNoopDeps(),
    handlers: {
      full_rebuild: async (payload) => {
        handlerCalls.push({ type: 'full_rebuild', payload });
        return { documents_processed: 3 };
      },
    },
    options: { wait: fastWait },
  });
  // Wait for the queue to drain (dequeue() returns null for the next call).
  await waitFor(() => queue.calls.complete.length === 1);
  await w.stop();
  assert.equal(handlerCalls.length, 1);
  assert.equal(handlerCalls[0].type, 'full_rebuild');
  assert.deepEqual(queue.calls.complete[0], { id: '1', result: { documents_processed: 3 } });
  assert.equal(queue.calls.fail.length, 0);
});

test('worker calls queue.fail when handler throws (not complete)', async () => {
  const queue = makeQueue([
    { id: '7', type: 'incremental_refresh', payload: { project_id: 'p1' } },
  ]);
  const w = startWorker({
    queue,
    ...makeNoopDeps(),
    handlers: {
      incremental_refresh: async () => {
        const err = new Error('boom');
        err.code = 'ERR-X';
        throw err;
      },
    },
    options: { wait: fastWait },
  });
  await waitFor(() => queue.calls.fail.length === 1);
  await w.stop();
  assert.equal(queue.calls.complete.length, 0);
  assert.equal(queue.calls.fail.length, 1);
  assert.equal(queue.calls.fail[0].id, '7');
  assert.match(queue.calls.fail[0].message, /boom/);
});

test('worker fails unknown job types with ERR-WORKER-001 (does not crash loop)', async () => {
  const queue = makeQueue([
    { id: '99', type: 'mystery_job', payload: {} },
    { id: '100', type: 'full_rebuild', payload: { project_id: 'p1' } },
  ]);
  const handled = [];
  const w = startWorker({
    queue,
    ...makeNoopDeps(),
    handlers: {
      full_rebuild: async () => { handled.push('rebuild'); return {}; },
    },
    options: { wait: fastWait },
  });
  await waitFor(() => queue.calls.fail.length === 1 && queue.calls.complete.length === 1);
  await w.stop();
  assert.equal(queue.calls.fail[0].code, 'ERR-WORKER-001');
  assert.equal(queue.calls.fail[0].id, '99');
  assert.equal(queue.calls.complete[0].id, '100');
  assert.deepEqual(handled, ['rebuild']);
});

/* ------------------------------------------------------------------ */
/* Loop continues after a single failure                               */
/* ------------------------------------------------------------------ */

test('worker continues to next job after a failure', async () => {
  const queue = makeQueue([
    { id: '1', type: 'full_rebuild', payload: { project_id: 'p1' } },
    { id: '2', type: 'full_rebuild', payload: { project_id: 'p2' } },
    { id: '3', type: 'full_rebuild', payload: { project_id: 'p3' } },
  ]);
  let count = 0;
  const w = startWorker({
    queue,
    ...makeNoopDeps(),
    handlers: {
      full_rebuild: async () => {
        count++;
        if (count === 2) throw new Error('mid-stream fail');
        return { documents_processed: count };
      },
    },
    options: { wait: fastWait },
  });
  await waitFor(() => queue.calls.complete.length + queue.calls.fail.length === 3);
  await w.stop();
  assert.equal(queue.calls.complete.length, 2);
  assert.equal(queue.calls.fail.length, 1);
  assert.equal(queue.calls.fail[0].id, '2');
});

/* ------------------------------------------------------------------ */
/* Graceful stop                                                       */
/* ------------------------------------------------------------------ */

test('worker.stop() resolves AFTER the in-flight job finishes', async () => {
  let release;
  const inFlight = new Promise((resolve) => { release = resolve; });
  const queue = makeQueue([
    { id: '1', type: 'full_rebuild', payload: {} },
  ]);
  let finishedHandler = false;
  const w = startWorker({
    queue,
    ...makeNoopDeps(),
    handlers: {
      full_rebuild: async () => {
        await inFlight;
        finishedHandler = true;
        return {};
      },
    },
    options: { wait: fastWait },
  });

  // Yield once so the worker enters the handler.
  await new Promise((r) => setTimeout(r, 10));
  // Initiate stop while handler is still hanging.
  const stopPromise = w.stop();
  // Stop must NOT have resolved yet.
  let stopResolved = false;
  stopPromise.then(() => { stopResolved = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(stopResolved, false, 'stop() must wait for in-flight job');
  assert.equal(finishedHandler, false);

  // Now release the handler.
  release();
  await stopPromise;
  assert.equal(finishedHandler, true, 'handler must complete before stop() resolves');
  assert.equal(queue.calls.complete.length, 1);
  assert.equal(w.running(), false);
});

test('worker.stop() returns immediately when idle', async () => {
  const queue = makeQueue([]); // no jobs
  const w = startWorker({
    queue,
    ...makeNoopDeps(),
    options: { wait: fastWait },
  });
  // Let the loop tick a few times against an empty queue.
  await new Promise((r) => setTimeout(r, 10));
  await w.stop();
  assert.equal(w.running(), false);
  assert.equal(queue.calls.complete.length, 0);
  assert.equal(queue.calls.fail.length, 0);
});

test('REQ-GH-3 AC-006-03 — worker.stop() calls queue.close() if exposed (graceful shutdown)', async () => {
  const closeCalls = { count: 0 };
  const queueWithClose = {
    ...makeQueue([]),
    async close() { closeCalls.count++; },
  };
  const w = startWorker({
    queue: queueWithClose,
    ...makeNoopDeps(),
    options: { wait: fastWait },
  });
  await new Promise((r) => setTimeout(r, 5));
  await w.stop();
  assert.equal(closeCalls.count, 1, 'queue.close() should be called once during shutdown');
});

test('worker.stop() tolerates queue.close() throwing without breaking shutdown', async () => {
  const queueWithBrokenClose = {
    ...makeQueue([]),
    async close() { throw new Error('boss already stopped'); },
  };
  const w = startWorker({
    queue: queueWithBrokenClose,
    ...makeNoopDeps(),
    options: { wait: fastWait },
  });
  await new Promise((r) => setTimeout(r, 5));
  // Must NOT throw — the worker logs and moves on.
  await w.stop();
  assert.equal(w.running(), false);
});

/* ------------------------------------------------------------------ */
/* Idle polling                                                        */
/* ------------------------------------------------------------------ */

test('worker polls when queue is empty and processes new jobs that arrive later', async () => {
  const queue = makeQueue([]);
  const handled = [];
  const w = startWorker({
    queue,
    ...makeNoopDeps(),
    handlers: {
      full_rebuild: async (payload) => { handled.push(payload.project_id); return {}; },
    },
    options: { wait: fastWait },
  });
  // Initially idle.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(handled.length, 0);
  // Push a job after start.
  queue.push({ id: '42', type: 'full_rebuild', payload: { project_id: 'late' } });
  await waitFor(() => handled.length === 1);
  await w.stop();
  assert.deepEqual(handled, ['late']);
});

/* ------------------------------------------------------------------ */
/* add_content                                                         */
/* ------------------------------------------------------------------ */

test('worker dispatches add_content via default handler (project lookup + correlate + embed + store)', async () => {
  const stored = [];
  const correlated = [];
  const queue = makeQueue([
    {
      id: '1',
      type: 'add_content',
      payload: {
        project_id: 'p1',
        content: { content: 'hello world', path: 'manual/note.md', source_type: 'direct' },
      },
    },
  ]);
  const project = {
    id: 'p1',
    sources: [],
    model_config: { type: 'local', name: 'fake' },
    vectordb_config: {},
  };
  const w = startWorker({
    queue,
    configStore: {
      async getProject(_id) { return project; },
      async addRefreshRecord() {},
    },
    connectorFactory: { get() { return { async *crawl() {}, async *diff() {} }; } },
    correlationEngine: {
      async correlate(chunks) {
        correlated.push(chunks.map((c) => c.path));
        return chunks.map((c) => ({ ...c, related: [] }));
      },
    },
    pipeline: {
      async *embed(chunks) {
        for (const c of chunks) yield {
          id: `id-${c.path}`,
          vector: [1],
          content: c.content,
          metadata: { path: c.path, source_type: c.source_type, source_url: '', project: 'p1', chunk_index: 0, sub_chunk_start: 0, sub_chunk_end: c.content.length },
          related_sources: [],
        };
      },
    },
    vectorDbFactory: () => ({
      async deleteAll() {},
      async store(batch) { stored.push(batch.map((b) => b.id)); },
      async delete() {},
    }),
    modelManager: { getAdapter: () => ({}) },
    options: { wait: fastWait },
  });
  await waitFor(() => queue.calls.complete.length === 1);
  await w.stop();
  assert.equal(queue.calls.complete.length, 1);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0], ['id-manual/note.md']);
  assert.deepEqual(correlated, [['manual/note.md']]);
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
