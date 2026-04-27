# Test Strategy: GH#3 Postgres state substrate

## Scope

This strategy covers the Postgres runtime state migration, pg-boss queue adapter, `.ks/config.json`, DB audit roles, import/export, and DB-backed E2E behavior. Vector storage behavior is regression-only and remains outside the migration.

## Approach

| Layer | Coverage |
|---|---|
| Unit | Config loader, DB URL resolution, migration planner, state store SQL mapping with fakes, import/export validation, queue adapter mapping. |
| DB integration | Migrations, grants, audit append-only enforcement, project/refresh persistence, transaction rollback. |
| Worker integration | pg-boss enqueue, handler execution, completion, retry/failure, graceful shutdown. |
| E2E | Setup/start validation, create project, enqueue rebuild, audit query, export/import round trip. Skips when DB config is absent. |
| Regression | Existing vector adapter tests and sqlite-vec behavior. |

## Entry/Exit Criteria

**Entry criteria**:
- Requirements, architecture, design, and task traceability are accepted.
- Node 22.12+ is available for DB/queue implementation work.
- A Postgres connection string is available for DB integration/E2E, or tests are expected to skip with an explicit reason.

**Exit criteria**:
- `npm run test:unit` passes.
- DB integration tests pass when `KNOWLEDGE_DATABASE_URL` or equivalent test DB config is present.
- `npm run test:e2e` skips DB E2E with an explicit reason when config is absent.
- Config import/export round trip proves projects, refresh history, audit, and operational history are preserved.
- Queue tests prove existing job types and failure semantics.

## Traceability

| FR | Test Focus |
|---|---|
| FR-001 | package runtime and dependency checks |
| FR-002 | config loader and setup/start paths |
| FR-003 | migration and startup DB health checks |
| FR-004 | state layer CRUD and transaction behavior |
| FR-005 | audit grants and maintenance purge role |
| FR-006 | pg-boss queue contract and worker processing |
| FR-007 | import/export validation and round trip |
| FR-008 | vector adapter regression |
| FR-009 | E2E skip/configured behavior |
| FR-010 | operational error messages and docs |
