# Test Strategy Outline: isdlc-knowledge-service

**Status**: Draft (outline)
**Source**: REQ-GH-263 task plan — T034 Integration tests, T035 E2E tests, T036 Cross-project query tests
**Last Updated**: 2026-04-25

> This document is an **outline**. Detailed test cases per FR/AC will be filled in during the test-strategy phase of the build workflow. The runner and pyramid shape are committed.

---

## 1. Test Runner

**Decision**: **Node.js built-in test runner** (`node --test`).

- Already wired in `package.json`: `"test": "node --test src/**/*.test.js"`.
- Co-located test files: `src/{module}/{file}.test.js` next to each module.
- Higher tiers live under `tests/integration/` and `tests/e2e/` — also runnable through `node --test`.
- Assertion library: `node:assert/strict`.
- No third-party test framework dependency (no Vitest, no Jest) — keeps the dep tree minimal and aligns with CON-001 (no build-time coupling) and the cross-platform NFR.

**Coverage**: `c8` (lightweight, native V8 coverage) when coverage measurement is added in a follow-up task. Not blocking for v1.

---

## 2. Test Pyramid

```
            ┌────────────────────────┐
            │   E2E (T035, T036)     │   ~10%
            │   MCP / REST / Web UI  │
            └────────────────────────┘
        ┌──────────────────────────────┐
        │   Integration (T034)         │   ~30%
        │   Pipeline + queue + worker  │
        │   per connector type         │
        └──────────────────────────────┘
   ┌────────────────────────────────────────┐
   │   Unit (per module)                    │   ~60%
   │   Adapters, modules in isolation       │
   └────────────────────────────────────────┘
```

### 2.1 Unit Tests (per module)
- One test file per module file: `src/queue/queue.test.js`, `src/config/project-store.test.js`, etc.
- Each adapter — model adapter, vector DB adapter, source connector — has its own unit tests with the dependency mocked or replaced by an in-memory fake.
- Targets:
  - **Adapters share a common interface** invariant — every adapter implements the same shape. Each has a contract-conformance test that exercises the full interface (e.g., for Vector DB: `store` then `search` then `delete` then `stats`).
  - **Pure logic** — chunking, correlation strategies, staleness badge computation, ranking/merging, audit log rotation, idempotency-key derivation.
  - **Error handling** — every error code in `error-taxonomy.md` has at least one unit test that triggers and asserts the recovery path.
- Speed budget: full unit suite runs in **< 30 s** on a developer machine.

### 2.2 Integration Tests — `tests/integration/` (T034)
Boundary: full pipeline within the Worker process, plus the API ↔ Worker queue handoff.

- **Per connector type** (Git, SVN, Confluence, Web, GDocs, Filesystem):
  1. Crawl from a fixture source (test repos / mock HTTP server / fixture filesystem).
  2. Produce normalised chunks.
  3. Run through correlation engine.
  4. Embed via a deterministic test model adapter (returns fixed vectors per content hash).
  5. Store via the SQLite-vec adapter.
  6. Assert chunks + relationships landed correctly.
- **Queue handoff**: API enqueues job → Worker dequeues, processes, completes → status surfaced via `getStatus`.
- **Incremental refresh idempotency** (NFR Reliability): re-running the same refresh produces the same final state.
- **Two-process integrity** (NFR Isolation): API stays responsive while Worker is busy embedding.

### 2.3 E2E Tests — `tests/e2e/` (T035, T036)
Boundary: a running API + Worker pair (spawned by the test harness on ephemeral ports).

- **MCP query** (T035): start service → seed project + index via `add_content` → call `semantic_search({ query, projects })` over MCP → assert results returned + tagged.
- **REST API** (T035): project CRUD round-trip; `POST /api/refresh` → eventual completion via `GET /api/projects/:id/status`; `GET /api/system/health`; `GET /metrics` returns Prometheus text.
- **Web UI** (T035): smoke-test via plain HTTP requests against `/` and the static assets — no headless-browser dep for v1.
- **Cross-project query** (T036): seed two projects with overlapping vocabulary → query both → assert merge + ranking + per-project tagging is correct (FR-006).

---

## 3. Test Data and Fixtures

| Fixture | Location | Used by |
|---|---|---|
| Mini Git repo (commits, branches) | `tests/fixtures/git-repo/` | Git connector tests |
| SVN dump | `tests/fixtures/svn-dump/` | SVN connector tests |
| Confluence REST recordings (HTTP cassettes) | `tests/fixtures/confluence/` | Confluence connector tests |
| Static HTML pages | `tests/fixtures/web/` | Web connector tests |
| Sample shared folder | `tests/fixtures/filesystem/` | Filesystem connector tests |
| Pre-correlated chunks | `tests/fixtures/chunks/` | Pipeline + Correlation tests |
| Deterministic test model | `tests/fakes/test-model-adapter.js` | All embedding-bearing tests |
| In-memory vector DB | `tests/fakes/in-memory-vectordb-adapter.js` | All vector-store-bearing tests |

---

## 4. CI Gates (forward-looking)

| Gate | Threshold |
|---|---|
| Lint (`npm run lint`) | 0 errors |
| Unit tests | 100% pass |
| Integration tests | 100% pass |
| E2E tests | 100% pass |
| Coverage (c8) — when wired | ≥ 80% line, ≥ 70% branch on `src/` (target, not v1 hard gate) |
| Cross-platform smoke | Test matrix includes Windows + Linux + macOS |

---

## 5. Traceability to FRs

| Test tier | Primary FRs covered |
|---|---|
| Unit per module | FR-001, FR-002, FR-003, FR-005, FR-008, FR-009, FR-011, FR-014, FR-015 |
| Integration (T034) | FR-002, FR-003, FR-004 |
| E2E MCP/REST/UI (T035) | FR-006, FR-007, FR-008 |
| Cross-project query (T036) | FR-006 |
| Audit/security spot tests | FR-014 |
| Cross-platform CLI smoke | FR-010, FR-012 |

---

## 6. Out of Scope for v1 Test Strategy

- Mutation testing (Stryker) — defer to post-v1 quality loop.
- Property-based testing — defer; `node:test` does not ship a generator library.
- Performance / load testing under cloud quotas — covered in a separate operational test plan.
- Headless browser tests for the web UI — plain HTTP smoke is sufficient given CON-004 (vanilla HTML, no SPA logic).

---

## 7. References
- Architecture: `docs/architecture/architecture-overview.md`
- Data model: `docs/architecture/data-model.md`
- Task plan: `docs/requirements/REQ-GH-263-.../tasks.md`
- Error taxonomy (must be exercised): `docs/requirements/REQ-GH-263-.../error-taxonomy.md`
- Constitution: `docs/isdlc/constitution.md`
