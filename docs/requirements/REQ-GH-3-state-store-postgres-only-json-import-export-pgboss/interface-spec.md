# Interface Specification: GH#3 Postgres state substrate

## Runtime config

`loadServiceConfig({ cwd })` returns:

```js
{
  configPath: ".ks/config.json",
  database: {
    url: "postgres://...",
    schema: "ks",
    ssl: false
  },
  queue: {
    provider: "pg-boss",
    schema: "pgboss"
  },
  state: {
    provider: "postgres"
  },
  tests: {
    skipDbE2EWhenUnconfigured: true
  }
}
```

The file stores `database.urlEnv`; the resolved URL comes from the environment.

## State store

```js
const store = createPostgresStateStore({ pool, schema: "ks" });

await store.projects.list();
await store.projects.get(id);
await store.projects.create(projectConfig);
await store.projects.update(id, patch);
await store.projects.delete(id);

await store.refreshHistory.add(projectId, record);
await store.refreshHistory.list(projectId, filters);

await store.audit.log(action, details);
await store.audit.query(filters);

await store.importExport.recordRun(run);
await store.transaction(async (tx) => {
  await tx.projects.update(id, patch);
});
```

## Queue

```js
const queue = createPgBossQueue({ connectionString, schema: "pgboss" });

const id = await queue.enqueue("full_rebuild", { project_id });
await queue.work("full_rebuild", async (job) => runFullRebuild(job.data, deps));
const status = await queue.getStatus(id);
await queue.close();
```

Required job types:

| Type | Payload |
|---|---|
| `full_rebuild` | `{ "project_id": "string" }` |
| `incremental_refresh` | `{ "project_id": "string", "changes": [] }` |
| `add_content` | `{ "project_id": "string", "content": {} }` |

## CLI commands

```text
isdlc-knowledge setup
isdlc-knowledge start
isdlc-knowledge config export --project <id> --output <file>
isdlc-knowledge config export --all --output <file>
isdlc-knowledge config export --deployment --output <file>
isdlc-knowledge config import <file>
```

## Import/export payload

```json
{
  "version": 1,
  "exported_at": "2026-04-27T23:34:55Z",
  "scope": "deployment",
  "service_config": {},
  "projects": [],
  "refresh_history": [],
  "audit_entries": [],
  "import_export_runs": [],
  "jobs": []
}
```

## Errors

| Code | Meaning |
|---|---|
| `ERR-CONFIG-001` | `.ks/config.json` missing or invalid |
| `ERR-DB-001` | database URL missing or unresolved |
| `ERR-DB-002` | database unreachable |
| `ERR-DB-003` | migration failed |
| `ERR-DB-004` | required DB permission missing |
| `ERR-QUEUE-001` | pg-boss start/work failure |
| `ERR-IMPORT-001` | import payload version unsupported |
| `ERR-EXPORT-001` | export scope invalid or incomplete |
