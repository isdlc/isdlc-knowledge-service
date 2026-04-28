// REQ-GH-3 / FR-006 — pg-boss queue adapter unit tests.
//
// Uses a fake pg-boss instance that records calls and returns canned data.
// DB-touching tests live in tests/integration/worker-pgboss.test.js (skip
// when KNOWLEDGE_DATABASE_URL is unset).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPgBossQueue } from '../../../src/queue/pgboss-queue.js';

function makeFakeBoss() {
  const calls = [];
  /** @type {Map<string, any[]>} */
  const queue = new Map();
  const completed = new Set();
  const failed = new Set();
  return {
    calls,
    queue,
    completed,
    failed,
    async send(name, data, opts) {
      calls.push({ kind: 'send', name, data, opts });
      const id = `job-${calls.length}`;
      if (!queue.has(name)) queue.set(name, []);
      queue.get(name).push({ id, name, data, state: 'created' });
      return id;
    },
    async fetch(name) {
      calls.push({ kind: 'fetch', name });
      const list = queue.get(name) || [];
      const next = list.shift();
      if (next) {
        next.state = 'active';
        return { id: next.id, data: next.data };
      }
      return null;
    },
    async complete(id, result) {
      calls.push({ kind: 'complete', id, result });
      completed.add(id);
    },
    async fail(id, payload) {
      calls.push({ kind: 'fail', id, payload });
      failed.add(id);
    },
    async getJobById(id) {
      calls.push({ kind: 'getJobById', id });
      return {
        id,
        name: 'full_rebuild',
        data: { project_id: 'p-1' },
        state: completed.has(id) ? 'completed' : failed.has(id) ? 'failed' : 'active',
        retrycount: 0,
        retrylimit: 3,
        createdon: new Date('2026-04-28T01:00:00Z'),
      };
    },
    async stop({ graceful }) {
      calls.push({ kind: 'stop', graceful });
    },
  };
}

test('createPgBossQueue rejects construction without a started boss', () => {
  assert.throws(
    () => createPgBossQueue({}),
    (err) => err.code === 'ERR-QUEUE-001' && /requires a started pg-boss/.test(err.message),
  );
});

test('enqueue rejects unknown job types', async () => {
  const boss = makeFakeBoss();
  const queue = createPgBossQueue({ boss });
  await assert.rejects(
    () => queue.enqueue('bogus', {}),
    /unknown job type/,
  );
});

test('enqueue forwards (type, payload, retryLimit) to boss.send', async () => {
  const boss = makeFakeBoss();
  const queue = createPgBossQueue({ boss, retryLimit: 5 });
  const id = await queue.enqueue('full_rebuild', { project_id: 'p-1' });
  assert.equal(id, 'job-1');
  assert.equal(boss.calls[0].kind, 'send');
  assert.equal(boss.calls[0].name, 'full_rebuild');
  assert.deepEqual(boss.calls[0].data, { project_id: 'p-1' });
  assert.equal(boss.calls[0].opts.retryLimit, 5);
});

test('dequeue() returns the first available job across known types', async () => {
  const boss = makeFakeBoss();
  await boss.send('incremental_refresh', { project_id: 'p-2' });
  const queue = createPgBossQueue({ boss });
  const job = await queue.dequeue();
  assert.ok(job);
  assert.equal(job.type, 'incremental_refresh');
  assert.deepEqual(job.payload, { project_id: 'p-2' });
});

test('dequeue() returns null when no jobs are queued', async () => {
  const boss = makeFakeBoss();
  const queue = createPgBossQueue({ boss });
  const job = await queue.dequeue();
  assert.equal(job, null);
});

test('complete forwards the id + result to boss.complete', async () => {
  const boss = makeFakeBoss();
  const queue = createPgBossQueue({ boss });
  await queue.complete('job-1', { documents: 12 });
  assert.equal(boss.calls.at(-1).kind, 'complete');
  assert.equal(boss.calls.at(-1).id, 'job-1');
  assert.deepEqual(boss.calls.at(-1).result, { documents: 12 });
  assert.ok(boss.completed.has('job-1'));
});

test('fail serialises Error instances into a structured payload', async () => {
  const boss = makeFakeBoss();
  const queue = createPgBossQueue({ boss });
  const err = new Error('embedding timeout');
  err.code = 'ERR-MODEL-001';
  await queue.fail('job-1', err);
  const last = boss.calls.at(-1);
  assert.equal(last.kind, 'fail');
  assert.equal(last.payload.message, 'embedding timeout');
  assert.equal(last.payload.code, 'ERR-MODEL-001');
  assert.ok(typeof last.payload.stack === 'string');
});

test('getStatus returns the public job shape via boss.getJobById', async () => {
  const boss = makeFakeBoss();
  const queue = createPgBossQueue({ boss });
  const status = await queue.getStatus('job-1');
  assert.equal(status.id, 'job-1');
  assert.equal(status.type, 'full_rebuild');
  assert.equal(status.status, 'active');
});

test('close() calls boss.stop({ graceful: true })', async () => {
  const boss = makeFakeBoss();
  const queue = createPgBossQueue({ boss });
  await queue.close();
  const last = boss.calls.at(-1);
  assert.equal(last.kind, 'stop');
  assert.equal(last.graceful, true);
});

test('listJobs returns [] when boss does not expose executeSql', async () => {
  const boss = makeFakeBoss();
  // No executeSql on this fake — listJobs should gracefully return empty.
  const queue = createPgBossQueue({ boss });
  assert.deepEqual(await queue.listJobs(), []);
});
