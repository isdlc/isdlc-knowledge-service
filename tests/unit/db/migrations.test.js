// REQ-GH-3 — migration runner unit tests.
//
// Exercises listMigrations (filesystem read) and the runMigrations dispatch
// shape. The DB-touching path is exercised in tests/integration/db/ which
// skips without KNOWLEDGE_DATABASE_URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DatabaseError,
  listMigrations,
  runMigrations,
} from '../../../src/db/index.js';

test('listMigrations returns the bundled REQ-GH-3 migration', async () => {
  const migrations = await listMigrations();
  assert.ok(migrations.length >= 1, 'at least one bundled migration');
  const ids = migrations.map((m) => m.id);
  assert.ok(ids.includes('001_state_substrate'));
});

test('listMigrations sorts entries lexically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kn-migrations-'));
  try {
    await writeFile(join(dir, '003_third.sql'), '-- third');
    await writeFile(join(dir, '001_first.sql'), '-- first');
    await writeFile(join(dir, '002_second.sql'), '-- second');
    const migrations = await listMigrations({ migrationsDir: dir });
    assert.deepEqual(
      migrations.map((m) => m.id),
      ['001_first', '002_second', '003_third'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listMigrations returns [] when migrations directory does not exist', async () => {
  const out = await listMigrations({ migrationsDir: '/nonexistent/path/__no__' });
  assert.deepEqual(out, []);
});

test('listMigrations attaches a stable checksum to each migration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kn-migrations-'));
  try {
    await writeFile(join(dir, '001_x.sql'), 'SELECT 1;');
    const a = await listMigrations({ migrationsDir: dir });
    const b = await listMigrations({ migrationsDir: dir });
    assert.equal(a[0].checksum, b[0].checksum);
    assert.equal(a[0].checksum.length, 16);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runMigrations rejects null pool with ERR-DB-003', async () => {
  await assert.rejects(
    () => runMigrations(null),
    (err) => err instanceof DatabaseError && err.code === 'ERR-DB-003',
  );
});

test('runMigrations applies pending migrations and skips already-applied ones', async () => {
  // Fake pool/client recording every query; simulate the migrations table
  // existing only after the first apply.
  const queries = [];
  let migrationTableExists = false;
  let appliedIds = new Set();

  const fakeClient = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (typeof sql === 'string') {
        if (sql.includes("to_regclass('ks.schema_migrations')")) {
          return { rows: [{ reg: migrationTableExists ? 'ks.schema_migrations' : null }] };
        }
        if (sql.includes('FROM ks.schema_migrations')) {
          return { rows: [...appliedIds].map((id) => ({ id })) };
        }
        if (sql.startsWith('INSERT INTO ks.schema_migrations')) {
          appliedIds.add(params[0]);
          return { rows: [] };
        }
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [] };
        }
        // Treat any other SQL (the migration body) as creating the table.
        migrationTableExists = true;
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const fakePool = { connect: async () => fakeClient };

  // Custom migrations dir with two files.
  const dir = await mkdtemp(join(tmpdir(), 'kn-migrations-'));
  try {
    await writeFile(join(dir, '001_first.sql'), '-- first migration');
    await writeFile(join(dir, '002_second.sql'), '-- second migration');

    const first = await runMigrations(fakePool, { migrationsDir: dir });
    assert.deepEqual(first.applied, ['001_first', '002_second']);
    assert.deepEqual(first.skipped, []);

    const second = await runMigrations(fakePool, { migrationsDir: dir });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, ['001_first', '002_second']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runMigrations rolls back on failure and surfaces ERR-DB-003', async () => {
  const fakeClient = {
    async query(sql) {
      if (typeof sql === 'string' && sql.includes("to_regclass('ks.schema_migrations')")) {
        return { rows: [{ reg: null }] };
      }
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      // Any actual migration body fails.
      throw new Error('syntax error at end of input');
    },
    release() {},
  };
  const fakePool = { connect: async () => fakeClient };
  const dir = await mkdtemp(join(tmpdir(), 'kn-migrations-'));
  try {
    await writeFile(join(dir, '001_bad.sql'), 'this is not valid sql');
    await assert.rejects(
      () => runMigrations(fakePool, { migrationsDir: dir }),
      (err) => err instanceof DatabaseError && err.code === 'ERR-DB-003' && /001_bad/.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
