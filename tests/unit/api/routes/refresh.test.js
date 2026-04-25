// Unit tests for src/api/routes/refresh.js
// Traces: FR-004 (AC-004-01..04), FR-014 (audit log)
// See: docs/requirements/REQ-GH-263-.../interface-spec.md POST /api/refresh

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRefreshRoutes } from '../../../../src/api/routes/refresh.js';

let deps;
let auditCalls;
let enqueueCalls;

function fakeReq() {
  return { socket: { remoteAddress: '10.0.0.1' }, headers: {} };
}

beforeEach(() => {
  auditCalls = [];
  enqueueCalls = [];
  deps = {
    configStore: {
      listProjects: async () => [
        {
          id: 'payments-2.7',
          name: 'Payments',
          version: '2.7',
          sources: [
            { type: 'git', url: 'git.example.com/payments', repo_id: 'org/payments' },
          ],
        },
      ],
    },
    queue: {
      enqueue: (type, payload) => {
        enqueueCalls.push({ type, payload });
        return 'job-42';
      },
    },
    auditLogger: {
      log: async (action, details) => {
        auditCalls.push({ action, details });
      },
    },
  };
});

function getHandler() {
  const routes = createRefreshRoutes(deps);
  const r = routes.find((x) => x.method === 'POST' && x.pattern === '/api/refresh');
  assert.ok(r, 'POST /api/refresh route must be registered');
  return r.handle;
}

describe('POST /api/refresh — happy path (FR-004)', () => {
  test('enqueues incremental_refresh job and returns 200 with job_id', async () => {
    const handle = getHandler();
    const result = await handle(
      fakeReq(),
      {
        source_type: 'git',
        repo_id: 'org/payments',
        changes: [{ path: 'src/foo.js', action: 'modified' }],
      },
      deps,
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'queued');
    assert.equal(result.body.job_id, 'job-42');
    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0].type, 'incremental_refresh');
    assert.equal(enqueueCalls[0].payload.project_id, 'payments-2.7');
    assert.equal(enqueueCalls[0].payload.changes.length, 1);
  });

  test('audit-logs the refresh trigger (FR-014 / AC-014-02)', async () => {
    const handle = getHandler();
    await handle(
      fakeReq(),
      { source_type: 'git', repo_id: 'org/payments', changes: [{ path: 'a.js', action: 'modified' }] },
      deps,
    );
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0].action, 'refresh.triggered');
    assert.equal(auditCalls[0].details.project_id, 'payments-2.7');
    assert.equal(auditCalls[0].details.repo_id, 'org/payments');
    assert.equal(auditCalls[0].details.change_count, 1);
    assert.equal(auditCalls[0].details.ip_address, '10.0.0.1');
  });

  test('matches by source.url when repo_id is not present on source', async () => {
    deps.configStore.listProjects = async () => [
      {
        id: 'orders-1.0',
        sources: [{ type: 'git', url: 'git.example.com/orders' }],
      },
    ];
    const handle = getHandler();
    const result = await handle(
      fakeReq(),
      { source_type: 'git', repo_id: 'git.example.com/orders', changes: [] },
      deps,
    );
    assert.equal(result.status, 200);
    assert.equal(enqueueCalls[0].payload.project_id, 'orders-1.0');
  });
});

describe('POST /api/refresh — validation (400)', () => {
  test('400 when body is missing', async () => {
    const handle = getHandler();
    const result = await handle(fakeReq(), null, deps);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'INVALID_REQUEST');
  });

  test('400 when source_type is invalid', async () => {
    const handle = getHandler();
    const result = await handle(
      fakeReq(),
      { source_type: 'tfs', repo_id: 'r', changes: [] },
      deps,
    );
    assert.equal(result.status, 400);
    assert.match(result.body.message, /source_type/);
  });

  test('400 when repo_id is missing', async () => {
    const handle = getHandler();
    const result = await handle(
      fakeReq(),
      { source_type: 'git', changes: [] },
      deps,
    );
    assert.equal(result.status, 400);
    assert.match(result.body.message, /repo_id/);
  });

  test('400 when changes is not an array', async () => {
    const handle = getHandler();
    const result = await handle(
      fakeReq(),
      { source_type: 'git', repo_id: 'org/x', changes: 'oops' },
      deps,
    );
    assert.equal(result.status, 400);
    assert.match(result.body.message, /changes/);
  });

  test('400 when a change is missing path/action', async () => {
    const handle = getHandler();
    const result = await handle(
      fakeReq(),
      { source_type: 'git', repo_id: 'org/x', changes: [{ path: 'a.js' }] },
      deps,
    );
    assert.equal(result.status, 400);
  });

  test('does not enqueue or audit on validation failure', async () => {
    const handle = getHandler();
    await handle(fakeReq(), null, deps);
    assert.equal(enqueueCalls.length, 0);
    assert.equal(auditCalls.length, 0);
  });
});

describe('POST /api/refresh — unknown repo (404)', () => {
  test('404 when no project references the repo', async () => {
    const handle = getHandler();
    const result = await handle(
      fakeReq(),
      { source_type: 'git', repo_id: 'org/unknown', changes: [] },
      deps,
    );
    assert.equal(result.status, 404);
    assert.equal(result.body.error, 'PROJECT_NOT_FOUND');
    assert.equal(enqueueCalls.length, 0);
    assert.equal(auditCalls.length, 0);
  });

  test('404 when source_type does not match (git vs svn)', async () => {
    const handle = getHandler();
    const result = await handle(
      fakeReq(),
      { source_type: 'svn', repo_id: 'org/payments', changes: [] },
      deps,
    );
    assert.equal(result.status, 404);
  });
});

describe('POST /api/refresh — IP capture from x-forwarded-for', () => {
  test('uses x-forwarded-for when present', async () => {
    const handle = getHandler();
    const req = { socket: { remoteAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } };
    await handle(req, { source_type: 'git', repo_id: 'org/payments', changes: [] }, deps);
    assert.equal(auditCalls[0].details.ip_address, '203.0.113.7');
  });
});
