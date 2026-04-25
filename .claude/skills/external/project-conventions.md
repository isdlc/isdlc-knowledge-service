---
name: project-conventions
description: Distilled project conventions -- naming, error handling, file organization, patterns
skill_id: PROJ-002
owner: discover-orchestrator
collaborators: []
project: isdlc-knowledge-service
version: 1.0.0
when_to_use: When writing new code, reviewing code, or making style decisions
dependencies: []
---

# Project Conventions

## Naming Conventions
- Files: kebab-case for modules (`project-store.js`, `qdrant-cloud.js`); camelCase identifiers inside.
- Functions/methods: camelCase (`startServer`, `addRefreshRecord`, `getAdapter`).
- Constants: UPPER_SNAKE_CASE only for true module-level constants.
- Project IDs: `{slug(name)}-{version}` (e.g. `payments-2.7`); enforced by Config Store, 409 on duplicate.
- Error codes: `ERR-<DOMAIN>-<NNN>` (`ERR-CONN-001`, `ERR-MODEL-002`, `ERR-QUEUE-001`); see error-taxonomy.md.

## Module / File Organization
- One module per `src/{domain}/` directory.
- Public interface in `src/{domain}/index.js`.
- Implementation files siblings (`src/connectors/git.js`, `src/connectors/svn.js`, etc.).
- Submodules sit alongside (`src/observability/{metrics,tracing,staleness}.js`).
- Tests co-located: `src/{domain}/{file}.test.js`. Higher tiers under `tests/{unit,integration,e2e}/`.
- Fixtures: `tests/fixtures/`. Fakes (in-memory adapters): `tests/fakes/`.

## Module System
- ESM throughout (`"type": "module"`, Node >= 18).
- All imports use the explicit file extension (`./manager.js`, not `./manager`).

## Adapter Contracts
- **Vector DB adapter**: `store(vectors)`, `search(query, opts)`, `delete(ids)`, `deleteAll()`, `stats()`. Every implementation passes the same contract suite.
- **Model adapter**: `embed(text)`, `batchEmbed(texts[])`, `getInfo()`. Every implementation passes the same contract suite.
- **Source connector**: `crawl(config)`, `diff(config, since)` returning `NormalisedChunk[]`. Output shape uniform across Git/SVN/Confluence/Web/GDocs/Filesystem.

## Error Handling Patterns
- All error paths use coded errors from `docs/requirements/REQ-GH-263-.../error-taxonomy.md`.
- Connector failures (ERR-CONN-001 unreachable, ERR-CONN-002 auth) log to refresh history, do NOT crash the Worker.
- Cloud-API model failures (ERR-MODEL-002) retry with backoff up to 3 attempts before failing the job.
- Job queue failures dead-letter at `max_attempts` (default 3, ERR-QUEUE-001).
- Vector DB write failures roll back transactionally (INT-007); partial writes are not committed.
- iSDLC `add_content` integration fail-open at the iSDLC side; the service simply returns whatever it can.

## Security Patterns
- Credentials never inline in `config.json` — only `api_key_ref` / `credentials_ref` (env var name or secret-store id). Schema validator rejects bare strings.
- Audit log is append-only; no modify/delete path exists in code or UI (Constitution Article VII).
- All MCP and REST inputs validated before reaching connectors or queue; rejections return error codes.

## Testing Patterns
- Test runner: **`node --test`** built-in only — no Vitest, Jest, Mocha. `package.json` already wired.
- Assertions: `node:assert/strict`.
- Every error code has at least one test that triggers it and asserts the recovery path (Article XIII).
- Adapter contract tests run once per implementation.

## Web UI Conventions (CON-004, Article XI)
- Plain HTML + vanilla JS only. No React/Vue/Svelte/Next/Vite/webpack.
- Static assets served by API process; no build step.
- UI talks to the same REST endpoints as external clients — no second back-channel.

## Cross-Platform Conventions
- Pure Node.js — no shell scripts, no platform conditionals beyond `path` and `os` standard modules.
- File paths constructed via `path.join` / `path.resolve`, never hardcoded separators.

## Provenance
- **Source**: docs/isdlc/constitution.md, docs/requirements/REQ-GH-263-.../requirements-spec.md (CON-001..004), error-taxonomy.md, module-design.md
- **Distilled**: 2026-04-25
- **Discovery run**: full
