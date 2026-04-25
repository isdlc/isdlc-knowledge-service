// Unit tests for Module 13: Audit Logger
// Traces: FR-014 (AC-014-01..05)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 13
//      docs/requirements/REQ-GH-263-.../interface-spec.md §AuditEntry

import { test, beforeEach, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as auditNamespace from '../../../src/audit/index.js';
import { createAuditLogger } from '../../../src/audit/logger.js';

let workDir;
let logFile;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'audit-test-'));
  logFile = path.join(workDir, 'audit.jsonl');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC-014-04: Append-only — no mutation API exists (verified by inspection)
// ---------------------------------------------------------------------------
describe('append-only contract (AC-014-04)', () => {
  test('module exports do not contain any mutation methods', () => {
    // Allowlist: only these names may be exported. Future additions of
    // delete/update/truncate/remove/clear cannot sneak in.
    const allowedExports = new Set([
      'log',
      'query',
      'createAuditLogger',
      'default',
    ]);

    const exportedKeys = Object.keys(auditNamespace);
    for (const key of exportedKeys) {
      assert.ok(
         allowedExports.has(key),
        `Disallowed export "${key}" on src/audit/index.js — append-only contract violated`,
      );
    }

    // Explicit denial of mutation names
    const forbidden = ['delete', 'update', 'truncate', 'remove', 'clear', 'erase', 'modify'];
    for (const name of forbidden) {
      assert.equal(
         auditNamespace[name],
        undefined,
        `Module must not export "${name}" (mutation API forbidden)`,
      );
    }
  });

  test('factory instance does not expose mutation methods', () => {
    const logger = createAuditLogger({ path: logFile });
    const instanceKeys = Object.keys(logger);
    const allowed = new Set(['log', 'query']);
    for (const key of instanceKeys) {
      assert.ok(
         allowed.has(key),
        `Disallowed method "${key}" on logger instance`,
      );
    }
    const forbidden = ['delete', 'update', 'truncate', 'remove', 'clear'];
    for (const name of forbidden) {
      assert.equal(logger[name], undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-014-01, AC-014-02: log() appends entries with timestamp + action + details
// ---------------------------------------------------------------------------
describe('log() — append (AC-014-01, AC-014-02)', () => {
  test('appends entry with auto-generated ISO-8601 timestamp', async () => {
    const logger = createAuditLogger({ path: logFile });
    await logger.log('project.created', { id: 'payments-2.7', name: 'Payments' });

    const raw = await readFile(logFile, 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1);

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.action, 'project.created');
    assert.deepEqual(entry.details, { id: 'payments-2.7', name: 'Payments' });
    assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  });

  test('records optional ip_address and project_id', async () => {
    const logger = createAuditLogger({ path: logFile });
    await logger.log('refresh.triggered', {
      project_id: 'payments-2.7',
      changed_count: 5,
      ip_address: '192.168.1.100',
    });

    const raw = await readFile(logFile, 'utf8');
    const entry = JSON.parse(raw.trim());
    assert.equal(entry.project_id, 'payments-2.7');
    assert.equal(entry.ip_address, '192.168.1.100');
    assert.equal(entry.details.changed_count, 5);
  });

  test('writes JSONL — one valid JSON object per line, no array wrapper', async () => {
    const logger = createAuditLogger({ path: logFile });
    await logger.log('a', { n: 1 });
    await logger.log('b', { n: 2 });
    await logger.log('c', { n: 3 });

    const raw = await readFile(logFile, 'utf8');
    assert.ok(!raw.startsWith('['), 'must not be a JSON array');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 3);
    for (const line of lines) {
      const obj = JSON.parse(line);
      assert.ok(obj.timestamp);
      assert.ok(obj.action);
    }
  });

  test('creates the data directory if missing', async () => {
    const nested = path.join(workDir, 'deeply', 'nested', 'audit.jsonl');
    const logger = createAuditLogger({ path: nested });
    await logger.log('test', {});
    const raw = await readFile(nested, 'utf8');
    assert.ok(raw.length > 0);
  });
});

// ---------------------------------------------------------------------------
// AC-014-03: query() with filters — project, action, time range, limit, offset
// ---------------------------------------------------------------------------
describe('query() — filters (AC-014-03)', () => {
  async function seed(logger) {
    await logger.log('project.created', { project_id: 'a', name: 'A' });
    await logger.log('project.updated', { project_id: 'a', change: 'desc' });
    await logger.log('project.created', { project_id: 'b', name: 'B' });
    await logger.log('refresh.triggered', { project_id: 'a', changed_count: 2 });
    await logger.log('refresh.triggered', { project_id: 'b', changed_count: 5 });
  }

  test('returns all entries with no filters', async () => {
    const logger = createAuditLogger({ path: logFile });
    await seed(logger);
    const all = await logger.query({});
    assert.equal(all.length, 5);
  });

  test('filters by project_id', async () => {
    const logger = createAuditLogger({ path: logFile });
    await seed(logger);
    const aOnly = await logger.query({ project: 'a' });
    assert.equal(aOnly.length, 3);
    for (const e of aOnly) {
      assert.equal(e.project_id, 'a');
    }
  });

  test('filters by action', async () => {
    const logger = createAuditLogger({ path: logFile });
    await seed(logger);
    const refreshes = await logger.query({ action: 'refresh.triggered' });
    assert.equal(refreshes.length, 2);
    for (const e of refreshes) assert.equal(e.action, 'refresh.triggered');
  });

  test('filters by time range (from/to inclusive)', async () => {
    // Seed entries with controlled timestamps by writing directly
    const entries = [
      { timestamp: '2026-04-01T00:00:00.000Z', action: 'x', details: {} },
      { timestamp: '2026-04-15T00:00:00.000Z', action: 'y', details: {} },
      { timestamp: '2026-04-30T00:00:00.000Z', action: 'z', details: {} },
    ];
    await writeFile(
      logFile,
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );
    const logger = createAuditLogger({ path: logFile });

    const between = await logger.query({
      from: '2026-04-10T00:00:00.000Z',
      to: '2026-04-20T00:00:00.000Z',
    });
    assert.equal(between.length, 1);
    assert.equal(between[0].action, 'y');

    const fromOnly = await logger.query({ from: '2026-04-15T00:00:00.000Z' });
    assert.equal(fromOnly.length, 2);

    const toOnly = await logger.query({ to: '2026-04-15T00:00:00.000Z' });
    assert.equal(toOnly.length, 2);
  });

  test('limit and offset paginate results', async () => {
    const logger = createAuditLogger({ path: logFile });
    for (let i = 0; i < 10; i++) {
      await logger.log('paged', { n: i });
    }

    const page1 = await logger.query({ limit: 3 });
    assert.equal(page1.length, 3);
    assert.equal(page1[0].details.n, 0);

    const page2 = await logger.query({ limit: 3, offset: 3 });
    assert.equal(page2.length, 3);
    assert.equal(page2[0].details.n, 3);

    const tail = await logger.query({ limit: 100, offset: 8 });
    assert.equal(tail.length, 2);
  });

  test('combines multiple filters', async () => {
    const logger = createAuditLogger({ path: logFile });
    await seed(logger);
    const r = await logger.query({ project: 'a', action: 'refresh.triggered' });
    assert.equal(r.length, 1);
    assert.equal(r[0].details.changed_count, 2);
  });

  test('returns empty array when log file does not exist', async () => {
    const logger = createAuditLogger({ path: logFile });
    const out = await logger.query({});
    assert.deepEqual(out, []);
  });
});

// ---------------------------------------------------------------------------
// AC-014-05: rotation when size exceeds configured threshold
// ---------------------------------------------------------------------------
describe('rotation (AC-014-05)', () => {
  test('rotates the log file when size exceeds threshold', async () => {
    // Tiny threshold to force rotation deterministically
    const logger = createAuditLogger({ path: logFile, maxSize: 200 });

    // Write enough entries to trip the threshold
    for (let i = 0; i < 20; i++) {
      await logger.log('event', { idx: i, payload: 'x'.repeat(20) });
    }

    const files = (await readdir(workDir)).sort();
    // Expect at least one rotated file (any name starting with audit. and ending .jsonl,
    // other than the live file).
    const rotated = files.filter(
      (f) => f.startsWith('audit.') && f.endsWith('.jsonl') && f !== 'audit.jsonl',
    );
    assert.ok(rotated.length >= 1, `expected rotated file, got: ${files.join(',')}`);

    // Live file exists with most recent entries
    const liveStat = await stat(logFile).catch(() => null);
    assert.ok(liveStat, `live audit.jsonl must exist after rotation; files: ${files.join(',')}`);

    // Rotated files are NOT deleted by the logger
    for (const r of rotated) {
      const s = await stat(path.join(workDir, r));
      assert.ok(s.size > 0, `rotated file ${r} must be preserved`);
    }
  });

  test('rotated file name matches audit.{ISO}.jsonl pattern', async () => {
    const logger = createAuditLogger({ path: logFile, maxSize: 100 });
    for (let i = 0; i < 15; i++) {
      await logger.log('event', { idx: i, blob: 'y'.repeat(10) });
    }
    const files = await readdir(workDir);
    const rotated = files.find(
      (f) => f.startsWith('audit.') && f.endsWith('.jsonl') && f !== 'audit.jsonl',
    );
    assert.ok(rotated, 'no rotated file found');
    // Filename: audit.<ISO-8601-with-colons-replaced>.jsonl
    // ISO-8601 format with ms: 2026-04-25T13-54-46.996Z (colons replaced with hyphens,
    // milliseconds preserved with '.'). Optional `-N` suffix for sub-ms disambiguation.
    assert.match(
      rotated,
      /^audit\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d+)?Z(?:-\d+)?\.jsonl$/,
    );
  });

  test('query reads only the live file (rotated entries are archived)', async () => {
    const logger = createAuditLogger({ path: logFile, maxSize: 150 });
    for (let i = 0; i < 12; i++) {
      await logger.log('e', { i, blob: 'z'.repeat(15) });
    }
    // Add a clearly identifiable post-rotation marker
    await logger.log('post', { marker: true });

    const live = await logger.query({ action: 'post' });
    assert.equal(live.length, 1);
    assert.equal(live[0].details.marker, true);
  });
});

// ---------------------------------------------------------------------------
// Concurrency: parallel appends preserve all entries with valid JSONL
// ---------------------------------------------------------------------------
describe('concurrent appends', () => {
  test('parallel log() calls preserve all entries without corruption', async () => {
    const logger = createAuditLogger({ path: logFile });
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        logger.log('parallel', { idx: i, payload: 'p'.repeat(10) }),
      ),
    );

    const raw = await readFile(logFile, 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, N, `expected ${N} lines, got ${lines.length}`);

    const seenIdx = new Set();
    for (const line of lines) {
      const obj = JSON.parse(line); // throws on corruption
      assert.equal(obj.action, 'parallel');
      seenIdx.add(obj.details.idx);
    }
    assert.equal(seenIdx.size, N, 'every parallel log entry must be persisted exactly once');
  });

  test('parallel appends across rotation preserve all entries', async () => {
    const logger = createAuditLogger({ path: logFile, maxSize: 300 });
    const N = 30;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        logger.log('rotparallel', { idx: i, blob: 'q'.repeat(15) }),
      ),
    );

    // Sum entries across live + rotated files
    const files = await readdir(workDir);
    let total = 0;
    const seen = new Set();
    for (const f of files) {
      const raw = await readFile(path.join(workDir, f), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line);
        if (obj.action === 'rotparallel') {
          total++;
          seen.add(obj.details.idx);
        }
      }
    }
    assert.equal(total, N, `expected ${N} entries across files, got ${total}`);
    assert.equal(seen.size, N, 'every entry preserved exactly once across rotation');
  });
});

// ---------------------------------------------------------------------------
// Default-path module-level API (index.js singleton convenience)
// ---------------------------------------------------------------------------
describe('module-level log/query (index.js)', () => {
  test('exports log and query as functions', () => {
    assert.equal(typeof auditNamespace.log, 'function');
    assert.equal(typeof auditNamespace.query, 'function');
    assert.equal(typeof auditNamespace.createAuditLogger, 'function');
  });
});
