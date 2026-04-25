// T012: Source Connector interface — contract test.
// Traces: FR-003 (AC-003-07)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 4
//      docs/requirements/REQ-GH-263-.../error-taxonomy.md
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SourceConnector,
  ConnectorError,
} from '../../../src/connectors/connector.js';

test('SourceConnector is an abstract class — direct construction throws', () => {
  assert.throws(() => new SourceConnector(), /abstract/i);
});

test('SourceConnector subclass without crawl() throws on call', async () => {
  class Bad extends SourceConnector {}
  // The base class should still allow construction by subclasses but enforce
  // overrides of crawl() and diff() at call time.
  const inst = new Bad();
  await assert.rejects(async () => {
    // crawl returns an async iterable; iterating it must throw.
    for await (const _ of inst.crawl({})) {
      // unreachable
      void _;
    }
  }, /not implemented|abstract/i);
});

test('SourceConnector subclass without diff() throws on call', async () => {
  class Bad extends SourceConnector {
    async *crawl() {}
  }
  const inst = new Bad();
  await assert.rejects(async () => {
    for await (const _ of inst.diff({}, 'HEAD~1')) {
      void _;
    }
  }, /not implemented|abstract/i);
});

test('Subclass implementing crawl/diff satisfies the contract', async () => {
  class Good extends SourceConnector {
    async *crawl() {
      yield {
        content: 'hi',
        path: 'a.txt',
        source_type: 'fake',
        source_url: 'fake://a.txt',
        last_modified: new Date().toISOString(),
        metadata: {},
      };
    }
    async *diff() {
      yield {
        chunk: {
          content: 'hi',
          path: 'a.txt',
          source_type: 'fake',
          source_url: 'fake://a.txt',
          last_modified: new Date().toISOString(),
          metadata: {},
        },
        action: 'add',
      };
    }
  }
  const inst = new Good();
  assert.equal(typeof inst.crawl, 'function');
  assert.equal(typeof inst.diff, 'function');

  const chunks = [];
  for await (const c of inst.crawl({})) chunks.push(c);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].path, 'a.txt');

  const diffs = [];
  for await (const d of inst.diff({}, 'HEAD~1')) diffs.push(d);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].action, 'add');
  assert.ok(['add', 'modify', 'delete'].includes(diffs[0].action));
});

test('ConnectorError exposes a .code matching the error taxonomy', () => {
  const err = new ConnectorError('ERR-CONN-001', 'unreachable');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof ConnectorError);
  assert.equal(err.code, 'ERR-CONN-001');
  assert.equal(err.name, 'ConnectorError');
  assert.match(err.message, /unreachable/);
});

test('ConnectorError supports a cause for diagnostics', () => {
  const inner = new Error('socket hang up');
  const err = new ConnectorError('ERR-CONN-002', 'auth failed', { cause: inner });
  assert.equal(err.code, 'ERR-CONN-002');
  assert.equal(err.cause, inner);
});
