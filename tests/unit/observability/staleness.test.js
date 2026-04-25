// Unit tests for staleness detection (T030 / FR-015 AC-015-05, AC-015-06)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 14
//
// Pure-function semantics: computeProjectStaleness(projectConfig, refreshHistory, currentSourceState, opts?)
// Inputs:
//   projectConfig       — { id, sources: [{ type, url, ... }], ... }
//   refreshHistory      — array of RefreshRecord, latest first (index 0).
//                         Records may carry `per_source` map with last-indexed
//                         { revision, indexed_at } per source URL; if not, the
//                         record's `timestamp` is used as last-indexed time
//                         for all sources (legacy behaviour).
//   currentSourceState  — { [source_url]: { revision: string, modified_at: ISO } }
// Output:
//   { project_id, badge, reasons[], staleness_seconds,
//     per_source: [{ source_url, last_indexed, current_revision, drift_seconds, badge }] }

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeProjectStaleness } from '../../../src/observability/staleness.js';

const NOW = new Date('2026-04-25T12:00:00Z');
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60_000).toISOString();
const hoursAgo = (n) => new Date(NOW.getTime() - n * 3_600_000).toISOString();

const baseProject = {
  id: 'payments-2.7',
  name: 'Payments',
  version: '2.7',
  sources: [
    { type: 'git', url: 'git.company.com/payments' },
    { type: 'confluence', url: 'confluence.company.com/PAY27' },
  ],
};

describe('computeProjectStaleness — fresh', () => {
  test('returns badge=fresh when all sources within 1h drift (per-source records)', () => {
    const refreshHistory = [
      {
        timestamp: minutesAgo(10),
        type: 'incremental',
        trigger_source: 'github-actions',
        duration_seconds: 5,
        documents_processed: 1,
        status: 'success',
        error: null,
        per_source: {
          'git.company.com/payments': { revision: 'abc123', indexed_at: minutesAgo(10) },
          'confluence.company.com/PAY27': { revision: 'v42', indexed_at: minutesAgo(10) },
        },
      },
    ];
    const currentSourceState = {
      'git.company.com/payments': { revision: 'abc123', modified_at: minutesAgo(15) },
      'confluence.company.com/PAY27': { revision: 'v42', modified_at: minutesAgo(20) },
    };

    const r = computeProjectStaleness(baseProject, refreshHistory, currentSourceState, { now: NOW });
    assert.equal(r.project_id, 'payments-2.7');
    assert.equal(r.badge, 'fresh');
    assert.deepEqual(r.reasons, []);
    assert.equal(r.per_source.length, 2);
    assert.ok(r.per_source.every((s) => s.badge === 'fresh'));
    assert.ok(r.staleness_seconds < 3600);
  });

  test('falls back to record.timestamp when per_source is absent', () => {
    const refreshHistory = [
      {
        timestamp: minutesAgo(30),
        type: 'full',
        trigger_source: 'web-ui',
        duration_seconds: 90,
        documents_processed: 50,
        status: 'success',
        error: null,
      },
    ];
    const currentSourceState = {
      'git.company.com/payments': { revision: 'abc', modified_at: minutesAgo(40) },
      'confluence.company.com/PAY27': { revision: 'v', modified_at: minutesAgo(45) },
    };
    const r = computeProjectStaleness(baseProject, refreshHistory, currentSourceState, { now: NOW });
    assert.equal(r.badge, 'fresh');
    assert.equal(r.per_source.length, 2);
    for (const s of r.per_source) {
      assert.equal(s.last_indexed, refreshHistory[0].timestamp);
      assert.ok(s.drift_seconds >= 0);
    }
  });
});

describe('computeProjectStaleness — stale', () => {
  test('returns badge=stale when any source exceeds 1h drift', () => {
    const refreshHistory = [
      {
        timestamp: hoursAgo(3),
        type: 'incremental',
        trigger_source: 'github-actions',
        duration_seconds: 5,
        documents_processed: 1,
        status: 'success',
        error: null,
        per_source: {
          'git.company.com/payments': { revision: 'old', indexed_at: hoursAgo(3) },
          'confluence.company.com/PAY27': { revision: 'v42', indexed_at: minutesAgo(15) },
        },
      },
    ];
    const currentSourceState = {
      'git.company.com/payments': { revision: 'new', modified_at: minutesAgo(30) },
      'confluence.company.com/PAY27': { revision: 'v42', modified_at: minutesAgo(20) },
    };
    const r = computeProjectStaleness(baseProject, refreshHistory, currentSourceState, { now: NOW });
    assert.equal(r.badge, 'stale');
    assert.ok(r.reasons.length >= 1);
    const git = r.per_source.find((s) => s.source_url === 'git.company.com/payments');
    const conf = r.per_source.find((s) => s.source_url === 'confluence.company.com/PAY27');
    assert.equal(git.badge, 'stale');
    assert.equal(conf.badge, 'fresh');
    assert.ok(r.staleness_seconds >= 3600);
  });

  test('aggregates to max severity across sources (one stale -> project stale)', () => {
    const refreshHistory = [
      {
        timestamp: minutesAgo(10),
        type: 'incremental',
        trigger_source: 'github-actions',
        duration_seconds: 5,
        documents_processed: 1,
        status: 'success',
        error: null,
        per_source: {
          'git.company.com/payments': { revision: 'r1', indexed_at: minutesAgo(10) },
          'confluence.company.com/PAY27': { revision: 'old', indexed_at: hoursAgo(2) },
        },
      },
    ];
    const currentSourceState = {
      'git.company.com/payments': { revision: 'r1', modified_at: minutesAgo(20) },
      'confluence.company.com/PAY27': { revision: 'new', modified_at: minutesAgo(5) },
    };
    const r = computeProjectStaleness(baseProject, refreshHistory, currentSourceState, { now: NOW });
    assert.equal(r.badge, 'stale');
  });

  test('flags revision mismatch as a stale reason regardless of drift duration', () => {
    const refreshHistory = [
      {
        timestamp: minutesAgo(5),
        type: 'incremental',
        trigger_source: 'github-actions',
        duration_seconds: 1,
        documents_processed: 0,
        status: 'success',
        error: null,
        per_source: {
          'git.company.com/payments': { revision: 'abc', indexed_at: minutesAgo(5) },
          'confluence.company.com/PAY27': { revision: 'v1', indexed_at: minutesAgo(5) },
        },
      },
    ];
    const currentSourceState = {
      // Same urls, but git revision moved forward; confluence unchanged.
      'git.company.com/payments': { revision: 'def', modified_at: minutesAgo(2) },
      'confluence.company.com/PAY27': { revision: 'v1', modified_at: minutesAgo(10) },
    };
    const r = computeProjectStaleness(baseProject, refreshHistory, currentSourceState, { now: NOW });
    assert.equal(r.badge, 'stale');
    const git = r.per_source.find((s) => s.source_url === 'git.company.com/payments');
    assert.equal(git.badge, 'stale');
    assert.ok(r.reasons.some((x) => /revision.*git/i.test(x)));
  });

  test('honours custom staleSeconds threshold', () => {
    const refreshHistory = [
      {
        timestamp: minutesAgo(40),
        type: 'incremental',
        trigger_source: 'github-actions',
        duration_seconds: 1,
        documents_processed: 0,
        status: 'success',
        error: null,
        per_source: {
          'git.company.com/payments': { revision: 'r', indexed_at: minutesAgo(40) },
          'confluence.company.com/PAY27': { revision: 'v', indexed_at: minutesAgo(40) },
        },
      },
    ];
    const currentSourceState = {
      'git.company.com/payments': { revision: 'r', modified_at: minutesAgo(50) },
      'confluence.company.com/PAY27': { revision: 'v', modified_at: minutesAgo(60) },
    };
    // Default threshold (3600s) -> fresh. Override to 30 min -> stale.
    const def = computeProjectStaleness(baseProject, refreshHistory, currentSourceState, { now: NOW });
    assert.equal(def.badge, 'fresh');
    const tight = computeProjectStaleness(baseProject, refreshHistory, currentSourceState, {
      now: NOW,
      staleSeconds: 30 * 60,
    });
    assert.equal(tight.badge, 'stale');
  });
});

describe('computeProjectStaleness — unknown', () => {
  test('returns badge=unknown when refresh history is empty', () => {
    const r = computeProjectStaleness(baseProject, [], {
      'git.company.com/payments': { revision: 'r', modified_at: minutesAgo(5) },
      'confluence.company.com/PAY27': { revision: 'v', modified_at: minutesAgo(5) },
    }, { now: NOW });
    assert.equal(r.badge, 'unknown');
    assert.ok(r.reasons.some((x) => /no refresh history/i.test(x)));
    assert.equal(r.staleness_seconds, 0);
    // Per-source still enumerated, each marked unknown.
    assert.equal(r.per_source.length, 2);
    assert.ok(r.per_source.every((s) => s.badge === 'unknown'));
    assert.ok(r.per_source.every((s) => s.last_indexed === null));
  });

  test('returns badge=unknown when refreshHistory is null/undefined', () => {
    const r1 = computeProjectStaleness(baseProject, null, {}, { now: NOW });
    const r2 = computeProjectStaleness(baseProject, undefined, {}, { now: NOW });
    assert.equal(r1.badge, 'unknown');
    assert.equal(r2.badge, 'unknown');
  });

  test('per-source unknown when currentSourceState lacks that url', () => {
    const refreshHistory = [
      {
        timestamp: minutesAgo(10),
        type: 'incremental',
        trigger_source: 'github-actions',
        duration_seconds: 1,
        documents_processed: 0,
        status: 'success',
        error: null,
        per_source: {
          'git.company.com/payments': { revision: 'r', indexed_at: minutesAgo(10) },
          'confluence.company.com/PAY27': { revision: 'v', indexed_at: minutesAgo(10) },
        },
      },
    ];
    const currentSourceState = {
      // Confluence omitted entirely -> unknown for that source.
      'git.company.com/payments': { revision: 'r', modified_at: minutesAgo(15) },
    };
    const r = computeProjectStaleness(baseProject, refreshHistory, currentSourceState, { now: NOW });
    const conf = r.per_source.find((s) => s.source_url === 'confluence.company.com/PAY27');
    assert.equal(conf.badge, 'unknown');
    assert.equal(conf.current_revision, null);
    // Project rolls up: any unknown raises project to at least 'unknown', but stale wins
    // if anything is stale. Here git is fresh + confluence unknown -> project unknown.
    assert.equal(r.badge, 'unknown');
  });
});

describe('computeProjectStaleness — empty sources', () => {
  test('returns badge=unknown with empty per_source for projects with no sources', () => {
    const project = { ...baseProject, sources: [] };
    const refreshHistory = [];
    const r = computeProjectStaleness(project, refreshHistory, {}, { now: NOW });
    assert.equal(r.badge, 'unknown');
    assert.deepEqual(r.per_source, []);
    assert.ok(r.reasons.some((x) => /no sources/i.test(x)));
  });

  test('returns badge=unknown when sources is undefined', () => {
    const project = { id: 'x', name: 'X', version: '1' };
    const r = computeProjectStaleness(project, [], {}, { now: NOW });
    assert.equal(r.badge, 'unknown');
    assert.deepEqual(r.per_source, []);
  });
});

describe('computeProjectStaleness — input validation', () => {
  test('throws when projectConfig is missing or has no id', () => {
    assert.throws(() => computeProjectStaleness(null, [], {}), /projectConfig/);
    assert.throws(() => computeProjectStaleness({}, [], {}), /id/);
  });

  test('uses the latest record (index 0) as last indexed', () => {
    // Latest first, so the OLDER record at index 1 must NOT be used.
    const refreshHistory = [
      {
        timestamp: minutesAgo(5),
        type: 'incremental',
        trigger_source: 'github-actions',
        duration_seconds: 1,
        documents_processed: 0,
        status: 'success',
        error: null,
      },
      {
        timestamp: hoursAgo(48),
        type: 'full',
        trigger_source: 'web-ui',
        duration_seconds: 1,
        documents_processed: 0,
        status: 'success',
        error: null,
      },
    ];
    const currentSourceState = {
      'git.company.com/payments': { revision: 'r', modified_at: minutesAgo(10) },
      'confluence.company.com/PAY27': { revision: 'v', modified_at: minutesAgo(10) },
    };
    const r = computeProjectStaleness(baseProject, refreshHistory, currentSourceState, { now: NOW });
    assert.equal(r.badge, 'fresh');
  });

  test('per-source badge breakdown includes source_url, last_indexed, current_revision, drift_seconds, badge', () => {
    const refreshHistory = [
      {
        timestamp: minutesAgo(20),
        type: 'incremental',
        trigger_source: 'github-actions',
        duration_seconds: 1,
        documents_processed: 0,
        status: 'success',
        error: null,
        per_source: {
          'git.company.com/payments': { revision: 'abc', indexed_at: minutesAgo(20) },
          'confluence.company.com/PAY27': { revision: 'v', indexed_at: minutesAgo(20) },
        },
      },
    ];
    const currentSourceState = {
      'git.company.com/payments': { revision: 'abc', modified_at: minutesAgo(25) },
      'confluence.company.com/PAY27': { revision: 'v', modified_at: minutesAgo(30) },
    };
    const r = computeProjectStaleness(baseProject, refreshHistory, currentSourceState, { now: NOW });
    for (const s of r.per_source) {
      assert.ok('source_url' in s);
      assert.ok('last_indexed' in s);
      assert.ok('current_revision' in s);
      assert.ok('drift_seconds' in s);
      assert.ok('badge' in s);
      assert.equal(typeof s.drift_seconds, 'number');
    }
  });
});
