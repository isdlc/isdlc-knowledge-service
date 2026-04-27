# Architecture Summary: GH#3

## Architecture Options

- Option A: Graphile Worker. Viable, not selected.
- Option B: pg-boss. Selected with Node runtime bump.
- Option C: PGMQ. Too primitive for current worker semantics.

## Selected Architecture

- PostgreSQL is the runtime state substrate.
- pg-boss owns queue state.
- `.ks/config.json` owns runtime config.
- Vector storage remains unchanged.

## Technology Decisions

- Node `>=22.12.0`.
- PostgreSQL 14+.
- `pg` and `pg-boss`.
- DB roles: `ks_owner`, `ks_app`, `ks_maintenance`.

## Integration Architecture

- CLI setup/start load config and validate DB.
- API, MCP, worker, audit, queue, and import/export use shared DB/state dependencies.

## Assumptions and Inferences

- The service fails when Postgres is unavailable at runtime.
- E2E can skip when DB config is absent.
