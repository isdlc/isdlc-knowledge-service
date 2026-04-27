# Module Design: GH#3 Postgres state substrate

## Module Overview

| Module | Responsibility | Main Files |
|---|---|---|
| Runtime config | Load and validate `.ks/config.json`, resolve DB URL env references | `src/config/service-config.js`, `src/cli/setup.js`, `src/cli/start.js` |
| DB foundation | Pool, health checks, migrations, role setup | `src/db/index.js`, `src/db/pool.js`, `src/db/migrations.js`, `src/db/migrations/001_state_substrate.sql` |
| State layer | One DB-backed access boundary for project config, refresh history, audit, import/export runs | `src/state/index.js`, `src/state/postgres-state-store.js` |
| Config store adapter | Preserve existing project/refresh store contracts over Postgres | `src/config/index.js`, `src/config/project-store.js`, `src/config/refresh-history.js` |
| Audit logger | Write/query audit rows in Postgres with append-only app role | `src/audit/postgres-logger.js`, `src/audit/logger.js` |
| Queue adapter | pg-boss wrapper matching current enqueue/status/list semantics | `src/queue/pgboss-queue.js`, `src/queue/index.js` |
| Worker wiring | Register pg-boss job handlers and close resources on shutdown | `src/worker/index.js`, `src/worker/rebuild.js`, `src/worker/refresh.js` |
| Import/export | JSON config-as-code round trip for project/all/full deployment | `src/cli/config.js`, `src/cli/commands.js` |

## Module Design

### Runtime config

`.ks/config.json` stores non-secret service settings. Secrets are referenced through environment variable names.

```json
{
  "version": 1,
  "database": {
    "urlEnv": "KNOWLEDGE_DATABASE_URL",
    "schema": "ks",
    "ssl": false
  },
  "queue": {
    "provider": "pg-boss",
    "schema": "pgboss"
  },
  "state": {
    "provider": "postgres"
  },
  "vectors": {
    "provider": "existing"
  },
  "tests": {
    "skipDbE2EWhenUnconfigured": true
  }
}
```

### Database schema

Core schema `ks` contains:

| Table | Purpose |
|---|---|
| `ks.projects` | Project config, sources, model config, vector config, metadata vocabulary, status, timestamps |
| `ks.refresh_history` | Full/incremental/add-content operational history and per-source details |
| `ks.audit_entries` | Append-only audit entries with action, project, details, and IP address |
| `ks.import_export_runs` | Import/export execution history and outcome records |
| `ks.schema_migrations` | Applied service migration records |

pg-boss owns its queue schema, configured as `pgboss`.

### Roles and grants

| Role | Permissions |
|---|---|
| `ks_owner` | Owns schemas, migrations, grants |
| `ks_app` | Reads/writes operational state; inserts/selects audit; cannot update/delete audit |
| `ks_maintenance` | Retention cleanup, audit purge/archive, maintenance operations |

### State layer

`createPostgresStateStore({ pool })` exposes:

- `projects.list/get/create/update/delete`
- `refreshHistory.add/list`
- `audit.log/query`
- `importExport.recordRun/listRuns`
- `transaction(fn)`

Existing config store functions delegate to this layer to preserve API and worker call sites.

### Queue adapter

`createQueue({ boss, stateStore })` exposes the current queue-facing methods where practical:

- `enqueue(type, payload, options)`
- `work(type, handler)`
- `getStatus(id)`
- `listJobs(filters)`
- `close()`

The worker maps `full_rebuild`, `incremental_refresh`, and `add_content` to existing handler functions.

## Changes to Existing

- `package.json` changes Node engine to `>=22.12.0`, adds `pg` and `pg-boss`, and removes `better-sqlite3` if no longer used.
- `src/cli/setup.js` writes `.ks/config.json` and prints Postgres setup guidance.
- `src/cli/start.js` validates `.ks/config.json`, DB connectivity, and migrations before forking child processes.
- `src/config/project-store.js` and `src/config/refresh-history.js` stop using JSON files as runtime state and delegate to the Postgres state layer.
- `src/audit/logger.js` becomes a Postgres-backed logger or re-exports the Postgres implementation.
- `src/queue/queue.js` custom SQLite logic is removed from runtime.
- `src/worker/index.js` starts pg-boss workers instead of polling the custom queue.
- `src/api/*` and `src/api/routes/*` receive Postgres-backed dependencies but keep public REST/MCP behavior.
- `README.md`, `docs/architecture/data-model.md`, and ADR-003 documentation are updated to state Postgres-only runtime state.

## Wiring Summary

1. `isdlc-knowledge setup` writes `.ks/config.json` and prints a required `KNOWLEDGE_DATABASE_URL` example.
2. `isdlc-knowledge start` loads `.ks/config.json`, resolves `KNOWLEDGE_DATABASE_URL`, opens a Postgres pool, runs health checks, validates migrations, then starts API and worker.
3. API routes use `createPostgresStateStore` for projects, refresh history, audit, and import/export.
4. Queue-producing routes and MCP tools enqueue jobs through `createPgBossQueue`.
5. Worker registers pg-boss handlers and calls existing rebuild/refresh/add-content logic with Postgres-backed stores.
6. Import/export commands serialize and restore DB-backed state through the state layer.

## Assumptions and Inferences

- **Accepted**: Runtime JSON backcompat is dropped because there are no users.
- **Accepted**: All service config is centralized at `.ks/config.json`.
- **Inference, medium confidence**: The state layer should be introduced before individual stores are rewired to reduce duplicate SQL and avoid parallel storage semantics.
- **Inference, medium confidence**: Direct pg-boss table access should be minimized; use pg-boss APIs unless export requirements need documented read-only job history access.
