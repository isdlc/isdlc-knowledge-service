// T013: SVN Source Connector — unit tests.
// Traces: FR-003 (AC-003-02, AC-003-07), ERR-CONN-001, ERR-CONN-002
//
// Mock strategy:
//   We inject a fake `_spawn` via the constructor. The fake returns a tiny
//   EventEmitter-based "child process" object that emits canned stdout +
//   exit code based on which svn subcommand was requested. This lets us
//   exercise crawl/diff/error paths without touching the network or
//   requiring `svn` to be installed in CI.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SvnConnector } from '../../../src/connectors/svn.js';
import {
  SourceConnector,
  ConnectorError,
} from '../../../src/connectors/connector.js';

const REPO_URL = 'https://svn.example.com/repo/trunk';

let workspace;
let localPath;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'isdlc-svn-conn-'));
  localPath = join(workspace, 'wc');
});

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

/**
 * Build a fake spawn factory.
 *
 * @param {(args: string[]) => { stdout?: string, stderr?: string, code?: number, throwSync?: Error, errorEvent?: Error }} responder
 *   Function called for each spawn invocation. Receives the args array
 *   (the full svn argv minus the binary name) and returns what the fake
 *   child process should emit.
 *
 *   - `throwSync`: throw synchronously from spawn() itself.
 *   - `errorEvent`: emit an "error" event (e.g. ENOENT) before close.
 *   - `stdout`/`stderr`/`code`: normal canned response.
 */
function makeFakeSpawn(responder) {
  const calls = [];
  const fn = (cmd, args /* , opts */) => {
    calls.push({ cmd, args });
    const r = responder(args) || {};
    if (r.throwSync) throw r.throwSync;

    const child = new EventEmitter();
    child.stdout = Readable.from([Buffer.from(r.stdout ?? '', 'utf8')]);
    child.stderr = Readable.from([Buffer.from(r.stderr ?? '', 'utf8')]);

    // Defer events to next tick so listeners attached after spawn fire.
    if (r.errorEvent) {
      setImmediate(() => child.emit('error', r.errorEvent));
    } else {
      setImmediate(() => child.emit('close', r.code ?? 0));
    }
    return child;
  };
  fn.calls = calls;
  return fn;
}

/**
 * Seed a working copy on disk so the connector's filesystem walk has
 * something to find. Also creates a `.svn` marker so the connector skips
 * the `svn checkout` branch and runs `svn update` instead.
 */
function seedWorkingCopy() {
  mkdirSync(localPath, { recursive: true });
  mkdirSync(join(localPath, '.svn'), { recursive: true });
  mkdirSync(join(localPath, 'src'), { recursive: true });
  writeFileSync(join(localPath, 'README.md'), '# Project\n');
  writeFileSync(join(localPath, 'src', 'app.js'), 'export const x = 1;\n');

  // Binary fixture — null bytes in the first 8KB.
  const bin = Buffer.alloc(16, 0);
  bin[0] = 0x89;
  bin[1] = 0x50;
  bin[2] = 0x4e;
  bin[3] = 0x47;
  writeFileSync(join(localPath, 'logo.png'), bin);
}

const INFO_XML = `<?xml version="1.0"?>
<info>
  <entry kind="file" path="x" revision="42">
    <commit revision="41">
      <author>alice</author>
      <date>2026-04-01T12:00:00.000000Z</date>
    </commit>
  </entry>
</info>`;

test('SvnConnector extends SourceConnector and exposes crawl/diff', () => {
  const c = new SvnConnector({
    url: REPO_URL,
    localPath,
    _spawn: makeFakeSpawn(() => ({ stdout: '', code: 0 })),
  });
  assert.ok(c instanceof SourceConnector);
  assert.equal(typeof c.crawl, 'function');
  assert.equal(typeof c.diff, 'function');
});

test('crawl yields NormalisedChunks with svn source_type and metadata (AC-003-07)', async () => {
  seedWorkingCopy();
  const spawnFn = makeFakeSpawn((args) => {
    if (args[0] === 'update') return { stdout: 'At revision 42.\n', code: 0 };
    if (args[0] === 'info') return { stdout: INFO_XML, code: 0 };
    return { stdout: '', code: 0 };
  });
  const c = new SvnConnector({ url: REPO_URL, localPath, _spawn: spawnFn });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  const paths = chunks.map((c) => c.path).sort();
  assert.deepEqual(paths, ['README.md', 'src/app.js']);

  for (const chunk of chunks) {
    assert.equal(chunk.source_type, 'svn');
    assert.ok(chunk.source_url.startsWith(REPO_URL));
    assert.ok(chunk.source_url.endsWith(chunk.path));
    assert.ok(chunk.content.length > 0);
    assert.ok(!Number.isNaN(Date.parse(chunk.last_modified)));
    assert.equal(chunk.metadata.revision, '41');
    assert.equal(typeof chunk.metadata.size, 'number');
  }

  // Should have called `svn update` (since .svn already exists), not checkout.
  const subcommands = spawnFn.calls.map((c) => c.args[0]);
  assert.ok(subcommands.includes('update'));
  assert.ok(!subcommands.includes('checkout'));
});

test('crawl runs svn checkout when no working copy exists', async () => {
  // Note: no seedWorkingCopy() — localPath does not yet contain .svn.
  const spawnFn = makeFakeSpawn((args) => {
    if (args[0] === 'checkout') {
      // Simulate a successful checkout by creating the files on disk
      // before resolving close. We do it eagerly here because the fake
      // spawn defers close to the next tick.
      mkdirSync(localPath, { recursive: true });
      mkdirSync(join(localPath, '.svn'), { recursive: true });
      writeFileSync(join(localPath, 'a.txt'), 'hello\n');
      return { stdout: 'A    a.txt\nChecked out revision 1.\n', code: 0 };
    }
    if (args[0] === 'info') return { stdout: INFO_XML, code: 0 };
    return { stdout: '', code: 0 };
  });
  const c = new SvnConnector({ url: REPO_URL, localPath, _spawn: spawnFn });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].path, 'a.txt');
  const subcommands = spawnFn.calls.map((c) => c.args[0]);
  assert.ok(subcommands.includes('checkout'));
});

test('crawl skips binary files (null-byte heuristic)', async () => {
  seedWorkingCopy();
  const spawnFn = makeFakeSpawn((args) => {
    if (args[0] === 'update') return { stdout: '', code: 0 };
    if (args[0] === 'info') return { stdout: INFO_XML, code: 0 };
    return { stdout: '', code: 0 };
  });
  const c = new SvnConnector({ url: REPO_URL, localPath, _spawn: spawnFn });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  assert.ok(
    !chunks.some((c) => c.path === 'logo.png'),
    'binary file logo.png must be skipped',
  );
});

test('crawl skips files larger than maxFileBytes', async () => {
  seedWorkingCopy();
  // Add a >maxFileBytes file. We use a small maxFileBytes for speed.
  writeFileSync(join(localPath, 'big.txt'), 'A'.repeat(1024));
  const spawnFn = makeFakeSpawn((args) => {
    if (args[0] === 'update') return { stdout: '', code: 0 };
    if (args[0] === 'info') return { stdout: INFO_XML, code: 0 };
    return { stdout: '', code: 0 };
  });
  const c = new SvnConnector({
    url: REPO_URL,
    localPath,
    maxFileBytes: 256,
    _spawn: spawnFn,
  });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  assert.ok(
    !chunks.some((c) => c.path === 'big.txt'),
    'file larger than maxFileBytes must be skipped',
  );
});

test('crawl skips default-ignored directories (.svn)', async () => {
  seedWorkingCopy();
  // Plant a tracked-looking file inside .svn — connector must NOT yield it.
  writeFileSync(join(localPath, '.svn', 'wc.db'), 'sqlite\n');

  const spawnFn = makeFakeSpawn((args) => {
    if (args[0] === 'update') return { stdout: '', code: 0 };
    if (args[0] === 'info') return { stdout: INFO_XML, code: 0 };
    return { stdout: '', code: 0 };
  });
  const c = new SvnConnector({ url: REPO_URL, localPath, _spawn: spawnFn });

  const chunks = [];
  for await (const chunk of c.crawl({})) chunks.push(chunk);

  assert.ok(
    !chunks.some((c) => c.path.startsWith('.svn/')),
    '.svn must be skipped',
  );
});

test('diff maps A/M/D actions correctly (AC-003-02)', async () => {
  seedWorkingCopy();
  const diffXml = `<?xml version="1.0"?>
<diff>
  <paths>
    <path props="none" kind="file" item="modified">${REPO_URL}/src/app.js</path>
    <path props="none" kind="file" item="added">${REPO_URL}/docs.md</path>
    <path props="none" kind="file" item="deleted">${REPO_URL}/old.md</path>
  </paths>
</diff>`;

  const spawnFn = makeFakeSpawn((args) => {
    if (args[0] === 'update') return { stdout: '', code: 0 };
    if (args[0] === 'diff') return { stdout: diffXml, code: 0 };
    if (args[0] === 'info') return { stdout: INFO_XML, code: 0 };
    return { stdout: '', code: 0 };
  });
  const c = new SvnConnector({ url: REPO_URL, localPath, _spawn: spawnFn });

  const entries = [];
  for await (const entry of c.diff({}, '40')) entries.push(entry);

  const byPath = Object.fromEntries(entries.map((e) => [e.chunk.path, e.action]));
  assert.equal(byPath['src/app.js'], 'modify');
  assert.equal(byPath['docs.md'], 'add');
  assert.equal(byPath['old.md'], 'delete');

  // src/app.js exists in the working copy, so its chunk has content.
  const modify = entries.find((e) => e.chunk.path === 'src/app.js');
  assert.ok(modify.chunk.content.length > 0);
  assert.equal(modify.chunk.source_type, 'svn');
  // delete entries have empty content.
  const del = entries.find((e) => e.chunk.path === 'old.md');
  assert.equal(del.chunk.content, '');

  // Verify the diff invocation included --summarize, --xml, and -rN:HEAD.
  const diffCall = spawnFn.calls.find((c) => c.args[0] === 'diff');
  assert.ok(diffCall);
  assert.ok(diffCall.args.includes('--summarize'));
  assert.ok(diffCall.args.includes('--xml'));
  assert.ok(diffCall.args.includes('40:HEAD'));
});

test('diff requires a `since` revision', async () => {
  const spawnFn = makeFakeSpawn(() => ({ stdout: '', code: 0 }));
  const c = new SvnConnector({ url: REPO_URL, localPath, _spawn: spawnFn });
  await assert.rejects(
    async () => {
      for await (const _ of c.diff({}, undefined)) void _;
    },
    /since.*required/i,
  );
});

test('spawn ENOENT (svn not on PATH) throws ConnectorError ERR-CONN-001', async () => {
  const enoent = Object.assign(new Error('spawn svn ENOENT'), { code: 'ENOENT' });
  const spawnFn = makeFakeSpawn(() => ({ errorEvent: enoent }));
  const c = new SvnConnector({ url: REPO_URL, localPath, _spawn: spawnFn });

  await assert.rejects(
    async () => {
      for await (const _ of c.crawl({})) void _;
    },
    (err) => {
      assert.ok(err instanceof ConnectorError, 'expected ConnectorError');
      assert.equal(err.code, 'ERR-CONN-001');
      return true;
    },
  );
});

test('synchronous spawn failure throws ConnectorError ERR-CONN-001', async () => {
  const spawnFn = makeFakeSpawn(() => ({
    throwSync: new Error('cannot spawn child process'),
  }));
  const c = new SvnConnector({ url: REPO_URL, localPath, _spawn: spawnFn });

  await assert.rejects(
    async () => {
      for await (const _ of c.crawl({})) void _;
    },
    (err) => {
      assert.ok(err instanceof ConnectorError);
      assert.equal(err.code, 'ERR-CONN-001');
      return true;
    },
  );
});

test('non-zero exit on network failure throws ConnectorError ERR-CONN-001', async () => {
  const spawnFn = makeFakeSpawn((args) => {
    if (args[0] === 'checkout') {
      return {
        stderr: 'svn: E175002: Unable to connect to a repository at URL\n',
        code: 1,
      };
    }
    return { stdout: '', code: 0 };
  });
  const c = new SvnConnector({ url: REPO_URL, localPath, _spawn: spawnFn });

  await assert.rejects(
    async () => {
      for await (const _ of c.crawl({})) void _;
    },
    (err) => {
      assert.ok(err instanceof ConnectorError);
      assert.equal(err.code, 'ERR-CONN-001');
      return true;
    },
  );
});

test('auth failure (E170001 in stderr) throws ConnectorError ERR-CONN-002', async () => {
  const spawnFn = makeFakeSpawn((args) => {
    if (args[0] === 'checkout') {
      return {
        stderr: "svn: E170001: Authentication failed for realm '<https://svn.example.com:443>'\n",
        code: 1,
      };
    }
    return { stdout: '', code: 0 };
  });
  const c = new SvnConnector({
    url: REPO_URL,
    localPath,
    auth: { username: 'alice', password: 'bad' },
    _spawn: spawnFn,
  });

  await assert.rejects(
    async () => {
      for await (const _ of c.crawl({})) void _;
    },
    (err) => {
      assert.ok(err instanceof ConnectorError, 'expected ConnectorError');
      assert.equal(err.code, 'ERR-CONN-002');
      return true;
    },
  );

  // Auth flags should have been forwarded to svn.
  const checkoutCall = spawnFn.calls.find((c) => c.args[0] === 'checkout');
  assert.ok(checkoutCall.args.includes('--username'));
  assert.ok(checkoutCall.args.includes('alice'));
});

test('constructor rejects missing url', () => {
  assert.throws(() => new SvnConnector({}), /url.*required/i);
});
