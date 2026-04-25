# Product Requirements Document: isdlc-knowledge-service

**Status**: Draft (derived from REQ-GH-263)
**Source of Truth**: `docs/requirements/REQ-GH-263-centralised-vector-db-carve-out-embedding-server/requirements-spec.md`
**Last Updated**: 2026-04-25

> This PRD is a re-shaping of the authoritative requirements specification produced under REQ-GH-263 ("Centralised Vector DB carve-out / embedding server"). All FRs, ACs, NFRs, constraints, and out-of-scope items below are lifted verbatim from that source — **no new requirements have been introduced here**. When the two diverge, the requirements-spec is authoritative.

---

## 1. Problem Statement

The current iSDLC embedding pipeline runs locally per-developer. The result is duplicated indexes across the team, no shared semantic search, no documentation sources beyond the local repo, and OOM failures on constrained hardware. This does not scale to teams or organisations.

The product is a standalone knowledge management service — centrally hosted, team-lead administered, developer-queryable via MCP. It ships in its own repo (`isdlc-knowledge-service`) with independent versioning and releases, deliberately decoupled from iSDLC at build time.

---

## 2. Goals & Success Metrics

### Primary value proposition
A developer asks "how does the payment flow work?" and receives correlated results spanning code, Confluence specs, design docs, and iSDLC analysis artifacts — across modules and versions — within a single search.

### Success metric
Cross-cutting semantic search returns correlated results from code + documentation + analysis artifacts within a version-scoped project.

### Quality bars (from NFR table)
- Reliability: incremental refresh is idempotent.
- Performance: incremental refresh completes within minutes.
- Isolation: per-project indexes are fully isolated.
- Memory efficiency: lazy model loading with LRU eviction; pinning available for high-traffic models.
- Cross-platform: works on Windows, Linux, macOS without platform-specific scripts.

---

## 3. Personas

### 3.1 Team Lead (Admin)
- Role: infrastructure owner for the knowledge service.
- Goals: curate a comprehensive, up-to-date corpus for the team.
- Pain points: no shared search today; each developer has isolated local embeddings.
- Tasks: project CRUD, source management, model + precision + VectorDB selection, model pinning, rebuild triggers, staleness monitoring, audit log review.

### 3.2 Developer (Consumer)
- Role: day-to-day iSDLC user.
- Goals: find relevant code, docs, and specs quickly across modules and versions.
- Pain points: fragmented search across code, Confluence, Jira.
- Tasks: configure project scope in `.isdlc/config.json`, run semantic searches, consume tagged cross-project results.

### 3.3 Standalone User
- Role: uses the knowledge service without iSDLC.
- Goals: same as team lead + developer combined.
- Pain points: no automatic refresh integration — must wire CI/CD manually.
- Tasks: all admin tasks plus manual refresh trigger setup.

---

## 4. User Journeys

### 4.1 Team Lead Setup
`npm install -g isdlc-knowledge-service` → `isdlc-knowledge setup` → choose embedding source (local ONNX or cloud API) and Vector DB → open web UI → create project ("Payments 2.7") → add sources (repo + branch, Confluence, websites) → choose per-project model + precision + VectorDB → pin high-traffic models → trigger full embed → share MCP endpoint URL.

### 4.2 Developer Daily Use
Add projects to `.isdlc/config.json` (`["payments-2.7", "inventory-2.7", "order-management-3.0"]`) → iSDLC semantic search is automatically scoped to those projects → results are tagged by source project → on PR merge, CI/CD calls refresh endpoint and the index stays current.

### 4.3 Automatic Refresh
Developer merges PR → GitHub Actions / Jenkins post-build calls `POST /api/refresh` with repo ID + changed paths → service re-embeds only changed files plus their correlated sources → index updated within minutes.

### 4.4 Manual Refresh
Team lead adds a new Confluence space in the web UI → triggers full rebuild for that project → system re-crawls all sources, re-generates embeddings → progress visible in web UI.

---

## 5. MVP Scope (Must Have only — from MoSCoW §8)

| FR | Title | Inclusion |
|---|---|---|
| FR-001 | Project Management | MVP |
| FR-002 | Relationship-Aware Embedding Pipeline | MVP |
| FR-003 (primary) | Source Connectors — Git, SVN, Confluence | MVP |
| FR-003 (secondary) | Source Connectors — Website, Google Docs, Filesystem | Should Have (deferred from MVP) |
| FR-004 | Incremental Refresh via CI/CD | MVP |
| FR-005 | Full Rebuild | MVP |
| FR-006 | Developer Query Scope | MVP |
| FR-007 | Web UI (Admin Dashboard) | MVP |
| FR-008 | MCP Interface | MVP |
| FR-009 | Embedding Configuration (per-project) | MVP |
| FR-010 | Installation (npm package) | MVP |
| FR-011 | Model Memory Management | MVP |
| FR-012 | Standalone Installation | MVP |
| FR-013 | iSDLC Install Integration | MVP |
| FR-014 | Audit Logging | MVP |
| FR-015 | Operational Monitoring | MVP |
| FR-016 | iSDLC Status Line Integration | Should Have (deferred from MVP) |

---

## 6. Functional Requirements

The full set of 16 FRs and 60+ acceptance criteria lives in `requirements-spec.md` §6. Summarised here:

### FR-001 Project Management — Must Have, Confidence High
Project CRUD via web UI; source attach/detach (Git, SVN, Confluence, website, GDocs, filesystem); root-URL crawl follows sub-pages and links; per-project isolated index; project = module + version (e.g. "Payments 2.7").
ACs: AC-001-01 .. AC-001-05.

### FR-002 Relationship-Aware Embedding Pipeline — Must Have, Confidence High
Pipeline correlates code with docs, discover output, tests, analysis artifacts before embedding; each chunk carries pointers to spec/test-coverage/architectural role; discover runs as prerequisite; embedded vectors capture cross-source relationships.
ACs: AC-002-01 .. AC-002-04.

### FR-003 Source Connectors — Must Have (Git, SVN, Confluence) / Should Have (Website, GDocs, Filesystem)
Git (clone/pull, diff-based incremental); SVN (checkout/update, revision-based); Confluence (REST, sub-page crawl); website (scrape + link follow); GDocs (Drive API, folder crawl); shared folder (filesystem walk). All connectors emit normalised chunks `{ content, path, source_type, source_url, last_modified, metadata }`.
ACs: AC-003-01 .. AC-003-07.

### FR-004 Incremental Refresh via CI/CD — Must Have, Confidence High
`POST /api/refresh` accepts GitHub Actions / Jenkins triggers with repo ID + changed paths; re-embeds changed files plus correlated sources; iSDLC finalize step pushes artifacts via `add_content`.
ACs: AC-004-01 .. AC-004-05.

### FR-005 Full Rebuild — Must Have, Confidence High
Web UI triggers a full rebuild; job is queued; full re-crawl + re-embed; progress visible in the web UI.
ACs: AC-005-01 .. AC-005-03.

### FR-006 Developer Query Scope — Must Have, Confidence High
`.isdlc/config.json` `knowledge.projects` defines search scope; results scoped to those projects; each result tagged by source project; multi-project search merges results.
ACs: AC-006-01 .. AC-006-04.

### FR-007 Web UI (Admin Dashboard) — Must Have, Confidence High
HTML dashboard served by the same process; project CRUD; source CRUD; rebuild trigger; refresh-history per project (timestamp, type, trigger source, duration, doc count, status); per-project status; "content in last full build" view.
ACs: AC-007-01 .. AC-007-07.

### FR-008 MCP Interface — Must Have, Confidence High
`semantic_search({ query, projects })`, `add_content({ content, project })`, `list_projects()`, `list_modules({ project })`.
ACs: AC-008-01 .. AC-008-04.

### FR-009 Embedding Configuration (per-project) — Must Have, Confidence High
Per-project: embedding source (local ONNX or cloud API), precision (FP4/FP16/FP32) for local, provider + API key for cloud, Vector DB backend (11 options: 6 local, 5 remote). Model/precision change triggers a full rebuild for that project only. Install script pre-downloads available local models.
ACs: AC-009-01 .. AC-009-06.

### FR-010 Installation (npm package) — Must Have, Confidence High
Published as npm package `isdlc-knowledge-service`, installable via `npm install -g`. `isdlc-knowledge setup` runs an interactive cross-platform wizard; downloads local models over HTTP; installs/validates Vector DB; `isdlc-knowledge start` launches API + Worker; health check confirms model loaded, Vector DB accessible, MCP responding. Cross-platform with no platform-specific scripts.
ACs: AC-010-01 .. AC-010-07.

### FR-011 Model Memory Management — Must Have, Confidence High
Pin keeps a local model loaded; unpinned models are lazy-loaded with LRU eviction; web UI shows loaded models, footprint, pin status, total server memory; clearly distinguishes local vs cloud-API projects.
ACs: AC-011-01 .. AC-011-05.

### FR-012 Standalone Installation — Must Have, Confidence High
Usable without iSDLC; standalone setup displays CI/CD wiring guidance; web UI + MCP fully functional alone.
ACs: AC-012-01 .. AC-012-03.

### FR-013 iSDLC Install Integration — Must Have, Confidence High
iSDLC install accepts a knowledge service URL; if provided, configures `.mcp.json` and skips local embedding install; if not provided, falls back to local embedding (solo dev); finalize step sends artifacts to the configured endpoint.
ACs: AC-013-01 .. AC-013-04.

### FR-014 Audit Logging — Must Have, Confidence High
Web UI admin actions logged; CI/CD refresh triggers logged with repo ID + change count; web UI tab supports search/filter; storage is append-only and not modifiable via UI; rotates on size threshold.
ACs: AC-014-01 .. AC-014-05.

### FR-015 Operational Monitoring — Must Have, Confidence High
Prometheus `/metrics` endpoint (queue depth, success/failure, doc counts, staleness age, model memory, throughput, latency); structured JSON stdout logs; OpenTelemetry OTLP export; `isdlc-knowledge logs` streams local logs; staleness detection by revision comparison with green/amber/red badges; web UI per-project status cards; `GET /api/system/health`; `GET /api/projects/:id/status`.
ACs: AC-015-01 .. AC-015-08.

### FR-016 iSDLC Status Line Integration — Should Have, Confidence Medium
Status line shows connection status, active project count, staleness summary; data fetched from `/metrics` (lightweight, cached, polled).
ACs: AC-016-01 .. AC-016-02.

---

## 7. Non-Functional Requirements

| Attribute | Priority | Threshold |
|---|---|---|
| Reliability | Critical | Incremental refresh is idempotent — re-running with same input produces same result |
| Performance | High | Incremental refresh completes within minutes, not hours |
| Isolation | Critical | Project indexes are fully isolated — corruption in one project does not affect others |
| Memory efficiency | High | Lazy model loading with LRU eviction by default; pinning for high-traffic models |
| Cross-platform | High | Works on Windows, Linux, macOS without platform-specific scripts |

---

## 8. Constraints

| ID | Constraint |
|---|---|
| CON-001 | Separate repo — independent versioning, releases, CI/CD. **No build-time dependency on iSDLC.** |
| CON-002 | iSDLC integration via MCP protocol only — no shared code, no imports. |
| CON-003 | Must support both Git and SVN repositories. |
| CON-004 | Web UI is plain HTML served by the same process — no separate frontend framework. |

---

## 9. Out of Scope

| Item | Reason | Dependency |
|---|---|---|
| Solo developer local mode as part of this service | Current local pipeline stays in iSDLC | None |
| Access control between teams/projects | Add later when org-scale adoption requires it | FR-001 |
| Multi-server fan-out / MCP aggregation layer | Single server per org sufficient for v1 | None |
| Jira connector | iSDLC analysis artifacts in repo are sufficient | FR-003 |
| Fixed project groups | Developers pick projects ad-hoc | FR-006 |
| Cross-project relationship correlation | Correlation is within a project only for v1 | FR-002 |

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Correlation engine accuracy — matching code to wrong docs | Medium | High | Start with filename/path matching heuristics, improve with semantic similarity. Allow manual overrides. |
| Memory pressure from multiple pinned models | Medium | Medium | Web UI shows memory usage. Warn when total pinned size > 80% available RAM. |
| SVN connector complexity | Medium | Low | Start with `svn` CLI wrapper. Upgrade to library if needed. |
| Vector DB migration when switching backends | Low | Medium | Abstract interface. Migration tool reads from old, writes to new. |
| Web scraper reliability | Medium | Low | Best-effort with depth limits. Log unreachable pages. |

---

## 11. Cross-References

- Authoritative requirements: `docs/requirements/REQ-GH-263-centralised-vector-db-carve-out-embedding-server/requirements-spec.md`
- Architecture: `docs/architecture/architecture-overview.md`, `docs/architecture/data-model.md`, `docs/architecture/test-strategy-outline.md`
- Module design: `docs/requirements/REQ-GH-263-.../module-design.md`
- Interface spec: `docs/requirements/REQ-GH-263-.../interface-spec.md`
- Error taxonomy: `docs/requirements/REQ-GH-263-.../error-taxonomy.md`
- Task plan: `docs/requirements/REQ-GH-263-.../tasks.md` (37 tasks, 4 phases)
- Constitution: `docs/isdlc/constitution.md`
