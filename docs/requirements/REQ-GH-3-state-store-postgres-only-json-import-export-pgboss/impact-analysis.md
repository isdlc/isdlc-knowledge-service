# Impact Analysis: REQ-GH-3 Postgres state substrate

**Source**: GitHub Issue #3
**Last updated**: 2026-04-27

## Sizing Metrics

| Metric | Estimate |
|---|---|
| Files affected | 30-45 |
| Modules touched | CLI, config, DB, state, audit, queue, worker, API, tests, docs |
| Risk score | high |
| Coupling | high |
| Recommended tier | Epic |

## Blast Radius

| Area | Impact |
|---|---|
| Runtime | Node runtime moves from 18+ to 22.12+. |
| Persistence | JSON project config, refresh history, JSONL audit, and SQLite queue are replaced by Postgres. |
| CLI | setup/start/status/config commands change runtime config and DB behavior. |
| API/MCP | Public behavior remains stable, but dependency wiring moves to Postgres stores. |
| Worker | Queue loop moves from custom polling to pg-boss workers. |
| Tests | DB E2E is opt-in/configured; unit tests should mock/fake DB boundaries where possible. |
| Docs | ADR-003 and data model docs must declare Postgres as runtime state substrate. |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Runtime bump breaks local environments | medium | Document Node 22.12+ and fail early. |
| Queue semantics drift from custom queue | high | Contract tests for enqueue, process, retry, failure, and dead-letter behavior. |
| DB permissions are under-tested | high | DB integration tests for `ks_app` and `ks_maintenance` grants. |
| Import/export misses operational history | medium | Explicit export manifest and round-trip tests. |
| Vector SQLite support accidentally removed | medium | Regression tests for sqlite-vec path and dependency review. |

## Implementation Strategy

1. Establish runtime/config/DB foundation first.
2. Add state layer and migrations before rewiring callers.
3. Replace audit and queue after the shared DB boundary exists.
4. Rewire worker/API/CLI entry points.
5. Add import/export and operational documentation.
6. Run configured DB E2E where available; otherwise verify skip behavior.
