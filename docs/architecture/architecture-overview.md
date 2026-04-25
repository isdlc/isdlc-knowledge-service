# Architecture Overview: isdlc-knowledge-service

**Status**: Adopted (lifted from REQ-GH-263 architecture-overview.md, merged with module-design.md)
**Source**: `docs/requirements/REQ-GH-263-centralised-vector-db-carve-out-embedding-server/architecture-overview.md` + `module-design.md`
**Last Updated**: 2026-04-25

---

## 1. Architecture Options Considered

| Option | Summary | Pros | Cons | Verdict |
|---|---|---|---|---|
| A: Monolithic single-process | MCP, web UI, pipeline, crawlers all in one Node.js process | Simple deployment, no IPC | Embedding blocks event loop, OOM risk on query path | Eliminated |
| B: Two-process split (API + Worker) | API process (MCP + web UI) separate from Worker (embedding + crawling) | API stays responsive, memory isolation, independent restart | Slightly more complex (two processes, job queue) | **Selected** |

---

## 2. Architecture Decision Records

### ADR-001 — API/Worker Process Split
- **Status**: Accepted
- **Context**: Embedding and crawling are CPU/memory intensive. Running them in the same process as the MCP query server would block responses and risk OOM.
- **Decision**: Split into an API process (MCP + web UI + REST + metrics) and a Worker process (embedding pipeline + source crawlers). A SQLite-backed job queue coordinates the two.
- **Rationale**: Memory isolation protects the query path. Worker can crash and restart without affecting developer queries.
- **Consequences**: Install script starts two processes. Health check verifies both. Job queue adds coordination overhead.

### ADR-002 — Vector DB is Pluggable, No Default
- **Status**: Accepted
- **Context**: Different teams have different infrastructure. Forcing a default adds unnecessary migration friction.
- **Decision**: No default Vector DB. Setup wizard presents options — local (SQLite-vec, Qdrant, ChromaDB, Milvus, Weaviate, FAISS) or remote (Amazon OpenSearch, Pinecone, Qdrant Cloud, Weaviate Cloud, Milvus Cloud / Zilliz). Team lead chooses during setup; per-project override possible.
- **Rationale**: Maximises adoption across teams with different infrastructure.
- **Consequences**: Must abstract a vector DB interface. Per-project selection requires multiple adapter implementations.

### ADR-003 — JSON File Config Store
- **Status**: Accepted
- **Context**: Need to store project definitions, source lists, model config, refresh history.
- **Decision**: JSON files at `data/projects/{project-id}/config.json` and `data/projects/{project-id}/refresh-history.json`.
- **Rationale**: Human-readable, easy to backup, no database dependency for config.
- **Consequences**: No concurrent-write protection (acceptable — single admin). Refresh history may need rotation.

### ADR-004 — Dual Model Inference Path
- **Status**: Accepted
- **Context**: Some teams have server hardware for local inference. Others prefer cloud APIs.
- **Decision**: Support both local (ONNX Runtime, FP4/FP16/FP32) and cloud embedding APIs (OpenAI, Cohere, Bedrock) behind a common adapter interface. Per-project selection.
- **Rationale**: Maximises adoption. Cloud API teams avoid model management; local teams get lower latency.
- **Consequences**: Must abstract embedding interface. Cloud API costs are the team's responsibility. Model pinning (FR-011) applies to local models only.

---

## 3. Technology Decisions

| Technology | Version | Rationale | Alternatives Considered |
|---|---|---|---|
| Node.js (ESM) | >= 18 | Consistent with iSDLC ecosystem. ONNX Runtime bindings available. Native fetch. | Python (better ML ecosystem, splits stack) |
| ONNX Runtime | Latest | Already used in iSDLC GH-237. Supports FP4/FP16/FP32. | Transformers.js (less precision control) |
| Vector DB | Pluggable | Per-project. Local: SQLite-vec, Qdrant, ChromaDB, Milvus, Weaviate, FAISS. Remote: OpenSearch, Pinecone, Qdrant Cloud, Weaviate Cloud, Milvus Cloud. | Single DB (limits adoption) |
| Job Queue | BetterSqlite3 | No external deps. Durable. Proven. | Redis/Bull (overkill), pg-boss (Postgres dep) |
| Web UI | Plain HTML + vanilla JS | CON-004. No build step. | React/Vue (unnecessary complexity) |
| Config Store | JSON files | Simple, human-readable, git-friendly. | SQLite (harder to inspect) |
| Source crawling | Node.js native | `simple-git`, `svn` CLI wrapper, Confluence REST, `cheerio` for web | Scrapy (Python, wrong ecosystem) |
| Observability | Prometheus + OpenTelemetry | Industry standard. Grafana / Zabbix compatible. | Custom metrics (reinventing the wheel) |

---

## 4. Module Map

The system decomposes into 14 modules. Each has a single responsibility and a public interface defined in `docs/requirements/REQ-GH-263-.../module-design.md`. Summary:

| # | Module | Path | Responsibility | Key Public Interface |
|---|---|---|---|---|
| 1 | API Server | `src/api/` | Serves MCP + REST + web UI; stateless query routing | `startServer(config) → void` |
| 2 | Query Engine | `src/query/` | Fan-out across project Vector DB indexes; merge, rank, tag | `search({ query, projects }) → SearchResult[]` |
| 3 | Worker | `src/worker/` | Process jobs: full rebuild, incremental refresh, add_content | `startWorker(config) → void` |
| 4 | Source Connectors | `src/connectors/` | Pluggable crawlers producing normalised chunks | `crawl(config)` / `diff(config, since)` |
| 5 | Correlation Engine | `src/correlation/` | Link chunks from multiple sources within a project | `correlate(chunks, project_config) → CorrelatedChunk[]` |
| 6 | Embedding Pipeline | `src/pipeline/` | Enrich correlated chunks with relationship context, generate vectors | `embed(chunks, model_adapter) → EmbeddedChunk[]` |
| 7 | Model Adapters | `src/models/` | Unified embedding interface — local or cloud | `embed(text)`, `batchEmbed(texts)`, `getInfo()` |
| 8 | Model Manager | `src/models/manager.js` | Lifecycle: load, pin, LRU evict, memory tracking (local only) | `getAdapter(config)`, `pin(name)`, `unpin(name)`, `getStatus()` |
| 9 | Vector DB Adapters | `src/vectordb/` | Unified vector storage interface — local or remote | `store`, `search`, `delete`, `deleteAll`, `stats` |
| 10 | Job Queue | `src/queue/` | Durable async queue (SQLite, BetterSqlite3) | `enqueue`, `dequeue`, `complete`, `fail`, `getStatus`, `listJobs` |
| 11 | Config Store | `src/config/` | Project config CRUD + refresh history (JSON files) | `listProjects`, `getProject`, `createProject`, `updateProject`, `deleteProject`, `addRefreshRecord`, `getRefreshHistory` |
| 12 | CLI | `src/cli/` | npm bin entry point: setup wizard, start, stop, status, logs, reset | `setup`, `start`, `stop`, `status`, `logs`, `reset` |
| 13 | Audit Logger | `src/audit/` | Append-only admin action log (JSONL with size rotation) | `log(action, details)`, `query(filters)` |
| 14 | Observability | `src/observability/` | Prometheus metrics, OTLP traces, staleness detection | `metrics.js`, `tracing.js`, `staleness.js` |

### Connector implementations (Module 4)
GitConnector, SvnConnector, ConfluenceConnector, WebConnector, GDocsConnector, FilesystemConnector. Common output: `NormalisedChunk { content, path, source_type, source_url, last_modified, metadata }`.

### Model adapter implementations (Module 7)
OnnxLocalAdapter (FP4/FP16/FP32), OpenAiAdapter, CohereAdapter, BedrockAdapter.

### Vector DB adapter implementations (Module 9)
SqliteVecAdapter, QdrantAdapter, ChromaDbAdapter, MilvusAdapter, WeaviateAdapter, FaissAdapter, OpenSearchAdapter, PineconeAdapter, QdrantCloudAdapter, WeaviateCloudAdapter, MilvusCloudAdapter.

### Correlation strategies (Module 5)
Path / name matching, iSDLC artifact trace matching, Confluence-title ↔ module matching, import-graph analysis. Output: `CorrelatedChunk { ...NormalisedChunk, related: RelatedSource[] }` where `RelatedSource = { path, source_type, relationship: "spec"|"test"|"doc"|"impl", confidence }`.

---

## 5. Integration Architecture

| ID | Source | Target | Interface | Data Format | Error Handling |
|---|---|---|---|---|---|
| INT-001 | iSDLC (developer) | API Process | MCP over HTTP | JSON-RPC 2.0 | Standard MCP errors |
| INT-002 | iSDLC (finalize) | API Process | MCP `add_content` | JSON-RPC 2.0 | Fail-open — finalize continues if unreachable |
| INT-003 | CI/CD (GitHub Actions / Jenkins) | API Process | `POST /api/refresh` | JSON | HTTP 200/400/500, idempotent |
| INT-004 | Team lead | API Process | HTTP (web UI) | HTML + REST | Standard HTTP errors |
| INT-005 | API Process | Worker Process | Job queue (SQLite) | JSON job records | Dead letter, max 3 retries |
| INT-006 | Worker Process | External sources | Source connectors | Per-source protocol | Per-connector, logged in refresh history |
| INT-007 | Worker Process | Vector DB | DB-specific adapter | Vectors + metadata | Transaction-safe, rollback on failure |

---

## 6. Data Flows

### 6.1 Full Rebuild
```
Web UI trigger
  → API enqueues full_rebuild job
    → Worker dequeues
      → Connectors crawl all sources
      → Correlation Engine matches code ↔ docs ↔ tests
      → Embedding Pipeline generates vectors (via Model Adapter)
      → Vector DB Adapter clears index, stores new vectors
      → Config Store records refresh history entry
```

### 6.2 Incremental Refresh
```
CI/CD POST /api/refresh
  → API enqueues incremental_refresh job
    → Worker dequeues
      → Connector fetches diff (since last revision / commit)
      → Correlation Engine re-correlates changed files
      → Embedding Pipeline regenerates vectors for changed chunks
      → Vector DB Adapter upserts changed vectors
      → Config Store records refresh history entry
```

### 6.3 Developer Query
```
iSDLC MCP call (semantic_search)
  → API receives request
    → Query Engine embeds query text via Model Adapter
    → Fan out: search each project index in parallel via Vector DB Adapters
    → Merge results, rank by score, tag with source project
  → Return to developer
```

---

## 7. Dependency Diagram

```
API Server ──→ Query Engine ──→ Vector DB Adapters
    │                              ↑
    │              Model Adapters ──┘
    │
    ├──→ Config Store
    ├──→ Job Queue ←── Worker
    ├──→ Audit Logger      │
    └──→ Observability     ├──→ Source Connectors
                           ├──→ Correlation Engine
                           ├──→ Embedding Pipeline ──→ Model Adapters
                           ├──→ Vector DB Adapters
                           └──→ Model Manager ──→ Model Adapters
```

No circular dependencies. All modules have a single responsibility.

---

## 8. Risk Summary

| Decision | Choice | Risk Level |
|---|---|---|
| Process architecture | Two-process (API + Worker) | Low |
| Vector DB | Pluggable, no default | Low |
| Model inference | Dual path (local ONNX + cloud API) | Low |
| Config store | JSON files | Low |
| Job queue | SQLite-backed | Low |
| Web UI | Plain HTML, same process | Low |
| Observability | Prometheus + OTLP, domain-specific in web UI | Low |

**Verdict**: Go — architecture is straightforward, all components are well-understood patterns, no high-risk decisions.

---

## 9. References

- Requirements: `docs/requirements/prd.md` and `docs/requirements/REQ-GH-263-.../requirements-spec.md`
- Module design: `docs/requirements/REQ-GH-263-.../module-design.md`
- Interface spec: `docs/requirements/REQ-GH-263-.../interface-spec.md`
- Error taxonomy: `docs/requirements/REQ-GH-263-.../error-taxonomy.md`
- Data model: `docs/architecture/data-model.md`
- Test strategy: `docs/architecture/test-strategy-outline.md`
