# Tests — isdlc-knowledge-service

This project uses **Node.js's built-in test runner** (`node --test`) — no third-party test framework. See `docs/architecture/test-strategy-outline.md` for the full strategy.

## Running

```bash
npm test                            # Co-located unit tests under src/**/*.test.js
node --test tests/unit              # Optional — additional unit tests at the boundary
node --test tests/integration       # Integration tests (T034)
node --test tests/e2e               # End-to-end tests (T035, T036)
node --test                         # Everything node finds
```

## Layout

```
src/{module}/{file}.test.js     # Co-located unit tests, one file per module file
tests/
├── unit/                       # Cross-module unit tests (rare)
├── integration/                # Per-connector pipeline tests, queue+worker handoff
├── e2e/                        # MCP / REST / web UI smoke; cross-project query
├── fixtures/                   # Test data (git repo, svn dump, confluence cassettes, ...)
└── fakes/                      # In-memory adapters (model, vectordb)
```

## Conventions

- Assertions: `node:assert/strict`.
- One `describe(...)` per module / feature.
- Tests are deterministic — no real network calls, no real model inference. Use fakes.
- Every error code in `docs/requirements/REQ-GH-263-.../error-taxonomy.md` MUST be exercised by at least one test (Constitution Article XIII).

## Smoke test

A trivial smoke test lives at `tests/unit/smoke.test.js` to confirm the runner is wired correctly.
