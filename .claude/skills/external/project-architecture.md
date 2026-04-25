---
name: project-architecture
description: Distilled project architecture -- components, boundaries, data flow, key patterns
skill_id: PROJ-001
owner: discover-orchestrator
collaborators: []
project: isdlc-knowledge-service
version: 1.0.0
when_to_use: When making architectural decisions, assessing impact, or designing modules
dependencies: []
---

# Project Architecture

## Components (14 modules)
- **API Server** (`src/api/`): Serves MCP + REST + web UI; stateless query routing.
- **Query Engine** (`src/query/`): Fan-out search across per-project Vector DB indexes; merge, rank, tag.
- **Worker** (`src/worker/`): Processes jobs — full rebuild, incremental refresh, add_content.
- **Source Connectors** (`src/connectors/`): Pluggable crawlers (Git, SVN, Confluence, Web, GDocs, Filesystem) producing `NormalisedChunk`.
- **Correlation Engine** (`src/correlation/`): Links chunks across sources within a project (path/name, iSDLC trace, Confluence-title, import graph).
- **Embedding Pipeline** (`src/pipeline/`): Enriches correlated chunks with relationship context, generates vectors.
- **Model Adapters** (`src/models/`): Unified `embed/batchEmbed/getInfo` interface — local ONNX + cloud (OpenAI, Cohere, Bedrock).
- **Model Manager** (`src/models/manager.js`): Local-only lifecycle — load, pin, LRU evict, memory tracking.
- **Vector DB Adapters** (`src/vectordb/`): Unified `store/search/delete/deleteAll/stats` — 11 backends (6 local, 5 remote).
- **Job Queue** (`src/queue/`): SQLite-backed (BetterSqlite3); `enqueue/dequeue/complete/fail/getStatus/listJobs`.
- **Config Store** (`src/config/`): Project CRUD + refresh history; JSON files at `data/projects/{id}/`.
- **CLI** (`src/cli/`): npm bin — setup wizard, start, stop, status, logs, reset. Cross-platform pure Node.
- **Audit Logger** (`src/audit/`): Append-only JSONL at `data/audit.jsonl`, size-rotated.
- **Observability** (`src/observability/`): Prometheus `/metrics`, OTLP traces, staleness detection.

## Data Flow
- **Full Rebuild**: Web UI → API enqueues full_rebuild → Worker dequeues → Connectors crawl all → Correlation matches code↔docs↔tests → Pipeline embeds → Vector DB clears + stores → Config Store appends RefreshRecord.
- **Incremental Refresh**: CI/CD POST /api/refresh → API enqueues incremental_refresh → Worker dequeues → Connector diff → Correlation re-matches changed → Pipeline embeds changed chunks → Vector DB upserts → RefreshRecord appended.
- **Developer Query**: iSDLC MCP → API receives semantic_search → Query Engine embeds query → fan-out across project indexes → merge + rank + per-project tag → return.

## Integration Points
| Integration | Type | Protocol | Notes |
|-------------|------|----------|-------|
| iSDLC (developer) | External | MCP over HTTP | semantic_search, list_projects, list_modules |
| iSDLC (finalize) | External | MCP add_content | Fail-open at iSDLC side |
| GitHub Actions / Jenkins | External | POST /api/refresh | JSON, idempotent |
| Team lead | External | HTTP web UI | Plain HTML + REST |
| API → Worker | Internal | SQLite job queue | JSON job records, dead letter at 3 retries |
| Worker → Vector DB | Internal | DB adapter | Transactional, rollback on failure |

## Architectural Patterns
- **Two-Process Split (ADR-001)**: API never blocks on embedding; Worker owns CPU/memory. SQLite queue coordinates.
- **Pluggable Adapters (ADR-002, ADR-004)**: Vector DB and model adapters share common interfaces; per-project selection; no default Vector DB.
- **JSON File Config (ADR-003)**: Project configs at `data/projects/{id}/config.json`; refresh history at `data/projects/{id}/refresh-history.json`.
- **Per-Project Isolation**: One directory + one index per project; failures contained to single project.
- **Append-Only Audit**: JSONL writer with no overwrite path; size rotation; web UI is view-only.
- **Credential References**: `api_key_ref` / `credentials_ref` in config files; bare credentials rejected by validator.
- **Cross-Platform CLI**: Pure Node.js, no shell scripts (Windows + Linux + macOS).

## Provenance
- **Source**: docs/architecture/architecture-overview.md, docs/architecture/data-model.md, docs/requirements/REQ-GH-263-.../module-design.md
- **Distilled**: 2026-04-25
- **Discovery run**: full (REQ-GH-263 artifacts pre-existed)
