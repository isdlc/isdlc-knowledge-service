---
name: project-domain
description: Distilled project domain -- terminology, business rules, feature catalog
skill_id: PROJ-003
owner: discover-orchestrator
collaborators: []
project: isdlc-knowledge-service
version: 1.0.0
when_to_use: When understanding business context, writing requirements, or naming domain concepts
dependencies: []
---

# Project Domain

## Domain Terminology
| Term | Definition |
|------|-----------|
| **Project** | A module + version combination (e.g. "Payments 2.7"). The unit of isolation, indexing, and search scope. |
| **Source** | A configured input to a project: Git repo, SVN repo, Confluence root, website root, Google Docs folder, or filesystem path. |
| **Connector** | The implementation that crawls a Source and produces NormalisedChunks. |
| **NormalisedChunk** | Uniform output of every connector: `{ content, path, source_type, source_url, last_modified, metadata }`. |
| **CorrelatedChunk** | A NormalisedChunk decorated with `related[]` — links to spec/test/doc/impl found via the Correlation Engine. |
| **EmbeddedChunk** | A vector + content + metadata + related_sources, persisted in the Vector DB. |
| **Full Rebuild** | Re-crawl all sources for a project, re-embed everything, replace the index. Triggered from the web UI. |
| **Incremental Refresh** | Re-embed only changed files plus their correlated sources. Triggered from CI/CD via `POST /api/refresh`. |
| **Pinned Model** | A local ONNX model held in memory permanently (skips LRU eviction). |
| **Staleness** | Per-project freshness status — fresh / stale / unknown — computed from last indexed revision vs current source state. |
| **Refresh Record** | One entry in refresh-history.json: `{ timestamp, type, trigger_source, duration_seconds, documents_processed, status, error }`. |
| **Audit Entry** | One entry in audit.jsonl: `{ timestamp, action, project_id?, details, ip_address }`. |

## Personas
- **Team Lead (Admin)**: Owns the knowledge service. Creates projects, attaches sources, configures model + Vector DB, pins models, triggers rebuilds, reviews audit log.
- **Developer (Consumer)**: Configures `.isdlc/config.json` with `knowledge.projects`. Issues semantic_search via iSDLC over MCP.
- **Standalone User**: Uses the service without iSDLC; admin + consumer combined; wires CI/CD refresh manually.

## Business Rules
- A project IS a (module, version) pair — duplicates rejected with HTTP 409 on POST /api/projects.
- Per-project indexes are FULLY ISOLATED — a corrupt one MUST NOT affect any other.
- Both Git AND SVN are first-class sources (CON-003).
- Incremental refresh MUST be idempotent — re-running with same input is a no-op.
- Cross-project relationship correlation is OUT OF SCOPE for v1 — correlation is within a single project only.
- The web UI MUST be plain HTML — no frontend framework (CON-004).
- The service MUST work without iSDLC (FR-012); iSDLC integration is over MCP only (CON-002).
- Credentials NEVER appear inline in config files — only references.
- Audit log entries CANNOT be modified or deleted via the UI.
- Model/precision change for a project triggers a full rebuild for that project only (FR-009 AC-009-05).
- Search results are ALWAYS tagged with their source project.

## Feature Catalog (16 FRs)
| FR | Title | MoSCoW |
|----|-------|--------|
| FR-001 | Project Management (CRUD, sources, isolated indexes, module+version) | Must |
| FR-002 | Relationship-Aware Embedding Pipeline | Must |
| FR-003 | Source Connectors (Git, SVN, Confluence Must; Web, GDocs, Filesystem Should) | Must / Should |
| FR-004 | Incremental Refresh via CI/CD | Must |
| FR-005 | Full Rebuild | Must |
| FR-006 | Developer Query Scope (.isdlc/config.json knowledge.projects) | Must |
| FR-007 | Web UI (Admin Dashboard, 4 tabs) | Must |
| FR-008 | MCP Interface (semantic_search, add_content, list_projects, list_modules) | Must |
| FR-009 | Embedding Configuration per project (model, precision, Vector DB) | Must |
| FR-010 | Installation (npm package, cross-platform CLI) | Must |
| FR-011 | Model Memory Management (pin, LRU, memory tracking) | Must |
| FR-012 | Standalone Installation (no iSDLC required) | Must |
| FR-013 | iSDLC Install Integration (URL → .mcp.json, skip local embeddings) | Must |
| FR-014 | Audit Logging (append-only JSONL, web UI tab) | Must |
| FR-015 | Operational Monitoring (Prometheus, OTLP, staleness, health) | Must |
| FR-016 | iSDLC Status Line Integration (poll /metrics) | Should |

## Out of Scope (v1)
- Solo dev local mode (stays in iSDLC)
- Access control between teams/projects
- Multi-server fan-out / MCP aggregation
- Jira connector
- Fixed project groups
- Cross-project relationship correlation

## Provenance
- **Source**: docs/requirements/prd.md, docs/requirements/REQ-GH-263-.../requirements-spec.md, interface-spec.md
- **Distilled**: 2026-04-25
- **Discovery run**: full
