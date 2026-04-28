# Task Plan: REQ-GH-3 state-store-postgres-only-json-import-export-pgboss

## Progress Summary

| Phase | Total | Done | Remaining |
|---|---:|---:|---:|
| 05 | 1 | 1 | 0 |
| 06 | 12 | 2 | 10 |
| 16 | 2 | 0 | 2 |
| 08 | 2 | 0 | 2 |
| **Total** | **17** | **3** | **14** |

## Phase 05: Test Strategy -- COMPLETE

### test_case_design

- [X] T001 Test strategy: DB acceptance suite | traces: FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010
  files: docs/requirements/REQ-GH-3-state-store-postgres-only-json-import-export-pgboss/test-strategy.md (MODIFY), tests/helpers/postgres.js (CREATE), tests/e2e/postgres-state-store.test.js (CREATE)
  tests: tests/e2e/postgres-state-store.test.js (CREATE)
  blocked_by: []
  blocks: [T002, T003, T004, T005, T006, T007, T008, T009, T010, T011, T012, T013]
  description: |
    Define the DB test harness and E2E skip behavior before implementation starts.
    The helper must detect missing DB config and skip DB E2E with an explicit reason.

## Phase 06: Implementation -- IN PROGRESS

### setup

- [X] T002 Runtime baseline: Node 22.12 and pg-boss dependencies | traces: FR-001, AC-001-01, AC-001-02, AC-001-03
  files: package.json (MODIFY), package-lock.json (MODIFY), README.md (MODIFY)
  tests: tests/unit/smoke.test.js (MODIFY)
  blocked_by: [T001]
  blocks: [T004, T007]
  description: |
    Bump the package engine to node >=22.12.0. Add pg and pg-boss dependencies.
    Remove better-sqlite3 only after T013 confirms no non-queue runtime usage remains.

- [X] T003 Service config: .ks/config.json loader and setup/start wiring | traces: FR-002, FR-010, AC-002-01, AC-002-02, AC-002-03, AC-010-01, AC-010-02
  files: src/config/service-config.js (CREATE), src/cli/setup.js (MODIFY), src/cli/start.js (MODIFY), tests/unit/config/service-config.test.js (CREATE), tests/unit/cli/setup.test.js (MODIFY), tests/unit/cli/start.test.js (MODIFY)
  tests: tests/unit/config/service-config.test.js (CREATE), tests/unit/cli/setup.test.js (MODIFY), tests/unit/cli/start.test.js (MODIFY)
  blocked_by: [T001]
  blocks: [T004, T011]
  description: |
    Introduce .ks/config.json as the service config file. Store DB URL by env-var reference.
    Setup prints manual Postgres instructions. Start fails clearly when config or DB is missing.

### core_implementation

- [ ] T004 Postgres foundation: pool, health check, migrations, roles | traces: FR-003, FR-005, AC-003-01, AC-003-03, AC-005-01, AC-005-02, AC-005-03
  files: src/db/index.js (CREATE), src/db/config.js (CREATE), src/db/pool.js (CREATE), src/db/migrations.js (CREATE), src/db/migrations/001_state_substrate.sql (CREATE), tests/unit/db/config.test.js (CREATE), tests/integration/db/migrations.test.js (CREATE)
  tests: tests/unit/db/config.test.js (CREATE), tests/integration/db/migrations.test.js (CREATE)
  blocked_by: [T002, T003]
  blocks: [T005, T006, T007, T009, T011]
  description: |
    Add schema ks, schema_migrations, projects, refresh_history, audit_entries,
    import_export_runs, and DB roles ks_owner, ks_app, ks_maintenance.

- [ ] T005 State layer: Postgres-backed project and refresh stores | traces: FR-004, AC-004-01, AC-004-02, AC-004-03, AC-004-04
  files: src/state/index.js (CREATE), src/state/postgres-state-store.js (CREATE), src/config/index.js (MODIFY), src/config/project-store.js (MODIFY), src/config/refresh-history.js (MODIFY), tests/unit/state/postgres-state-store.test.js (CREATE), tests/unit/config/project-store.test.js (MODIFY), tests/unit/config/refresh-history.test.js (MODIFY)
  tests: tests/unit/state/postgres-state-store.test.js (CREATE), tests/unit/config/project-store.test.js (MODIFY), tests/unit/config/refresh-history.test.js (MODIFY)
  blocked_by: [T004]
  blocks: [T006, T009, T011]
  description: |
    Keep the existing config store API but move runtime persistence to the shared Postgres state layer.
    Do not preserve JSON files as a live runtime fallback.

- [ ] T006 DB audit: Postgres logger and append-only grants | traces: FR-005, AC-005-01, AC-005-02, AC-005-03, AC-005-04
  files: src/audit/postgres-logger.js (CREATE), src/audit/logger.js (MODIFY), src/audit/index.js (MODIFY), tests/unit/audit/postgres-logger.test.js (CREATE), tests/integration/audit-grants.test.js (CREATE)
  tests: tests/unit/audit/postgres-logger.test.js (CREATE), tests/integration/audit-grants.test.js (CREATE)
  blocked_by: [T004, T005]
  blocks: [T009, T011]
  description: |
    Replace JSONL runtime audit logging with Postgres audit_entries.
    Verify ks_app cannot update/delete audit rows and ks_maintenance can purge by retention policy.

- [ ] T007 Queue adapter: replace custom SQLite queue with pg-boss | traces: FR-006, AC-006-01, AC-006-02, AC-006-04
  files: src/queue/pgboss-queue.js (CREATE), src/queue/index.js (MODIFY), src/queue/queue.js (DELETE), tests/unit/queue/pgboss-queue.test.js (CREATE), tests/unit/queue/queue.test.js (MODIFY)
  tests: tests/unit/queue/pgboss-queue.test.js (CREATE), tests/unit/queue/queue.test.js (MODIFY)
  blocked_by: [T002, T004]
  blocks: [T008, T011]
  description: |
    Implement a pg-boss-backed queue adapter with the current job types and status semantics.
    Remove the custom SQLite runtime queue after worker wiring is green.

- [ ] T008 Worker wiring: pg-boss handlers and graceful shutdown | traces: FR-006, AC-006-01, AC-006-02, AC-006-03
  files: src/worker/index.js (MODIFY), src/worker/rebuild.js (MODIFY), src/worker/refresh.js (MODIFY), tests/unit/worker/worker.test.js (MODIFY), tests/unit/worker/rebuild.test.js (MODIFY), tests/unit/worker/refresh.test.js (MODIFY), tests/integration/worker-pgboss.test.js (CREATE)
  tests: tests/unit/worker/worker.test.js (MODIFY), tests/integration/worker-pgboss.test.js (CREATE)
  blocked_by: [T007]
  blocks: [T011, T014]
  description: |
    Register pg-boss work handlers for full_rebuild, incremental_refresh, and add_content.
    Ensure stop closes pg-boss and database resources after in-flight work completes.

- [ ] T009 Import/export: JSON config-as-code round trip | traces: FR-007, AC-007-01, AC-007-02, AC-007-03, AC-007-04
  files: src/cli/config.js (CREATE), src/cli/commands.js (MODIFY), src/state/postgres-state-store.js (MODIFY), tests/unit/cli/config.test.js (CREATE), tests/integration/import-export.test.js (CREATE)
  tests: tests/unit/cli/config.test.js (CREATE), tests/integration/import-export.test.js (CREATE)
  blocked_by: [T005, T006]
  blocks: [T014, T015]
  description: |
    Add config export/import for project, all projects, and full deployment.
    Include config, projects, refresh history, audit, import_export_runs, and pg-boss job history where available.

### unit_tests

- [ ] T010 Vector regression: preserve existing vector storage behavior | traces: FR-008, AC-008-01, AC-008-02, AC-008-03
  files: src/vectordb/index.js (MODIFY), tests/unit/vectordb/sqlite-vec.test.js (MODIFY), tests/unit/vectordb/adapter.test.js (MODIFY)
  tests: tests/unit/vectordb/sqlite-vec.test.js (MODIFY), tests/unit/vectordb/adapter.test.js (MODIFY)
  blocked_by: [T002]
  blocks: [T013, T015]
  description: |
    Add regression assertions that vector adapter behavior and sqlite-vec support remain unchanged.
    This task must not migrate vector indexes into Postgres.

### wiring_claude

- [ ] T011 Runtime wiring: API, MCP, CLI, and worker receive Postgres-backed dependencies | traces: FR-002, FR-003, FR-004, FR-006, FR-010
  files: src/api/index.js (MODIFY), src/api/server.js (MODIFY), src/api/rest.js (MODIFY), src/api/mcp.js (MODIFY), src/api/mcp-handlers.js (MODIFY), src/cli/start.js (MODIFY), src/worker/index.js (MODIFY), tests/integration/rest-api-roundtrip.test.js (MODIFY), tests/integration/mcp-tools-end-to-end.test.js (MODIFY)
  tests: tests/integration/rest-api-roundtrip.test.js (MODIFY), tests/integration/mcp-tools-end-to-end.test.js (MODIFY)
  blocked_by: [T003, T004, T005, T006, T007, T008]
  blocks: [T014, T015]
  description: |
    Wire the API, MCP handlers, CLI start path, and worker bootstrap to the shared config, DB pool,
    state store, audit logger, and pg-boss queue.

### wiring_codex

- [ ] T012 Local build guidance: DB env, E2E skip mode, and developer commands | traces: FR-001, FR-009, FR-010, AC-009-01, AC-009-02, AC-010-03
  files: README.md (MODIFY), tests/README.md (MODIFY), docs/requirements/REQ-GH-3-state-store-postgres-only-json-import-export-pgboss/test-strategy.md (MODIFY)
  tests: tests/e2e/postgres-state-store.test.js (MODIFY)
  blocked_by: [T003, T004]
  blocks: [T014]
  description: |
    Document how a local agent or developer supplies KNOWLEDGE_DATABASE_URL and how E2E tests skip
    when it is absent. Include a minimal manual Postgres setup example.

### cleanup

- [ ] T013 Cleanup legacy runtime state paths and docs | traces: FR-002, FR-003, FR-006, FR-008, FR-010
  files: package.json (MODIFY), package-lock.json (MODIFY), docs/architecture/data-model.md (MODIFY), docs/architecture/architecture-overview.md (MODIFY), docs/requirements/REQ-GH-263-centralised-vector-db-carve-out-embedding-server/module-design.md (MODIFY)
  tests: npm run test:unit (VERIFY)
  blocked_by: [T005, T007, T010, T012]
  blocks: [T014, T015]
  description: |
    Remove obsolete JSON/SQLite runtime state references, amend ADR-003/data model docs to declare
    Postgres runtime state, and keep vector sqlite-vec documentation intact.

## Phase 16: Quality Loop -- PENDING

### test_execution

- [ ] T014 Test execution: unit, integration, configured DB E2E or explicit skips | traces: FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010
  files: (no file changes; verification only)
  tests: npm run test:unit (VERIFY), npm run test:integration (VERIFY), npm run test:e2e (VERIFY), git diff --check (VERIFY)
  blocked_by: [T008, T009, T011, T012, T013]
  blocks: [T015, T016]
  description: |
    Run the full verification suite. When DB config is absent, DB E2E must skip with an explicit reason.
    When DB config is present, DB-backed E2E must pass.

### parity_verification

- [ ] T015 Parity verification: behavior preserved except accepted substrate changes | traces: FR-004, FR-006, FR-007, FR-008
  files: docs/requirements/REQ-GH-3-state-store-postgres-only-json-import-export-pgboss/traceability-matrix.csv (MODIFY)
  tests: tests/integration/import-export.test.js (VERIFY), tests/integration/worker-pgboss.test.js (VERIFY), tests/unit/vectordb/sqlite-vec.test.js (VERIFY)
  blocked_by: [T009, T010, T011, T013, T014]
  blocks: [T016, T017]
  description: |
    Verify project CRUD, refresh history, audit query, queue job processing, import/export, and vector
    regression coverage match the accepted requirements.

## Phase 08: Code Review -- PENDING

### constitutional_review

- [ ] T016 Code review: constitutional and security review | traces: FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010
  files: docs/requirements/REQ-GH-3-state-store-postgres-only-json-import-export-pgboss/code-review-report.md (CREATE)
  tests: npm run test:unit (VERIFY), npm run test:integration (VERIFY), npm run test:e2e (VERIFY)
  blocked_by: [T014, T015]
  blocks: [T017]
  description: |
    Review for specification traceability, DB permission safety, credential handling, runtime config clarity,
    and adherence to the accepted no-auto-Docker decision.

### dual_file_check

- [ ] T017 Dual file check: active tasks and REQ artifact consistency | traces: FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010
  files: docs/isdlc/tasks.md (MODIFY), docs/requirements/REQ-GH-3-state-store-postgres-only-json-import-export-pgboss/tasks.md (MODIFY)
  tests: git diff --check (VERIFY)
  blocked_by: [T015, T016]
  blocks: []
  description: |
    Confirm docs/isdlc/tasks.md and the REQ-local tasks.md match or intentionally document any divergence
    before marking the analysis/build handoff complete.

## Dependency Graph

```text
T001
  -> T002, T003
T002 + T003
  -> T004
T004
  -> T005, T007, T012
T005
  -> T006, T009
T007
  -> T008
T003 + T004 + T005 + T006 + T007 + T008
  -> T011
T002
  -> T010
T005 + T007 + T010 + T012
  -> T013
T008 + T009 + T011 + T012 + T013
  -> T014
T009 + T010 + T011 + T013 + T014
  -> T015
T014 + T015
  -> T016
T015 + T016
  -> T017
```

Critical path: T001 -> T003 -> T004 -> T005 -> T007 -> T008 -> T011 -> T014 -> T015 -> T016 -> T017.

## Traceability Matrix

| FR | Requirement | Related Tasks |
|---|---|---|
| FR-001 | Runtime baseline | T002, T012, T014, T016 |
| FR-002 | Central service config | T003, T011, T013, T014, T016 |
| FR-003 | Strict Postgres runtime state | T004, T011, T013, T014, T016 |
| FR-004 | Single data access boundary | T005, T011, T015, T016 |
| FR-005 | DB-level audit enforcement | T004, T006, T014, T016 |
| FR-006 | Maintained Postgres queue | T007, T008, T011, T015, T016 |
| FR-007 | Config import/export | T009, T015, T016 |
| FR-008 | Vector storage unchanged | T010, T013, T015, T016 |
| FR-009 | Configurable DB E2E | T001, T012, T014, T016 |
| FR-010 | Operational DB UX | T003, T011, T012, T013, T016 |

## Assumptions and Inferences

- The original GH-3 Docker auto-launch and testcontainers acceptance items are intentionally amended by accepted roundtable decisions.
- Runtime JSON compatibility is intentionally not implemented because there are no users of the project.
- pg-boss provider limitations around historical job export should be documented if exact custom queue parity is not possible.
