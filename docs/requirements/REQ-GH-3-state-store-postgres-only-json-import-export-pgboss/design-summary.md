# Design Summary: GH#3

## Module Overview

- Runtime config: `.ks/config.json`.
- DB foundation: pool, health, migrations, roles.
- State layer: projects, refresh history, audit, import/export runs.
- Queue: pg-boss adapter.
- Worker: registered pg-boss handlers.

## Module Design

- `src/db/*` owns database lifecycle.
- `src/state/*` owns shared state operations.
- `src/config/*` preserves existing store contracts over Postgres.
- `src/audit/*` stores audit entries in DB.
- `src/queue/*` wraps pg-boss.

## Changes to Existing

- Replace JSON runtime stores.
- Replace SQLite queue.
- Keep vector storage unchanged.

## Wiring Summary

- Setup writes config and instructions.
- Start validates DB and forks API/worker.
- API/MCP/worker receive Postgres-backed stores and pg-boss queue.

## Assumptions and Inferences

- Build should introduce the state layer before rewiring callers.
