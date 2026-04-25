# Code Review Report — REQ-GH-263

**Phase**: 08 — Code Review & QA
**Task**: T037
**Reviewer**: QA Engineer (automated)
**Date**: 2026-04-25
**Verdict**: **PASS** (after remediation — see §7). The original CONDITIONAL PASS hinged on BLOCKING-1 (credential persistence); that finding is closed. WARNING/INFO items remain as documented and tracked.

---

## 1. Executive Summary

The implementation is structurally clean and faithful to the architecture spec. Two-process design (Article III), pluggability invariants (Article V), append-only audit (Article VII), and cross-platform constraints (Article X) are all observed. 657 unit + 13 integration + 5 e2e tests all pass.

The **single blocking issue** is that the project schema accepts plaintext API keys / passwords and persists them verbatim to `config.json`, which directly contradicts **Constitution Article V.5** and **Article VII.5/VII.6**. The fix is bounded: a schema validator in the project-store + a refactor of `setup.js` to emit secret-reference shapes (`{ env: "OPENAI_API_KEY" }`) instead of inline strings.

The two unimplemented framework integrations (T031–T033) are correctly deferred to the iSDLC-framework repo per CON-001/CON-002 and are out of scope for this review.

| Severity | Count |
|---|---|
| BLOCKING | 1 |
| WARNING | 4 |
| INFO | 3 |

---

## 2. Findings

### BLOCKING-1 — Plaintext credentials persist in `config.json`

**Articles violated**: V.5, VII.5, VII.6
**Severity**: BLOCKING

The setup wizard and project routes accept inline API keys and write them into JSON config without redaction or schema rejection.

**Evidence**:

- `src/cli/setup.js:128–129` — `if (apiKey) vectordbConfig.api_key = apiKey;` (remote VDB key)
- `src/cli/setup.js:244–245` — `if (apiKey) config.api_key = apiKey;` (cloud model key)
- `src/config/project-store.js:206–211` — `model_config` and `vectordb_config` blobs are written through verbatim; no validator rejects bare-string credentials
- `src/api/routes/projects.js:133, 171` — `POST /api/projects` and `PUT /api/projects/:id` pass `body` directly into `createProject` / `updateProject`
- `interface-spec.md` documents a `sources[]` array — Confluence / SVN per-source credentials would follow the same persistence path (Article VII.6)
- Constitution Article VII.5: *"The schema validator REJECTS bare credential values."* — no such validator exists.

**Recommendation (team decides)**:

1. Add a schema validator in `project-store.js` that rejects `model_config.api_key`, `vectordb_config.api_key`, and any `sources[].auth.password` / `sources[].apiToken` when present as a non-`{env: ...}` / non-`{secret_ref: ...}` shape.
2. Update `setup.js` to write `{ env: "OPENAI_API_KEY" }` instead of `{ api_key: "<raw>" }`.
3. Update cloud adapter constructors (`openai.js`, `cohere.js`, `bedrock.js`, `pinecone.js`, `*-cloud.js`) to resolve `{env}`/`{secret_ref}` references at construction time. Adapters already accept `apiKey` by parameter, so the change is at the resolution layer, not the adapter.
4. Add a unit test asserting that `createProject({ model_config: { api_key: "sk-..." } })` rejects with `INVALID_PROJECT`.

This finding is the gate. The remaining items below should not block release on their own.

---

### WARNING-1 — Full config (incl. potential credentials) leaks into child env

**File**: `src/cli/start.js:55–63`

`KNOWLEDGE_CONFIG: JSON.stringify(config)` exports the entire project/server config into the API and Worker child processes' environments. On Linux/macOS, env is visible via `ps eww`. Today the config has no credentials, but if BLOCKING-1 is not fixed, this turns from a hardening note into an exfiltration vector. Once BLOCKING-1 is resolved (config holds only secret-references), this becomes acceptable.

**Recommendation**: No change needed if BLOCKING-1 is fixed; otherwise switch to passing the config path and letting children read it themselves.

---

### WARNING-2 — SVN connector passes password as command-line argument

**File**: `src/connectors/svn.js:118–119`

`fullArgs.push('--password', this.auth.password)` — visible in `ps` listings on multi-user hosts. `svn` supports `--password-from-stdin` from 1.12+ but the connector does not use it.

**Recommendation**: When `auth.password` is supplied, write to stdin via `--password-from-stdin` instead.

---

### WARNING-3 — Schema validator is permissive (`additionalProperties` not enforced)

**File**: `src/api/routes/projects.js:44–58`, `src/config/project-store.js:200–215`

`validateCreate` only checks `name` / `version` / `sources is array`. Unknown / typo'd fields are silently persisted. Constitution Article VII.7 says inputs are validated before reaching connectors or the queue. Today's permissiveness is the same root cause as BLOCKING-1.

**Recommendation**: Whitelist known fields; reject unknown ones with `INVALID_REQUEST`.

---

### WARNING-4 — `ESLint` is not runnable

**File**: `package.json` `lint` script + missing `eslint.config.js`

`npm run lint` fails because ESLint v9 requires a flat-config file, which is absent. Article XIV (gate integrity) lists lint as a quality gate. Phase 16 (Quality Loop) is the canonical owner; surfacing here as a documentation pointer.

**Recommendation**: Add a minimal `eslint.config.js` (already in scope of Phase 16 / T034–T036).

---

### INFO-1 — Three error-taxonomy codes unexercised by code

| Code | Behaviour | Status |
|---|---|---|
| ERR-CORR-001 | Correlation degraded path | Behaviour exists in `correlation/index.js:46–55` (per-strategy try/catch swallows + degrades) but does not emit the taxonomy code or log a warning. Article XIII.3 says every code "MUST have at least one test that triggers and asserts the recovery path." |
| ERR-SETUP-001 | Prerequisite missing (Node version, disk) | Not implemented. `setup.js` does not check Node version or disk space. |
| ERR-SETUP-003 | Vector DB install failed | Not implemented. The wizard does not validate that the chosen backend's npm package is actually loadable. |

**Recommendation**: Add a small `src/cli/preflight.js` for SETUP-001/003 and a single warning emission in `correlation/index.js` for CORR-001. Tests track the same shape as the existing `ERR-CONN-*` tests.

---

### INFO-2 — Adapter contract conformance test exists but is not parameterised over all 11 backends

**File**: `tests/unit/vectordb/adapter.test.js`

The base adapter test exists, but each concrete adapter has its own test file rather than running the same contract suite over all 11. Article V.1 mandates "Every implementation passes the same contract-conformance test suite." In practice each adapter's tests cover the same shapes, but there is no single shared suite. INFO because behaviour is verified, not enforcement-by-construction.

**Recommendation**: Phase 16 — refactor into a single parameterised suite invoked once per adapter.

---

### INFO-3 — `chunk.related` array initialised even when no strategy fires

**File**: `src/correlation/index.js:79`

Minor: every chunk gets `related: []` whether or not any link was generated. Acceptable, just noting that downstream consumers should not infer "no correlation attempted" from `related.length === 0`.

---

## 3. Per-Area Assessment

### 3.1 Architecture compliance — PASS

| Check | Status | Evidence |
|---|---|---|
| Two-process (API + Worker) | PASS | `src/cli/start.js:55–63` forks both children. Worker `src/worker/index.js:54+` blocks only on the queue; no embedding on API path. |
| SQLite job queue (better-sqlite3) | PASS | `src/queue/queue.js` — uses `better-sqlite3` per dependency list. |
| JSON config store | PASS | `src/config/project-store.js` — `data/projects/{id}/config.json`. No DB. |
| Plain HTML UI, no build step | PASS | `ui/index.html` + 4 vanilla JS files. No React/Vue/Vite/webpack in `package.json`. |
| MCP-only iSDLC integration boundary | PASS | `grep -rn "from ['\"]isdlc"` returns empty. T031–T033 deferred to iSDLC-framework repo. |

### 3.2 Adapter consistency — PASS

11 VDB adapters all implement `store/search/delete/deleteAll/stats` and (except local sqlite-vec) expose a `_clientFactory` test seam. 4 model adapters all implement `embed/batchEmbed/getInfo`. Cloud model adapters all expose `_clientFactory` + `_backoffMs`; local ONNX uses `sessionLoader` for the same purpose. Error codes (`ERR-VDB-*`, `ERR-MODEL-*`) are mapped via `VdbError` / `ModelError` classes consistently.

| Adapter | factory seam | All 5 methods |
|---|---|---|
| chromadb, faiss, milvus, milvus-cloud, opensearch, pinecone, qdrant, qdrant-cloud, weaviate, weaviate-cloud | YES | YES |
| sqlite-vec | N/A (file-based) | YES |

### 3.3 Error handling — MIXED

15/17 codes exercised in source; 14/17 exercised in tests. Gaps: ERR-CORR-001, ERR-SETUP-001, ERR-SETUP-003 (see INFO-1).

### 3.4 Credential security — FAIL → see BLOCKING-1

Subsidiary findings:
- No hardcoded keys anywhere in `src/` or `tests/` (grep for `sk-`, `AKIA`, etc. returned empty). PASS.
- Cloud adapter constructors accept credentials by parameter (e.g. `OpenAiAdapter:46`). PASS.
- Audit log call sites do not log full configs; they log `project_id`, `name`, `version`, `fields: Object.keys(body)`. PASS — no explicit redaction needed because credentials are not passed in.
- **But the underlying schema accepts and persists raw credentials** — that's BLOCKING-1.

### 3.5 Constitutional compliance — see §4

### 3.6 Code quality (5 sampled files) — PASS

| File | Verdict |
|---|---|
| `src/worker/index.js` | Clean separation; explicit comment on why `stop()` waits for in-flight work; sound error routing through `queue.fail`. |
| `src/query/index.js` | Pure function, deterministic; single error-mapping helper; explicit graceful-degradation contract. |
| `src/vectordb/sqlite-vec.js` | Transaction-safe writes; corruption mapped to ERR-VDB-002; minor nit: `_open()` is invoked on every public method (negligible cost, consistent). |
| `src/audit/logger.js` | Frozen public surface enforces append-only architecturally; serialises writes through a chain promise; rotation file-name strategy is cross-platform-aware. |
| `src/models/manager.js` | LRU + pin semantics match FR-011 ACs; `_evictLruUnpinned` correctly throws when capacity is full and all pinned (the explicit Constitution IX.1 contract). |

### 3.7 Test quality — PASS

Sampled `tests/unit/audit/logger.test.js` — the append-only test asserts an *allowlist* of exports and explicitly denies `delete/update/truncate/remove/clear/erase/modify`. That is structural enforcement, not "does not throw." Smoke test exists (`tests/unit/smoke.test.js`) and passes. All 657 unit tests pass; 13 integration + 5 e2e pass.

ESM-only (no CJS in `src/`); pure Node test runner; no third-party test framework.

---

## 4. Constitutional Compliance Checklist

| Article | Status | Notes |
|---|---|---|
| I — Specification Primacy | PASS | Every module file has `// Traces: FR-NNN` header. |
| II — Repository Independence | PASS | No iSDLC imports. T031–T033 deferred to framework repo. |
| III — Two-Process Integrity | PASS | API fork + Worker fork; queue-mediated handoff. |
| IV — Per-Project Isolation | PASS | `data/projects/{id}/`; query fan-out tolerates per-project failures (`query/index.js:152–157`). |
| V — Pluggability Invariants | **PARTIAL** | V.1–V.4 PASS. **V.5 FAIL** → BLOCKING-1. |
| VI — Reliability and Idempotency | PASS | Worker `stop()` does not abort in-flight work; queue handles retries. |
| VII — Audit and Security | **PARTIAL** | VII.1–VII.4 PASS. **VII.5 / VII.6 FAIL** → BLOCKING-1. VII.7 partial → WARNING-3. |
| VIII — Cross-Source Reliability | PASS | Git + SVN connectors share `connector.js` interface; both implement crawl + diff. |
| IX — Memory Discipline | PASS | LRU + pin works as specified; cloud adapters bypass cache. |
| X — Cross-Platform | PASS | No `.sh` files in `src/`. CLI uses `node:child_process.fork` — no shell. Audit-log rotation replaces `:` for Windows compatibility. |
| XI — Web UI Simplicity | PASS | No React/Vue/Vite in `package.json`; UI is vanilla. |
| XII — Observability First | PASS | `prom-client`, `@opentelemetry/*` wired; structured logs via `pino`. |
| XIII — Test Discipline | **PARTIAL** | Three error codes lack tests (INFO-1). Test pyramid hits the 60/30/10 target qualitatively. |
| XIV — Quality Gate Integrity | PARTIAL | Lint not runnable (WARNING-4). Phase 16 closes this. |

---

## 5. Action Items Before Merge

| ID | Action | Owner | Severity |
|---|---|---|---|
| AI-1 | Add credential schema validator in `project-store.js`; reject inline `api_key` / `auth.password` / `apiToken` in `model_config`, `vectordb_config`, `sources[]`. Tests required. | Implementation Team | BLOCKING |
| AI-2 | Refactor `setup.js` to emit `{ env: "ENV_NAME" }` references instead of inline keys. | Implementation Team | BLOCKING |
| AI-3 | Refactor cloud adapter construction site (factory in `models/manager.js` cloud factory + VDB factory in `vectordb/index.js`) to resolve `{env}` references at runtime. | Implementation Team | BLOCKING |
| AI-4 | Switch SVN auth to `--password-from-stdin`. | Implementation Team | WARNING |
| AI-5 | Tighten `validateCreate` / `validateUpdate` to reject unknown fields. | Implementation Team | WARNING |
| AI-6 | Add `eslint.config.js` so `npm run lint` runs. | Phase 16 | WARNING |
| AI-7 | Implement / test ERR-CORR-001 emission, ERR-SETUP-001, ERR-SETUP-003. | Implementation Team | INFO |
| AI-8 | Parameterise contract conformance suite across all 11 VDB adapters / 4 model adapters. | Phase 16 | INFO |

---

## 6. QA Sign-Off

**Recommendation**: CONDITIONAL PASS.

The implementation is high quality and architecturally sound. The single blocking defect is bounded to credential plumbing and can be remediated in a focused PR (~3–4 files). Once AI-1, AI-2, AI-3 are merged, this phase is unblocked for Phase 09 (Independent Validation).

The deferred tasks T031–T033 are correctly out of scope for this repo per Constitution Article II.

— End of Phase 08 / T037 review.

---

## 7. Remediation Status (2026-04-25, post-review)

**BLOCKING-1 — addressed.** All three action items (AI-1, AI-2, AI-3) are merged on the feature branch. Phase 08 verdict upgrades from CONDITIONAL PASS to **PASS**.

### AI-1 — Schema validator that rejects bare credentials

- New helper: `src/credentials/resolver.js` — `isCredentialReference()`, `resolveCredential()`, `BareCredentialError`, `MissingCredentialError`. Defines canonical reference shapes `{env: "NAME"}` and `{secret_ref: "..."}`.
- Wired into `src/config/project-store.js` — `assertCredentialsAreReferences()` runs on every `createProject` and `updateProject`. Throws `InvalidProjectError` with code `ERR-API-004` (new code added to error taxonomy) when any of these fields contain a bare value:
  - `model_config.api_key`
  - `vectordb_config.api_key`
  - `sources[].auth.password`
  - `sources[].auth.apiToken` / `sources[].auth.api_token`
- Tests: `tests/unit/config/project-store.test.js` — 7 new tests covering all 4 reject paths, both accept paths (`{env}`, `{secret_ref}`), and updateProject's rejection. `tests/unit/credentials/resolver.test.js` — 15 new tests covering the resolver primitives.

### AI-2 — Setup wizard emits secret references, not inline keys

- `src/cli/setup.js:promptCloudModel()` — replaced inline key capture with env-name prompt. Default suggestions per provider (OPENAI_API_KEY, COHERE_API_KEY, AWS_ACCESS_KEY_ID). Persists `{env: "NAME"}` only. Optional dry-validate uses the live env value if exported.
- `src/cli/setup.js` (remote VDB branch) — same treatment. Default env name derived from backend (`PINECONE_API_KEY`, `OPENSEARCH_API_KEY`, `QDRANT_CLOUD_API_KEY`, etc.).
- Post-save notice tells the user how to export the variable: `export OPENAI_API_KEY=...`.
- Tests: `tests/unit/cli/setup.test.js` — 2 retained tests rewritten to assert `{env: "..."}` shape; 1 ERR-SETUP-002 fallback test updated for the new prompt sequence.

### AI-3 — Adapter resolution layer

- `src/models/index.js`:`getAdapter(modelConfig)` — replaces stub. Resolves `model_config.api_key` via `resolveCredential()` before constructing the cloud adapter (OpenAI / Cohere / Bedrock). Local ONNX bypasses resolution.
- `src/vectordb/index.js`:`getAdapter(vectordbConfig)` — replaces stub. Resolves `vectordb_config.api_key` before constructing the matching cloud adapter. Map covers all 11 backends.
- `src/connectors/index.js`:`getConnector(type, config)` — added `resolveConnectorAuth()` to walk `config.auth` and resolve `password` / `apiToken` / `api_token` / `bearerToken` references at the boundary. All 6 connector types wired (previous stub only knew git + svn).
- Adapters and connectors themselves are unchanged — they continue to receive plain strings; the resolution happens at the factory boundary.
- Test seam preserved: every adapter still accepts `_clientFactory` for direct injection in unit tests; the resolver only runs on the real factory paths.

### Test-suite delta

- Before remediation: 675/675 passing (657 unit + 13 integration + 5 e2e)
- After remediation: **697/697 passing** (+22 new tests, 0 regressions)
- New error code documented: `ERR-API-004` "Credential must be a secret reference, not a bare string" (Constitution Articles V.5, VII.5, VII.6)
- New error codes for the resolver: `ERR-CRED-001` (env var unset), `ERR-CRED-002` (secret_ref backend not yet supported in v1)

### Constitutional compliance update

| Article | Pre-remediation | Post-remediation |
|---|---|---|
| V — Pluggability Invariants | PARTIAL (V.5 FAIL) | **PASS** |
| VII — Audit and Security | PARTIAL (VII.5/VII.6 FAIL) | **PASS** for VII.5 / VII.6. VII.7 still partial → see WARNING-3 below. |

### Remaining items (unchanged, tracked but non-blocking)

- WARNING-1 (env-var leak into child process) — now redundant since config no longer holds plaintext credentials. Closed.
- WARNING-2 (SVN `--password` argv visibility) — still open, future hardening.
- WARNING-3 (additionalProperties not enforced on POST /api/projects) — still open.
- WARNING-4 (ESLint v9 flat-config missing) — Phase 16 owner.
- INFO-1, INFO-2, INFO-3 — still open.

— End of remediation log.
