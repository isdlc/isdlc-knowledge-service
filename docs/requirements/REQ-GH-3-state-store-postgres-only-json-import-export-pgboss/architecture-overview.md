# Architecture Overview: GH#3 Postgres state substrate

## Architecture Options

| Option | Summary | Strengths | Weaknesses | Decision |
|---|---|---|---|---|
| A | Postgres plus Graphile Worker | Mature Postgres worker, broad capabilities | More framework-specific task API than needed | Not selected |
| B | Postgres plus pg-boss | Maintained queue, simple Node API, transaction-friendly, good fit for existing worker job model | Requires Node 22.12.0 or newer | Selected |
| C | Postgres plus PGMQ | Simple queue primitive and SQL-first operations | More lifecycle, retry, and worker glue to own | Not selected |

## Selected Architecture

- Runtime state is consolidated into PostgreSQL. The API, worker, CLI, audit logger, queue adapter, import/export commands, and operational history use one shared DB access layer.
- pg-boss replaces the custom SQLite job queue. The service keeps the current job names and handler semantics while delegating queue durability, retry, and dead-letter mechanics to pg-boss.
- `.ks/config.json` is the only service config file. It contains non-secret runtime configuration and points to the DB connection through an environment variable such as `KNOWLEDGE_DATABASE_URL`.
- Vector storage remains unchanged. This REQ removes SQLite from runtime queue/state usage, not from vector adapter support.

## Technology Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Node runtime | `>=22.12.0` | Required by current pg-boss CommonJS/ESM support. |
| State DB | PostgreSQL 14+ | Matches GH-3 baseline and gives room for future relational state. |
| DB client | `pg` | Standard Node PostgreSQL driver and compatible with pg-boss ecosystem. |
| Queue | `pg-boss` | Maintained Postgres-backed queue with retries, dead-letter behavior, scheduling, and transaction-friendly enqueue. |
| Config file | `.ks/config.json` | Accepted central location for service runtime config. |
| DB roles | `ks_owner`, `ks_app`, `ks_maintenance` | Separates migrations, normal app operation, and audit cleanup/purge authority. |
| Tests | Configured DB E2E, skipped when absent | Keeps local test runs usable while enabling strict DB verification when configured. |

## Integration Architecture

- `src/cli/setup.js` creates `.ks/config.json`, prints manual Postgres setup instructions, and never launches Docker.
- `src/cli/start.js` reads `.ks/config.json`, validates Postgres connectivity and migrations, then forks API and worker with a normalized runtime config.
- `src/db/*` owns config resolution, pool creation, health checks, migration execution, and role-aware connection helpers.
- `src/state/*` exposes project, refresh history, audit, import/export, and operational state operations through one boundary.
- `src/queue/*` exposes the existing queue-facing operations through a pg-boss adapter.
- `src/worker/*` registers handlers for `full_rebuild`, `incremental_refresh`, and `add_content`, then delegates state changes through the state layer.
- REST and MCP handlers keep their public contracts but receive Postgres-backed stores through dependency wiring.

## Assumptions and Inferences

- **Accepted**: The project has no live users, so runtime migration/backcompat from existing JSON state is not required.
- **Accepted**: The user starts or provisions Postgres manually; setup/start only instruct and validate.
- **Inference, medium confidence**: Some existing tests assume file-backed data stores. Build should update them to use injected fake stores or DB helpers rather than preserving file-backed runtime behavior.
- **Inference, medium confidence**: `better-sqlite3` can be removed if no non-queue runtime dependency remains, while `sqlite-vec` stays for vector support.
