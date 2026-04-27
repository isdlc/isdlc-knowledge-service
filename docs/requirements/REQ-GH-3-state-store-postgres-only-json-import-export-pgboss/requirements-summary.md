# Requirements Summary: GH#3

## Functional Requirements

- Full GH-3 scope is in.
- `.ks/config.json` is the single runtime config file.
- PostgreSQL is the only runtime state substrate.
- Runtime JSON compatibility is not required.
- pg-boss is the queue provider, requiring Node 22.12+.
- Import/export is part of the first delivery.
- Audit append-only behavior is enforced by DB roles.

## Assumptions and Inferences

- No live users means no runtime migration path is required.
- Original issue text is amended: no Docker auto-launch and no mandatory DB E2E when DB config is absent.

## Non-Functional Requirements

- Operational errors must be clear.
- Secrets remain env-var references.
- DB tests must be deterministic and skip explicitly when unconfigured.

## Out of Scope

- Vector storage migration.
- Cross-RDBMS support.
- Auto-launching Postgres.

## Prioritization

- Must: Postgres substrate, `.ks/config.json`, pg-boss, audit roles, import/export.
- Must not regress: vector storage.
