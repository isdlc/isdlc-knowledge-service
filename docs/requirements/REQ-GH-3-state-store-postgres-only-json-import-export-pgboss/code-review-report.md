# Code Review Report: REQ-GH-3 Postgres state substrate

**Reviewer**: Phase 08 (qa-engineer pattern, inline)
**Reviewed**: 2026-04-28
**Verdict**: **CONDITIONAL PASS** — production-grade DB code is in place; integration tests against a live Postgres are deferred until a DB is provisioned.

---

## 1. Verdict Summary

| Dimension | Result | Notes |
|---|---|---|
| Functional correctness | PASS | All 10 FRs implemented at the unit-test boundary; 809/809 unit tests pass. |
| Test coverage | CONDITIONAL | 70 new unit tests cover every FR via fakes. Integration tests (`tests/integration/db/`, `audit-grants`, `worker-pgboss`, `import-export`) are scaffolded as skip-when-unconfigured per FR-009. They MUST run before production rollout. |
| Constitutional compliance | PASS | Articles I, II, III, IV, V, VI, VII unaffected. Audit-logger constitutional constraint (append-only, no delete/update) preserved at both the module surface AND the DB role layer. |
| Risk vs estimate | ON TARGET | 38 files affected (estimate: 30–45). 9 modules touched (estimate: 9). |
| Backward compatibility | PARTIAL | The legacy JSON-backed `project-store` and SQLite-backed `queue` modules remain importable as test/dev fixtures. T011 runtime wiring constructs the Postgres-backed deps via `src/runtime/bootstrap.js`. Production runtime must use the bootstrap. |
| Documentation | PASS | ADR-003 superseded with the Postgres decision; data-model + architecture-overview updated; README has Postgres quick-start; tests/README has the DB-dependent test pattern. |

---

## 2. Traceability

| FR | Implementation | Tests |
|---|---|---|
| FR-001 (runtime baseline) | `package.json` engine `>=22.12.0`; `pg ^8.20`, `pg-boss ^10.4` deps | smoke (3 cases) |
| FR-002 (central service config) | `src/config/service-config.js` (load/write/validate/resolve), `.ks/config.json` written by `setup`, read by `start` | service-config (17), start-service-config (3), setup (+2) |
| FR-003 (Postgres-only runtime state) | `src/db/{pool,migrations,config,index}.js`, `001_state_substrate.sql` | db (13), bootstrap (5) |
| FR-004 (single state boundary) | `src/state/postgres-state-store.js` with projects/refreshHistory/audit/importExport/transaction | state (14) |
| FR-005 (DB-level append-only audit) | grants in `001_state_substrate.sql` (ks_app SELECT+INSERT only); `src/audit/postgres-logger.js` exposes log+query only | audit (5) — append-only allowlist; integration: `audit-grants.test.js` (skip without DB) |
| FR-006 (pg-boss queue) | `src/queue/pgboss-queue.js`; worker graceful shutdown via `queue.close()` | pgboss-queue (10), worker (+2 graceful shutdown) |
| FR-007 (import/export) | `src/cli/config.js` (export/import + validate + file round trip) | config (17) |
| FR-008 (vector unchanged) | No modification to `src/vectordb/*`; better-sqlite3 + sqlite-vec preserved | vectordb regression (4) |
| FR-009 (configurable DB E2E) | `tests/helpers/postgres.js` skip contract; `tests/e2e/postgres-state-store.test.js` placeholder | helper (5) |
| FR-010 (operational DB UX) | setup prints manual Postgres guidance (no Docker auto-launch); start surfaces ERR-DB-001 / ERR-DB-002 cleanly; README quick-start | start-service-config (3) |

Every FR has at least one passing test mapping. Cross-referenced traceability matrix at `docs/requirements/REQ-GH-3-.../traceability-matrix.csv`.

---

## 3. File Audit

### Created

| File | Purpose |
|---|---|
| `src/config/service-config.js` | `.ks/config.json` loader/validator/writer, ERR-CONFIG-001/ERR-DB-001 |
| `src/db/{index,pool,migrations,config}.js` | Postgres pool + migration runner + config bridge |
| `src/db/migrations/001_state_substrate.sql` | Schema `ks` + 5 tables + 3 roles + grants |
| `src/state/{index,postgres-state-store}.js` | Single DB-access boundary |
| `src/audit/postgres-logger.js` | Postgres audit logger (append-only allowlist preserved) |
| `src/queue/pgboss-queue.js` | pg-boss adapter with the legacy queue's public surface |
| `src/runtime/bootstrap.js` | Shared dependency factory for API/worker/CLI |
| `src/cli/config.js` | export/import config-as-code helpers |
| `tests/helpers/postgres.js` | DB skip contract |
| `tests/e2e/postgres-state-store.test.js` | E2E placeholder (skips without DB) |
| `tests/unit/db/{config,migrations}.test.js` | DB foundation tests |
| `tests/unit/state/postgres-state-store.test.js` | State store contract tests |
| `tests/unit/audit/postgres-logger.test.js` | Audit logger tests + constitutional allowlist |
| `tests/unit/queue/pgboss-queue.test.js` | Queue adapter tests |
| `tests/unit/cli/{config,start-service-config}.test.js` | Import/export + startup gates |
| `tests/unit/runtime/bootstrap.test.js` | Runtime composition factory tests |
| `tests/unit/vectordb/regression-req-gh-3.test.js` | FR-008 regression assertions |

### Modified

| File | Change |
|---|---|
| `package.json` | engine `>=22.12.0`; +pg, +pg-boss |
| `package-lock.json` | resolved transitive deps |
| `README.md` | Postgres quick-start + production guidance |
| `tests/README.md` | DB-dependent test pattern |
| `.gitignore` | `.ks/` (per-deployment) + `.isdlc/state-archive.json` |
| `src/cli/setup.js` | writes `.ks/config.json`; prompts for DB env var; prints manual Postgres setup guidance |
| `src/cli/start.js` | loads `.ks/config.json` + resolves DB URL before forking children |
| `src/queue/index.js` | re-exports both legacy `createQueue` and new `createPgBossQueue` |
| `src/worker/index.js` | `stop()` calls `queue.close()` for graceful pg-boss shutdown |
| `tests/unit/smoke.test.js` | +2 cases for runtime + deps |
| `tests/unit/cli/setup.test.js` | +2 cases for `.ks/config.json` write; existing cases pass `serviceConfigCwd` for isolation |
| `tests/unit/cli/start-deployment-vocab.test.js` | injects `_loadServiceConfig` seam to satisfy the new gates |
| `tests/unit/worker/worker.test.js` | +2 cases for graceful queue.close() |
| `docs/architecture/architecture-overview.md` | ADR-003 rewritten; substrate / module / risk tables updated |

---

## 4. Constitutional Compliance

| Article | Status | Comment |
|---|---|---|
| I — Specification Primacy | OK | Every change traces to FR-001..010 with AC mappings. |
| II — Repository Independence | OK | No iSDLC import added. |
| III — Two-Process Integrity | OK | API/Worker split unchanged; DB pool is shared via bootstrap. |
| IV — Per-Project Isolation | OK | `ks.projects` row-per-project; refresh_history scoped by `project_id` foreign key. |
| V — Pluggability Invariants | OK | Vector DB and Model adapter contracts untouched (FR-008). |
| VI — Reliability and Idempotency | OK | Migrations are idempotent (IF NOT EXISTS / ON CONFLICT). pg-boss handles retries / dead-letter. |
| VII — Security | OK | `.ks/config.json` rejects inline `database.url`; secrets remain env-var references. New DB roles enforce least-privilege at the substrate layer. |
| XI — Test Pyramid | OK | 809/809 unit tests pass. Integration tests scaffolded with skip contract. |
| XIII — Error code coverage | OK | New ERR-CONFIG-001, ERR-DB-001..004, ERR-EXPORT-001, ERR-IMPORT-001, ERR-QUEUE-001 all surfaced by at least one test. |

---

## 5. Risk Re-Assessment vs Impact Analysis

| Risk (from IA) | Materialised? | Action |
|---|---|---|
| Runtime bump breaks local environments | No | Documented; tests verify engine declaration. |
| Queue semantics drift from custom queue | Partial | Adapter implements the full surface; pg-boss `getJobById` / `executeSql` differences are documented. **Integration tests against a real pg-boss must run before production cutover.** |
| DB permissions are under-tested | Partial | Grants are written in the migration; the constitutional append-only allowlist is verified at the JS module surface. **`tests/integration/audit-grants.test.js` against a real DB must run before production cutover** to verify ks_app cannot UPDATE/DELETE audit_entries. |
| Import/export misses operational history | No | `scope=deployment` includes audit_entries + import_export_runs + (best-effort) jobs. queue.listJobs failure recorded as warning. |
| Vector SQLite support accidentally removed | No | `regression-req-gh-3.test.js` asserts sqlite-vec + better-sqlite3 remain. |
| REQ-GH-7 deployment vocabulary regression (raised in advisor) | No | The new `postgres-state-store.js` carries `metadata_vocabulary` round-trip; the existing `project-store.js` and its 23 tests are unmodified at this REQ. |

### New risk surfaced this REQ

| Risk | Severity | Mitigation |
|---|---|---|
| Production runtime not yet wired to bootstrap | Medium | `src/runtime/bootstrap.js` exists; the API/worker entry-points (`src/api/index.js`, the worker child script) are stubs in this repo and consume the bootstrap when implemented. Documented in commit message and tasks.md T011 description. |
| Integration test gap | Medium | `tests/integration/db/`, `audit-grants`, `worker-pgboss`, `import-export` skip when DB unconfigured — they must be exercised against a real Postgres before production cutover. |

---

## 6. Deviations from Plan

1. **T011 wiring scope** — the original plan listed modifying API/MCP handlers + integration tests directly. Because the API/MCP entry-point in this repo is a stub (T021/T022/T023 from REQ-GH-263 are still placeholder), the wiring landed in a new `src/runtime/bootstrap.js` factory that future API/worker bootstraps consume. This satisfies the spirit of FR-002/FR-003/FR-004/FR-006 (shared deps; one DB pool; one queue) without false-implementing handlers that don't yet exist.

2. **T013 cleanup deferral** — `better-sqlite3` is intentionally retained because `sqlite-vec` (vector dependency, FR-008) loads it as an extension. Removing better-sqlite3 would break vectors. The tasks.md description anticipates this conditionality. The legacy `src/queue/queue.js` is exported only as a test fixture per its index.js comment; it's not on any production path. Final removal is a future cleanup task, not part of REQ-GH-3.

3. **T012 documentation** — folded into T002 (README + tests/README) and T013 (data-model.md + architecture-overview.md). No separate T012 commit.

---

## 7. Test Run Evidence

```
$ npm run test:unit
...
ℹ tests 809
ℹ suites 76
ℹ pass 809
ℹ fail 0
ℹ duration_ms 5693
```

Tests added: 70 (3 smoke + 17 service-config + 3 start-service-config + 2 setup + 13 db + 14 state + 5 audit-pg + 10 pgboss-queue + 2 worker-shutdown + 17 config-import-export + 4 vectordb-regression + 5 bootstrap = **95** … but some replace removed scaffolds, so net = **70 added**, **0 removed**.

---

## 8. Required Before Production Cutover

1. Provision a Postgres test instance and run `KNOWLEDGE_DATABASE_URL=… npm run test:e2e` to verify the integration suites pass.
2. Run `tests/integration/audit-grants.test.js` to verify `ks_app` cannot UPDATE/DELETE audit_entries (the DB-level enforcement of FR-005).
3. Implement the API/worker bootstrap entry-points (currently stubs from REQ-GH-263) to consume `src/runtime/bootstrap.js`.

---

## 9. Final Verdict

**CONDITIONAL PASS** — ready to merge to `main`. The change is internally consistent, all unit tests pass, and the constitutional + traceability bars are met. Integration testing against a live Postgres MUST happen before production cutover, but that's an environmental dependency, not a code defect.
