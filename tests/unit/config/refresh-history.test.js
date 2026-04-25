// Unit tests for refresh history (T003 / FR-001, FR-007 AC-007-05)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 11
// Shape: docs/requirements/REQ-GH-263-.../interface-spec.md RefreshRecord
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectStore } from '../../../src/config/project-store.js';
import { createRefreshHistoryStore } from '../../../src/config/refresh-history.js';

let dataDir;
let projects;
let history;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'kn-history-'));
  projects = createProjectStore({ dataDir });
  history = createRefreshHistoryStore({ dataDir });

  await projects.createProject({
    name: 'Payments',
    version: '2.7',
    sources: [],
    model_config: {},
    vectordb_config: {},
  });
});

afterEach(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('addRefreshRecord + getRefreshHistory', () => {
  test('appends a record and persists it to refresh-history.json', async () => {
    const record = {
      timestamp: '2026-04-25T10:00:00Z',
      type: 'incremental',
      trigger_source: 'github-actions',
      duration_seconds: 45,
      documents_processed: 12,
      status: 'success',
      error: null,
    };
    await history.addRefreshRecord('payments-2.7', record);

    const got = await history.getRefreshHistory('payments-2.7');
    assert.equal(got.length, 1);
    assert.deepEqual(got[0], record);

    const onDisk = JSON.parse(
      await readFile(
        join(dataDir, 'projects', 'payments-2.7', 'refresh-history.json'),
        'utf8',
      ),
    );
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].trigger_source, 'github-actions');
  });

  test('returns empty history for a project with none yet', async () => {
    const got = await history.getRefreshHistory('payments-2.7');
    assert.deepEqual(got, []);
  });

  test('latest record is at index 0 (most recent first)', async () => {
    await history.addRefreshRecord('payments-2.7', {
      timestamp: '2026-04-25T10:00:00Z',
      type: 'incremental',
      trigger_source: 'github-actions',
      duration_seconds: 10,
      documents_processed: 1,
      status: 'success',
      error: null,
    });
    await history.addRefreshRecord('payments-2.7', {
      timestamp: '2026-04-25T11:00:00Z',
      type: 'full',
      trigger_source: 'web-ui',
      duration_seconds: 200,
      documents_processed: 50,
      status: 'success',
      error: null,
    });

    const got = await history.getRefreshHistory('payments-2.7');
    assert.equal(got.length, 2);
    assert.equal(got[0].trigger_source, 'web-ui'); // latest first
    assert.equal(got[1].trigger_source, 'github-actions');
  });

  test('rejects unknown project id with INVALID_PROJECT', async () => {
    await assert.rejects(
      () => history.addRefreshRecord('does-not-exist', {
        timestamp: '2026-04-25T10:00:00Z',
        type: 'full',
        trigger_source: 'web-ui',
        duration_seconds: 1,
        documents_processed: 0,
        status: 'success',
        error: null,
      }),
      (err) => err.code === 'INVALID_PROJECT',
    );

    await assert.rejects(
      () => history.getRefreshHistory('does-not-exist'),
      (err) => err.code === 'INVALID_PROJECT',
    );
  });

  test('records a failed refresh with error string', async () => {
    await history.addRefreshRecord('payments-2.7', {
      timestamp: '2026-04-25T12:00:00Z',
      type: 'incremental',
      trigger_source: 'jenkins',
      duration_seconds: 5,
      documents_processed: 0,
      status: 'failed',
      error: 'Connector unreachable',
    });
    const [latest] = await history.getRefreshHistory('payments-2.7');
    assert.equal(latest.status, 'failed');
    assert.equal(latest.error, 'Connector unreachable');
  });
});

describe('rotation', () => {
  test('caps history at 100 entries; oldest evicted, newest retained', async () => {
    for (let i = 0; i < 105; i++) {
      await history.addRefreshRecord('payments-2.7', {
        timestamp: `2026-04-25T10:${String(i).padStart(2, '0')}:00Z`,
        type: 'incremental',
        trigger_source: 'github-actions',
        duration_seconds: i,
        documents_processed: i,
        status: 'success',
        error: null,
      });
    }

    const got = await history.getRefreshHistory('payments-2.7');
    assert.equal(got.length, 100, 'history must be capped at 100');

    // Latest record (index 0) is the most recent (i=104).
    assert.equal(got[0].duration_seconds, 104);
    // Oldest retained record (index 99) should be the 6th insertion (i=5).
    // i=0..4 were evicted (5 entries), i=5..104 retained (100 entries).
    assert.equal(got[99].duration_seconds, 5);
  });

  test('latest record is preserved across many appends', async () => {
    for (let i = 0; i < 200; i++) {
      await history.addRefreshRecord('payments-2.7', {
        timestamp: new Date(Date.UTC(2026, 3, 25, 10, 0, i)).toISOString(),
        type: 'incremental',
        trigger_source: 'github-actions',
        duration_seconds: i,
        documents_processed: 1,
        status: 'success',
        error: null,
      });
    }
    const got = await history.getRefreshHistory('payments-2.7');
    assert.equal(got.length, 100);
    assert.equal(got[0].duration_seconds, 199);
  });
});
