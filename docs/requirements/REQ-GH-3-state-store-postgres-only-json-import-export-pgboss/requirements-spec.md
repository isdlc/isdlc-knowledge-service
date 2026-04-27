# Requirements Specification: State store Postgres-only with JSON import/export and pg-boss (GH#3)

**REQ ID**: REQ-GH-3
**Source**: GitHub Issue #3
**Tier**: Epic
**Last updated**: 2026-04-27

## Functional Requirements

### FR-001: Runtime baseline

The service MUST move its supported Node.js runtime to Node 22.12.0 or newer so pg-boss can be adopted without compatibility ambiguity.

**Acceptance Criteria**:
- **AC-001-01**: `package.json` declares `node >=22.12.0`.
- **AC-001-02**: dependency metadata includes `pg` and `pg-boss`.
- **AC-001-03**: local setup and test guidance mention the new minimum runtime.

### FR-002: Central service config

The service MUST use `.ks/config.json` as the single runtime service config location. Runtime state MUST NOT be sourced from `data/config.json` or per-project JSON files after this REQ.

**Acceptance Criteria**:
- **AC-002-01**: setup writes `.ks/config.json`.
- **AC-002-02**: start/status/worker/API startup read `.ks/config.json`.
- **AC-002-03**: missing `.ks/config.json` produces a clear setup instruction.
- **AC-002-04**: existing JSON project files are treated only as import/export payloads, not live state.

### FR-003: Strict Postgres runtime state

PostgreSQL MUST be the only runtime state substrate for project config, refresh history, audit, queue state, import/export runs, and operational history.

**Acceptance Criteria**:
- **AC-003-01**: startup validates database connectivity before forking API and worker children.
- **AC-003-02**: no SQLite fallback exists for runtime state.
- **AC-003-03**: migrations create schema `ks` and the required state tables.
- **AC-003-04**: runtime database errors fail clearly instead of silently falling back to files.

### FR-004: Single data access boundary

All DB-backed state MUST flow through one shared data access boundary so API, worker, CLI, audit, and queue integration use consistent transactions and connection management.

**Acceptance Criteria**:
- **AC-004-01**: project config CRUD uses the Postgres state layer.
- **AC-004-02**: refresh history uses the Postgres state layer.
- **AC-004-03**: import/export uses the same state layer rather than bypassing it with ad hoc SQL.
- **AC-004-04**: callers receive stable store interfaces equivalent to the existing config store behavior.

### FR-005: DB-level audit enforcement

Audit rows MUST be stored in Postgres and append-only behavior MUST be enforced at the database role/grant level.

**Acceptance Criteria**:
- **AC-005-01**: `ks_app` can insert and select audit rows.
- **AC-005-02**: `ks_app` cannot update or delete audit rows.
- **AC-005-03**: `ks_maintenance` can purge or archive audit rows for retention operations.
- **AC-005-04**: existing FR-014 audit query semantics are preserved.

### FR-006: Maintained Postgres queue

The custom SQLite queue MUST be replaced by pg-boss while preserving the current job semantics.

**Acceptance Criteria**:
- **AC-006-01**: `full_rebuild`, `incremental_refresh`, and `add_content` jobs are supported.
- **AC-006-02**: retry, completion, failure, and dead-letter behavior are represented through pg-boss.
- **AC-006-03**: worker shutdown closes pg-boss and database resources cleanly.
- **AC-006-04**: custom `src/queue/queue.js` SQLite runtime logic is removed or reduced to a non-runtime compatibility shim.

### FR-007: Config import/export

JSON files MUST become a config-as-code import/export format, including operational history and all DB-backed state selected for export.

**Acceptance Criteria**:
- **AC-007-01**: export supports one project, all projects, and full deployment.
- **AC-007-02**: import validates payload version before mutating the database.
- **AC-007-03**: full deployment export includes config, projects, refresh history, audit rows, import/export run history, and queue/job history where pg-boss exposes it.
- **AC-007-04**: import runs transactionally where supported and reports partial failure clearly.

### FR-008: Vector storage unchanged

Vector storage behavior MUST remain unchanged in this REQ. This migration is for runtime state, not vector indexes.

**Acceptance Criteria**:
- **AC-008-01**: vector adapter selection and storage paths remain compatible with existing behavior.
- **AC-008-02**: existing vector adapter tests continue to pass.
- **AC-008-03**: removing the custom SQLite queue does not remove `sqlite-vec` support.

### FR-009: Configurable DB E2E

DB-backed E2E tests MUST be available but skipped when no DB configuration is present.

**Acceptance Criteria**:
- **AC-009-01**: E2E tests skip with an explicit reason when Postgres config is absent.
- **AC-009-02**: when configured, E2E covers setup/start validation, project persistence, audit insert/query, queue processing, and import/export round trip.
- **AC-009-03**: unit tests do not require a live Postgres server unless explicitly marked DB integration.

### FR-010: Operational DB UX

Setup/start MUST instruct the user how to provide Postgres. The service MUST NOT auto-launch Docker or any database process.

**Acceptance Criteria**:
- **AC-010-01**: setup prints manual Postgres instructions.
- **AC-010-02**: start fails clearly when the configured DB is unreachable.
- **AC-010-03**: documentation includes a minimal local Postgres command or connection string example.
- **AC-010-04**: production deployments can use externally managed Postgres.

## Assumptions and Inferences

- **Accepted amendment**: The original issue requested Docker auto-launch and testcontainers. The accepted analysis replaces that with user-provided Postgres instructions and configurable/skipped DB E2E for now.
- **Accepted amendment**: The queue provider is pg-boss, not Graphile Worker or PGMQ.
- **Inference, high confidence**: PostgreSQL 14+ remains the DB baseline because GH-3 requested 14+ and pg-boss only needs PostgreSQL 13+.
- **Inference, medium confidence**: pg-boss job history may not expose every operational detail in the same shape as the custom queue. Export should include job history where available and document any provider limitation.

## Non-Functional Requirements

- **NFR-001 Reliability**: Project config changes, refresh history appends, audit inserts, and job enqueue operations should be transactionally consistent where business workflows require it.
- **NFR-002 Operability**: DB connection failures, migration failures, and permission failures must produce actionable errors.
- **NFR-003 Security**: Credentials remain environment references. `.ks/config.json` must not require bare secrets.
- **NFR-004 Portability**: The service remains installable as a Node package; Postgres is an external runtime prerequisite.
- **NFR-005 Testability**: DB-dependent tests are opt-in/configured, with deterministic skip behavior in unconfigured environments.

## Out of Scope

- Migrating vector indexes into Postgres.
- Supporting MySQL, Oracle, SQL Server, or cross-RDBMS adapters.
- Auto-launching Docker/Postgres from setup or start.
- Migrating live production deployments. No current users or live deployments are assumed.
- Implementing model registry, eval rows, canonicality, or artifact graph beyond schema readiness for future work.

## Prioritization

| Priority | FRs | Rationale |
|---|---|---|
| Must | FR-001, FR-002, FR-003, FR-004, FR-005, FR-006 | Foundational state substrate and queue replacement. |
| Must | FR-007, FR-010 | Import/export and operational setup are required to replace JSON safely. |
| Should | FR-009 | DB E2E is needed but can skip when unconfigured. |
| Must Not Regress | FR-008 | Vector storage is intentionally outside this migration. |
