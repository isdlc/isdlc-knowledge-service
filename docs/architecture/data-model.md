# Data Model: isdlc-knowledge-service

**Status**: Adopted
**Source**: Lifted from `docs/requirements/REQ-GH-263-.../interface-spec.md` §Data Structures + ADR-003 (JSON file layout) + implied SQLite schemas (job queue, SQLite-vec adapter)
**Last Updated**: 2026-04-25

---

## 1. Storage Layout

The service uses **three storage tiers**, each chosen for fitness rather than uniformity:

| Tier | Backing | What it stores | Why |
|---|---|---|---|
| Config (per-project) | JSON files on disk | `ProjectConfig`, `RefreshRecord` history | Human-readable, git-friendly, low write contention (single admin) — see ADR-003 |
| Audit log | JSONL on disk | `AuditEntry` records, append-only, size-rotated | Append-only invariant, no random updates needed — FR-014 |
| Operational state | SQLite (BetterSqlite3) | Job queue, optionally local vector index | Durable, transactional, no external dep — ADR-001 / Module 10 |
| Vector index (per-project) | Per-project, depends on selected backend | Embedding vectors + metadata | Pluggable per ADR-002 |

### 1.1 Filesystem layout
```
data/
├── audit.jsonl                            # Module 13 — append-only, rotated
├── audit/                                 # rotated archives (audit-001.jsonl …)
├── queue.sqlite                           # Module 10 — job queue
├── models/                                # Pre-downloaded local ONNX models (FR-009 AC-009-06)
│   └── jina-v2-base-code/
│       ├── model.onnx
│       └── tokenizer.json
└── projects/
    └── {project-id}/                      # e.g. payments-2.7
        ├── config.json                    # ProjectConfig (single record)
        ├── refresh-history.json           # RefreshRecord[] (rotated by size if needed)
        └── index.db                       # If vectordb_config.backend is "sqlite-vec"; otherwise vectors live in the configured remote backend and only the per-project metadata sits here
```

---

## 2. Core Data Structures (JSON)

### 2.1 ProjectConfig
File: `data/projects/{id}/config.json`

```json
{
  "id": "payments-2.7",
  "name": "Payments",
  "version": "2.7",
  "description": "Payment processing module",
  "sources": [
    { "type": "git",        "url": "git.company.com/payments", "branch": "release/2.7" },
    { "type": "svn",        "url": "svn.company.com/payments/branches/2.7", "revision": "HEAD" },
    { "type": "confluence", "url": "confluence.company.com/display/PAY27/" },
    { "type": "website",    "url": "docs.payments.com/v2.7/" },
    { "type": "gdocs",      "url": "drive.google.com/drive/folders/abc123" },
    { "type": "filesystem", "url": "/mnt/shared/payments-2.7-docs" }
  ],
  "metadata_vocabulary": {
    "custom_link_fields": ["linked_compliance_check"]
  },
  "model_config": {
    "source": "local",                       // "local" | "cloud"
    "model_name": "jina-v2-base-code",       // local: ONNX model id; cloud: provider model id
    "precision": "fp16",                     // local only: "fp4" | "fp16" | "fp32"
    "provider": null,                        // cloud only: "openai" | "cohere" | "bedrock"
    "api_key_ref": null                      // cloud only: secret reference, never inline value
  },
  "vectordb_config": {
    "backend": "sqlite-vec",                 // see §Vector DB Backends below
    "path": "data/projects/payments-2.7/index.db",
    "endpoint": null,                        // remote only
    "credentials_ref": null                  // remote only: secret reference
  },
  "created_at": "2026-04-25T09:00:00Z",
  "updated_at": "2026-04-25T09:00:00Z"
}
```

**Field notes:**
- `id` is `{slug(name)}-{version}` — guaranteed unique (FR-001 AC-001-05). Validated by `409 duplicate name+version` on POST `/api/projects`.
- `sources[]` is the unified shape across all six connector types — discriminated by `type`.
- `metadata_vocabulary.custom_link_fields[]` declares project-specific traceability metadata fields. Each entry must be lowercase snake_case, start with `linked_`, and must not duplicate a built-in `linked_*` field.
- `api_key_ref` and `credentials_ref` are **always references** (env var name, secret store id) — credentials are never persisted in `config.json` (security NFR).
- `precision` is mutated only via PUT; per AC-009-05, a precision change triggers a full rebuild for that project only.

#### Vector DB backends (`vectordb_config.backend`)
| Backend | Class | Storage Hint |
|---|---|---|
| `sqlite-vec` | local | per-project `.db` file |
| `qdrant` | local | host:port; collection-per-project |
| `chromadb` | local | persist-dir |
| `milvus` | local | host:port; collection-per-project |
| `weaviate` | local | host:port; class-per-project |
| `faiss` | local | per-project file (in-process) |
| `opensearch` | remote | endpoint + signed credentials |
| `pinecone` | remote | endpoint + API key |
| `qdrant-cloud` | remote | endpoint + API key |
| `weaviate-cloud` | remote | endpoint + API key |
| `milvus-cloud` | remote | endpoint + API key (Zilliz) |

### 2.2 AuditEntry
File: `data/audit.jsonl` (one JSON object per line, append-only, rotated by size — FR-014 AC-014-04, AC-014-05)

```json
{
  "timestamp": "2026-04-25T09:00:00Z",
  "action": "project.created",
  "project_id": "payments-2.7",
  "details": { "name": "Payments", "version": "2.7" },
  "ip_address": "192.168.1.100"
}
```

**Action taxonomy** (open-ended; canonical examples):
`project.created`, `project.updated`, `project.deleted`, `source.added`, `source.removed`, `model.pinned`, `model.unpinned`, `rebuild.triggered`, `refresh.triggered`, `refresh.received` (CI/CD), `audit.exported`.

**Invariant**: Entries are append-only. The web UI exposes view + filter only — no modify or delete.

### 2.3 RefreshRecord
File: `data/projects/{id}/refresh-history.json` — array of records, newest last (or rotated when file size threshold reached).

```json
{
  "timestamp": "2026-04-25T10:00:00Z",
  "type": "incremental",                       // "full" | "incremental"
  "trigger_source": "github-actions",          // "ui" | "github-actions" | "jenkins" | "mcp" | "cli" | "scheduler"
  "duration_seconds": 45,
  "documents_processed": 12,
  "status": "success",                          // "success" | "partial" | "failure"
  "error": null
}
```

Powers the web UI Refresh History tab (FR-007 AC-007-05) and `GET /api/projects/:id/status` (`refresh_history` field).

### 2.4 NormalisedChunk (in-flight, not persisted)
Output of every connector — Module 4.
```json
{
  "content": "...",
  "path": "src/payments/charge.ts",
  "source_type": "git",
  "source_url": "git.company.com/payments/blob/release-2.7/src/payments/charge.ts",
  "last_modified": "2026-04-20T11:30:00Z",
  "metadata": {
    "branch": "release/2.7",
    "lines": [12, 84],
    "artifact_type": "fr",
    "artifact_id": "FR-007",
    "linked_ac": ["AC-007-01", "AC-007-02"],
    "linked_adr": ["ADR-003"],
    "linked_test_case": ["TC-007-01"],
    "motivated_by": "REQ-GH-263",
    "provenance": "docs/requirements/requirements-spec.md:42",
    "link_confidence": 1.0
  }
}
```

#### GH#7 Traceability Metadata Vocabulary

Traceable iSDLC artifact connectors may add the following fields under `NormalisedChunk.metadata`. The embedding pipeline preserves valid fields into `EmbeddedChunk.metadata`, so they ride with the vector DB record. There is no separate graph table or substrate.

| Field | Type | Notes |
|---|---|---|
| `artifact_type` | string | One of `requirement`, `fr`, `ac`, `nfr`, `adr`, `module`, `test_case`, `task`, `review`, `risk`, `feature`, `convention`, `code`, `bug_report`, `trace_analysis`, or a project-specific custom type. |
| `artifact_id` | string | External ID such as `FR-001`, `AC-001-03`, `ADR-007`, or `BUG-GH-265`. |
| `linked_fr` | string[] | FR IDs this chunk relates to. |
| `linked_ac` | string[] | Acceptance criteria IDs covered or referenced. |
| `linked_adr` | string[] | ADR IDs that decided this scope. |
| `linked_module` | string[] | Module IDs from module design artifacts. |
| `linked_test_case` | string[] | Test case IDs covering this chunk. |
| `linked_task` | string[] | Task IDs from `tasks.md`. |
| `linked_review` | string[] | Review record IDs. |
| `linked_risk` | string[] | Risk IDs. |
| `linked_nfr` | string[] | NFR IDs. |
| `linked_feature` | string[] | Feature IDs from discovery outputs. |
| `linked_bug_fix` | string[] | Bug fix IDs such as GitHub issue numbers or `REQ-GH-XXX`. |
| `motivated_by` | string | Single artifact ID that motivated this chunk. |
| `provenance` | string | File and line that produced the link, for debugging. |
| `link_confidence` | number | `0.0` to `1.0`; use `1.0` for deterministic links and lower values for heuristic links. |

Custom link fields are declared per project in `metadata_vocabulary.custom_link_fields[]`. They must be lowercase snake_case and start with `linked_`, for example `linked_compliance_check`. Undeclared custom fields are ignored by the embedding pipeline.

#### Layered Vocabulary (REQ-GH-7)

Custom `linked_*` fields can be declared at two layers:

1. **Built-in** — the `linked_*` fields enumerated in the table above. Always in scope. Cannot be redeclared.
2. **Deployment-wide** — declared once in `data/config.json` under `metadata_vocabulary.custom_link_fields[]`. Applies to every project on the deployment. Validated at `isdlc-knowledge start` time; an invalid block aborts startup before either child process is forked.
3. **Per-project** — declared in `data/projects/{id}/config.json` under the same key. Adds project-specific fields on top of the deployment baseline. Validated on `createProject` / `updateProject` and on read-from-disk.

The **effective vocabulary** at chunk-extract time is the union of built-ins ∪ deployment ∪ project, de-duplicated. The Worker handlers (`runFullRebuild`, `runIncrementalRefresh`, `runAddContent`) merge the deployment and project vocabularies before passing the result to the embedding pipeline; the pipeline itself stays vocabulary-agnostic.

**Overlap rules**:
- A deployment field MUST NOT redeclare a built-in.
- A project field MUST NOT redeclare a built-in.
- A project field MUST NOT redeclare a field already declared deployment-wide. `createProject` / `updateProject` rejects the project config with a clear error naming the conflicting field and identifying it as a deployment-level declaration.

**Worked example**:

```jsonc
// data/config.json (deployment baseline)
{
  "server": { "host": "127.0.0.1", "api_port": 3000, "mcp_port": 0 },
  "metadata_vocabulary": {
    "custom_link_fields": ["linked_jira_epic", "linked_compliance_check"]
  }
}

// data/projects/payments-2.7/config.json (per-project addition)
{
  "id": "payments-2.7",
  "metadata_vocabulary": {
    "custom_link_fields": ["linked_squad"]
  }
}

// Effective vocabulary on chunks from project payments-2.7:
//   built-ins (linked_fr, linked_ac, ...)
// + linked_jira_epic, linked_compliance_check  (from deployment)
// + linked_squad                                (from project)
```

This satisfies the GH#7 spec target of "declared in deployment config; validated at startup" while preserving the per-project flexibility that adopters with heterogeneous artifact types need.

### 2.5 CorrelatedChunk (in-flight)
Output of Module 5 — adds `related[]`.
```json
{
  "content": "...",
  "path": "src/payments/charge.ts",
  "source_type": "git",
  "source_url": "...",
  "last_modified": "...",
  "metadata": {},
  "related": [
    { "path": "specs/payments-charge.md",          "source_type": "confluence", "relationship": "spec",  "confidence": 0.92 },
    { "path": "tests/payments/charge.test.ts",     "source_type": "git",        "relationship": "test",  "confidence": 0.98 },
    { "path": "docs/architecture/payments.md",     "source_type": "git",        "relationship": "doc",   "confidence": 0.81 }
  ]
}
```

### 2.6 EmbeddedChunk (in-flight, then persisted to Vector DB)
```json
{
  "vector": [0.012, -0.087, ...],     // float32 array, length = model dimensions
  "content": "...",
  "metadata": {
    "project": "payments-2.7",
    "path": "src/payments/charge.ts",
    "source_type": "git",
    "source_url": "...",
    "artifact_type": "fr",
    "artifact_id": "FR-007",
    "linked_ac": ["AC-007-01", "AC-007-02"],
    "related_sources": [...]          // distilled from CorrelatedChunk.related
  }
}
```

### 2.7 SearchResult (output of MCP `semantic_search`)
```json
{
  "content": "...",
  "score": 0.87,
  "project": "payments-2.7",
  "source_type": "git",
  "source_url": "...",
  "related_sources": [
    { "path": "specs/payments-charge.md", "relationship": "spec" }
  ]
}
```

---

## 3. SQLite Schemas

### 3.1 Job Queue (Module 10) — `data/queue.sqlite`

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,             -- ULID / UUID
  type            TEXT NOT NULL,                -- 'full_rebuild' | 'incremental_refresh' | 'add_content'
  payload         TEXT NOT NULL,                -- JSON-encoded job-specific payload
  status          TEXT NOT NULL DEFAULT 'queued',  -- 'queued' | 'running' | 'completed' | 'failed' | 'dead'
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,   -- ERR-QUEUE-001 dead-letter threshold
  enqueued_at     TEXT NOT NULL,                -- ISO-8601
  started_at      TEXT,
  completed_at    TEXT,
  result          TEXT,                         -- JSON
  error_code      TEXT,                         -- e.g. ERR-MODEL-001
  error_message   TEXT,
  trigger_source  TEXT,                         -- mirrors RefreshRecord.trigger_source
  project_id      TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_enqueued ON jobs(status, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_jobs_project        ON jobs(project_id);
```

**Job payload shapes** (stored in `payload`):
- `full_rebuild` → `{ project_id }`
- `incremental_refresh` → `{ project_id, source_type, repo_id, changes: [{ path, action }] }`
- `add_content` → `{ project_id, content: string | { path, text }[] }`

**Idempotency** (FR-004 NFR Reliability): an `incremental_refresh` job with the same `(project_id, repo_id, changes_hash)` produced within a debounce window collapses to a single execution.

### 3.2 SQLite-vec Adapter (Module 9, when `backend == "sqlite-vec"`) — per-project `data/projects/{id}/index.db`

Following the `sqlite-vec` extension convention:

```sql
-- Vector table (sqlite-vec virtual table)
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  embedding float[768]                         -- dimensions = model.dimensions
);

-- Companion metadata table (1:1 by rowid)
CREATE TABLE chunk_meta (
  rowid          INTEGER PRIMARY KEY,          -- matches vec_chunks rowid
  chunk_id       TEXT UNIQUE NOT NULL,
  content        TEXT NOT NULL,
  path           TEXT NOT NULL,
  source_type    TEXT NOT NULL,
  source_url     TEXT,
  last_modified  TEXT,
  related_sources TEXT,                        -- JSON
  embedded_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunk_meta_path        ON chunk_meta(path);
CREATE INDEX IF NOT EXISTS idx_chunk_meta_source_type ON chunk_meta(source_type);
```

Other Vector DB backends manage their own schemas; the adapter interface (`store / search / delete / deleteAll / stats`) is the contract.

---

## 4. Invariants

| Invariant | Enforced By |
|---|---|
| One `ProjectConfig` per project id | Config Store create-then-write semantics; 409 on duplicate |
| Project indexes are isolated | One `index.db` per project for sqlite-vec; one collection / class per project for remote backends |
| Audit log is append-only | JSONL-only writer in `src/audit/`; no overwrite path |
| Job queue jobs progress queued → running → (completed | failed) → dead | Status enum + transition checks in Module 10 |
| `max_attempts` exceeded → dead-letter | ERR-QUEUE-001; status = 'dead', no further dequeue |
| Credentials never appear in `config.json` | Schema permits `_ref` only; validator rejects bare strings on those fields |
| Refresh-history is append-only | Config Store appends; rotation by size only |

---

## 5. Migration Strategy

There is no v1-to-v2 migration concern yet (this *is* v1). For future Vector DB backend swaps (Risk: "Vector DB migration when switching backends"):
1. Read all `(content, metadata, vector)` from old adapter via `search` (or a streaming `dump` if added later).
2. Re-embed via the new `model_config` if model changed; otherwise reuse vectors.
3. Write to new adapter via `store`.
4. Update `vectordb_config` in `ProjectConfig` and atomically replace.

A migration tool can be implemented as a Worker job type in a future release.

---

## 6. References
- Interface spec (canonical types): `docs/requirements/REQ-GH-263-.../interface-spec.md`
- Module design: `docs/requirements/REQ-GH-263-.../module-design.md`
- ADRs: `docs/architecture/architecture-overview.md` §2
- Error codes: `docs/requirements/REQ-GH-263-.../error-taxonomy.md`
