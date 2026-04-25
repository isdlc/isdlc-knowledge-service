---
name: project-test-landscape
description: Distilled test landscape -- framework, coverage, gaps, patterns, fragile areas
skill_id: PROJ-004
owner: discover-orchestrator
collaborators: []
project: isdlc-knowledge-service
version: 1.0.0
when_to_use: When writing tests, evaluating coverage, or assessing test strategy
dependencies: []
---

# Project Test Landscape

## Test Framework and Config
- Runner: **Node.js built-in `node --test`** (already wired in package.json: `"test": "node --test src/**/*.test.js"`).
- Assertion: `node:assert/strict`.
- No third-party test framework (no Vitest, Jest, Mocha). Aligned with CON-001 (no build-time coupling) and Article XIII.
- Coverage tool target: `c8` (V8 native), wired in a follow-up. Not a v1 hard gate.

## Coverage Summary (current — fresh project)
| Type | Count | Coverage | Notes |
|------|-------|----------|-------|
| Unit | 1 (smoke) | n/a | Module placeholders only — implementation pending T002+ |
| Integration | 0 | 0% | Per-connector + queue/worker tests pending T034 |
| E2E | 0 | 0% | MCP + REST + cross-project query tests pending T035, T036 |

## Test Pyramid Targets
- Unit ~60% by test count — co-located `src/{module}/{file}.test.js` per module.
- Integration ~30% — `tests/integration/`, one suite per connector type, plus queue↔worker handoff.
- E2E ~10% — `tests/e2e/`: MCP query, REST API, web UI smoke, cross-project query.

## Known Gaps (forward-looking, since project is pre-implementation)
- All adapters need contract-conformance tests (HIGH risk if skipped — pluggability is a top invariant per Article V).
- Every error code in `error-taxonomy.md` (21 codes) needs at least one test (Article XIII).
- Cross-platform smoke (Windows + Linux + macOS) is a release gate.
- Idempotency of incremental refresh (NFR Reliability) needs explicit tests at the integration boundary.

## Fragile Areas (predictive)
- Source connectors that touch external services (Confluence REST, Web scraping, GDocs API) — use HTTP cassettes / fakes.
- ONNX model load — requires fixture model file or a deterministic test model adapter.
- SVN connector wraps the `svn` CLI — needs an SVN dump fixture and a way to run without a real svn binary on CI.
- Vector DB adapters that depend on running services (Qdrant, Milvus, Weaviate, ChromaDB) — gate behind a docker-compose harness or skip when service not present.

## Test Patterns
- Co-located unit tests next to implementation files.
- In-memory fakes for model adapter and Vector DB adapter live under `tests/fakes/` and are reused across tiers.
- Fixtures (mini Git repo, SVN dump, Confluence cassettes, static HTML) under `tests/fixtures/`.
- Adapter contract suite imported and run against every implementation.
- Spawned-process E2E: tests boot API + Worker on ephemeral ports, hit them over HTTP/MCP, tear down.
- All tests deterministic — no real network, no real model inference.

## Provenance
- **Source**: docs/architecture/test-strategy-outline.md, docs/requirements/REQ-GH-263-.../tasks.md (T034-T036), error-taxonomy.md
- **Distilled**: 2026-04-25
- **Discovery run**: full
