# Project Constitution — isdlc-knowledge-service

<!-- CONSTITUTION_STATUS: ACTIVE -->

**Created**: 2026-04-25
**Status**: Active (under interactive review)
**Source inputs**: REQ-GH-263 requirements-spec.md (CON-001..004, NFRs), architecture-overview.md (ADR-001..004), error-taxonomy.md, module-design.md (adapter contracts), interface-spec.md (audit + security shapes)

---

## Preamble

This constitution establishes the fundamental principles governing development of **isdlc-knowledge-service** — a centralised knowledge management service shipping in its own repo, integrating with iSDLC over MCP only.

All agents (00-13) and contributors MUST read and enforce these principles throughout the project lifecycle. When two articles conflict, the article with the lower roman numeral wins.

---

## Articles

### Article I — Specification Primacy

**Principle**: REQ-GH-263 is the source of truth for every requirement, AC, and ADR. Code serves the specification, not the other way around.

**Requirements**:
1. The authoritative requirements live at `docs/requirements/REQ-GH-263-.../requirements-spec.md` and `architecture-overview.md`. The PRD at `docs/requirements/prd.md` is a derived view; on conflict, the REQ-GH-263 source wins.
2. New behaviour MUST trace to a documented FR/AC. Drift requires a spec update first.
3. Architecture decisions MUST be recorded as ADRs before implementation begins; ADR-001..004 are baseline.

---

### Article II — Repository Independence (CON-001, CON-002)

**Principle**: This service is a separate repo with no build-time dependency on iSDLC. Integration is over MCP only.

**Requirements**:
1. NO `import` of iSDLC modules. NO shared code packages. The MCP protocol is the integration surface.
2. Versioning, releases, and CI/CD are independent of the iSDLC repo.
3. The only iSDLC-side touch points are: install script accepting a knowledge service URL (FR-013), finalize step calling `add_content` over MCP (FR-004), and status-line polling `/metrics` (FR-016). All of those live in the iSDLC repo, not here.

---

### Article III — Two-Process Integrity (ADR-001)

**Principle**: The API process MUST NEVER block on embedding work. The Worker process bears all CPU/memory load.

**Requirements**:
1. The MCP/REST/web-UI API process serves requests in <100ms p50 under steady load. No synchronous embedding, crawling, or correlation in the API path.
2. The Worker process owns all model inference, crawling, and Vector DB writes. API↔Worker handoff is the SQLite job queue (Module 10).
3. Worker crashes MUST NOT degrade the API. The API continues serving cached/queued operations; the supervisor restarts the Worker.
4. Health check (FR-010 AC-010-06) verifies BOTH processes plus model loaded plus Vector DB accessible.

---

### Article IV — Per-Project Isolation (NFR Isolation)

**Principle**: A corrupt index, runaway crawl, or misconfigured source in one project MUST NOT affect any other project.

**Requirements**:
1. Each project has its own `data/projects/{id}/` directory: config, refresh history, and (for sqlite-vec) its own `index.db`. Remote Vector DBs use a separate collection/class per project.
2. Project deletion removes that project's directory and its remote collection — atomically. Other projects are untouched.
3. A failure in one project's job does NOT block jobs for other projects in the queue.
4. Search fan-out tolerates a single-project failure: results from healthy projects MUST still be returned (with a per-project error annotation).

---

### Article V — Pluggability Invariants (ADR-002, ADR-004)

**Principle**: Vector DB and model inference are pluggable. Every adapter implements the same interface so the rest of the system stays adapter-agnostic.

**Requirements**:
1. Vector DB adapters share a common interface: `store`, `search`, `delete`, `deleteAll`, `stats`. Every implementation passes the same contract-conformance test suite.
2. Model adapters share a common interface: `embed(text)`, `batchEmbed(texts)`, `getInfo()`. Every implementation passes the same contract-conformance test suite.
3. There is **no default Vector DB**. The team lead chooses during setup.
4. Per-project model and Vector DB selection MUST work without code changes — only config. Changing the model or precision triggers a full rebuild (FR-009 AC-009-05).
5. Cloud-API model adapters and remote Vector DB adapters never persist credentials in `config.json` — only secret references (env var name or secret-store id).

---

### Article VI — Reliability and Idempotency (NFR Reliability)

**Principle**: Incremental refresh is idempotent. Re-running with the same input produces the same final state.

**Requirements**:
1. `incremental_refresh` jobs deduplicate by `(project_id, repo_id, changes_hash)` within a debounce window — duplicate triggers collapse to one execution.
2. Embedding chunk IDs are deterministic from `(project_id, source_url, content_hash)` so re-embedding upserts rather than duplicates.
3. Vector DB writes are transactional or rollback-on-failure (INT-007). Partial writes are not committed.
4. Failed jobs retry with backoff up to `max_attempts` (default 3) before dead-lettering (ERR-QUEUE-001).
5. The `add_content` MCP integration from iSDLC finalize is fail-open: finalize MUST continue if the knowledge service is unreachable (INT-002).

---

### Article VII — Audit and Security

**Principle**: Every admin action and every CI/CD trigger is recorded in an append-only audit log. Credentials never leak.

**Requirements**:
1. Every admin action via web UI is logged with `{ timestamp, action, project_id?, details, ip_address }` (FR-014 AC-014-01).
2. Every CI/CD refresh trigger is logged with repo ID and change count (AC-014-02).
3. The audit log is append-only at the storage layer. The web UI exposes view + filter only — no modify or delete path exists (AC-014-04).
4. Audit log files rotate when they exceed a configurable size limit (AC-014-05).
5. Cloud-API credentials and remote Vector DB credentials are stored as secret references (env var name or secret-store id), never as inline strings in `config.json`. The schema validator REJECTS bare credential values.
6. Per-source credentials (e.g. Confluence API tokens, SVN passwords) follow the same rule.
7. Inputs to MCP tools and REST endpoints are validated before reaching connectors or the queue. Rejections return structured error codes from the error taxonomy.

---

### Article VIII — Cross-Source Reliability (CON-003)

**Principle**: Both Git and SVN are first-class. The connector interface treats them symmetrically.

**Requirements**:
1. Source connectors implement a uniform interface: `crawl(config)` and `diff(config, since)` returning `NormalisedChunk[]`.
2. Git and SVN connectors MUST both support full crawl and incremental diff. Neither is a degraded path.
3. Cloud-source connectors (Confluence, GDocs) and unstructured-source connectors (Web, Filesystem) implement the same interface.
4. Connector failures (ERR-CONN-001 unreachable, ERR-CONN-002 auth) are logged in refresh history with explicit codes — they do not crash the Worker.

---

### Article IX — Memory Discipline (NFR Memory Efficiency, FR-011)

**Principle**: Local model memory is managed explicitly. The team lead controls trade-offs through pinning.

**Requirements**:
1. Unpinned local models are lazy-loaded and evicted by LRU. Pinned local models stay resident.
2. The Model Manager publishes loaded model count, footprint, and pin status to the web UI and `/metrics`.
3. The web UI warns when total pinned model size exceeds 80% of available RAM (Risk mitigation row).
4. Cloud-API model "adapters" do NOT consume server memory — the UI distinguishes local from cloud projects in the model management view (FR-011 AC-011-05).

---

### Article X — Cross-Platform and Standalone (NFR Cross-platform, FR-010, FR-012)

**Principle**: Works on Windows, Linux, and macOS without platform-specific scripts. Works without iSDLC.

**Requirements**:
1. The CLI is pure Node.js. No shell scripts, no platform conditionals beyond standard `path` and `os` module usage.
2. The setup wizard, install, and runtime work identically across the three operating systems.
3. The web UI and MCP interface are fully functional in standalone mode (no iSDLC required) — FR-012 AC-012-03.
4. Standalone setup completion displays CI/CD wiring guidance (AC-012-02).

---

### Article XI — Web UI Simplicity (CON-004)

**Principle**: The web UI is plain HTML + vanilla JS served by the same process. No build step, no frontend framework.

**Requirements**:
1. UI assets (HTML, CSS, JS) are static files served by the API process.
2. NO npm dependency on React, Vue, Svelte, Next, Vite, webpack, etc. Vanilla DOM APIs only.
3. UI logic talks to the same REST endpoints documented in `interface-spec.md`. There is no second back-channel.
4. Browser support: latest two versions of Chrome, Firefox, Safari, Edge. No transpilation, no polyfills.

---

### Article XII — Observability First (FR-015)

**Principle**: The service is operable without console access. Metrics, traces, and structured logs are first-class outputs.

**Requirements**:
1. `/metrics` exposes Prometheus text format covering: queue depth, success/failure totals, per-project document count, staleness age, model memory, embedding throughput, API latency.
2. Both processes emit structured JSON logs to stdout (AC-015-02). No ad-hoc `console.log` of unstructured strings in production code paths.
3. OpenTelemetry OTLP export is configurable; when enabled, traces and metrics flow to the configured collector (AC-015-03).
4. Staleness is computed by comparing last indexed revision vs current source state. Each project surfaces a green/amber/red badge.
5. Health endpoints (`/api/system/health`, `/api/projects/:id/status`) return structured JSON (AC-015-07, AC-015-08).

---

### Article XIII — Test Discipline

**Principle**: Tests are written alongside the code that needs them, run with the platform's built-in runner, and exercise the full error taxonomy.

**Requirements**:
1. The test runner is `node --test` — already wired in `package.json`. No third-party test framework.
2. Every adapter (Vector DB, model, source connector) MUST pass the same contract-conformance test suite.
3. Every error code in `error-taxonomy.md` MUST have at least one test that triggers and asserts the recovery path.
4. Test pyramid targets: unit ~60%, integration ~30%, E2E ~10% by test count.
5. Coverage threshold targets: ≥80% line, ≥70% branch on `src/` (target, not v1 hard gate).

---

### Article XIV — Quality Gate Integrity

**Principle**: Quality gates cannot be skipped. Failures require remediation, not waivers.

**Requirements**:
1. All defined gates (lint, unit, integration, E2E) MUST pass before merge.
2. A gate that fails twice in a row escalates to a human reviewer.
3. Cross-platform smoke (Windows + Linux + macOS) is a gate before any release tag.

---

## Customization Hooks

The following knobs are intentionally **not** fixed by this constitution and are decided per-deployment by the team lead:
- Vector DB backend (per project; ADR-002).
- Embedding model and precision (per project; FR-009).
- Refresh-history file rotation threshold.
- Audit log file rotation threshold.
- OTLP collector endpoint and sampling rate.
- Web UI bind port, MCP bind port, metrics bind port.

---

**Constitution Version**: 1.0.0
**Framework Version**: 2.0.0
**Last Reviewed**: 2026-04-25
