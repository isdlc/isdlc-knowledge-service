# Requirements Specification: Typed metadata vocabulary for chunks from iSDLC artifacts (GH#7)

**REQ ID**: REQ-GH-7
**Source**: GitHub Issue #7
**Tier**: Light
**Scope at this REQ**: Deployment-wide vocabulary layer. The per-project layer is already implemented on `main` (see git history). This REQ closes the remaining gap between the GH#7 issue spec and the shipped behavior.
**Last updated**: 2026-04-27

---

## 1. Business Context

**Problem**: GH#7 spec declares custom `linked_X` artifact-link fields are to be configured "in deployment config; validated at startup". The shipped implementation places them in per-project config only, forcing adopters to repeat the same custom vocabulary on every project. The implementation also fails to provide the fail-fast startup validation the spec describes.

**Goal**: Deliver a layered vocabulary model — deployment-wide as baseline, per-project as additions — that satisfies the GH#7 spec while preserving the per-project flexibility the existing implementation already provides.

**Stakeholders**:
- **Deployment admin** (operator): Declares the vocabulary that applies to all projects on this server.
- **Project admin** (per-project tenant lead): May add project-specific custom fields on top of the deployment baseline.
- **Connector authors** (downstream of GH#9): Read the effective vocabulary to know which fields are accepted on chunks they emit.

**Success metric**: An adopter sets one `metadata_vocabulary.custom_link_fields` array in `data/config.json` and every chunk extracted from every project carries those fields, with no per-project re-declaration.

---

## 2. Functional Requirements

### FR-001: Deployment-wide vocabulary declaration

The deployment configuration file `data/config.json` MUST accept an optional `metadata_vocabulary.custom_link_fields[]` array of strings. Each string is a custom link field name available to all projects on this deployment in addition to the GH#7 built-ins.

**Acceptance Criteria**:
- **AC-001-01**: When `data/config.json` contains `metadata_vocabulary.custom_link_fields: ["linked_jira_epic", "linked_compliance_check"]`, the deployment-wide validator accepts the file as valid.
- **AC-001-02**: The `metadata_vocabulary` block in `data/config.json` is OPTIONAL — its absence is valid and results in an empty deployment-wide list.
- **AC-001-03**: Custom field strings MUST match the same regex used per-project: `^linked_[a-z][a-z0-9]*(?:_[a-z0-9]+)*$`. Non-matching strings cause a validation error naming the offending entry and the rule it violated.
- **AC-001-04**: Deployment-wide fields MUST NOT redeclare any GH#7 built-in `linked_*` field. Attempted redeclaration produces a validation error naming the built-in.
- **AC-001-05**: Deployment-wide list MUST be free of duplicates within itself; duplicates produce a validation error.

### FR-002: Startup validation of deployment vocabulary

The `isdlc-knowledge start` CLI MUST validate `data/config.json`'s `metadata_vocabulary` block before spawning the API or Worker child processes. An invalid block MUST cause the CLI to exit non-zero with a clear error message naming the offending fields, and MUST NOT leave any child process running.

**Acceptance Criteria**:
- **AC-002-01**: With an invalid deployment vocabulary in `data/config.json`, `isdlc-knowledge start` exits non-zero before forking children.
- **AC-002-02**: The error message includes every validation error (not just the first) and identifies `data/config.json` as the source.
- **AC-002-03**: With no `metadata_vocabulary` block in `data/config.json`, `isdlc-knowledge start` proceeds normally with an empty deployment-wide list.

### FR-003: Per-project layer respects deployment baseline

Per-project `metadata_vocabulary.custom_link_fields` continues to work, with one new constraint: a project field MUST NOT redeclare any field already declared at the deployment level.

**Acceptance Criteria**:
- **AC-003-01**: `createProject({ metadata_vocabulary: { custom_link_fields: ["linked_extra"] } })` succeeds when `linked_extra` is not in the deployment baseline.
- **AC-003-02**: `createProject({ metadata_vocabulary: { custom_link_fields: ["linked_jira_epic"] } })` fails with `INVALID_PROJECT` when the deployment baseline already declares `linked_jira_epic`. The error message names the conflicting field and identifies it as a deployment-level declaration.
- **AC-003-03**: `updateProject` enforces the same overlap rule.
- **AC-003-04**: When the project store is constructed without a deployment vocabulary (existing default), behavior is unchanged from today: only built-in redeclaration is rejected.
- **AC-003-05**: Existing per-project rules are preserved: lowercase snake_case + `linked_` prefix, no built-in redeclaration, no in-list duplicates.

### FR-004: Effective vocabulary at extract time

The Worker handlers (`runFullRebuild`, `runIncrementalRefresh`, `runAddContent`) MUST pass the union of deployment + project `custom_link_fields` (de-duplicated) as the `metadata_vocabulary` option to `pipeline.embed`. The embedding pipeline itself is unchanged — it sees a single combined vocabulary object.

**Acceptance Criteria**:
- **AC-004-01**: A chunk from project P with deployment baseline `["linked_jira_epic"]` and project P's own `["linked_squad"]` carries both `linked_jira_epic` and `linked_squad` fields after extraction (when the source chunk's metadata bag contains values for both).
- **AC-004-02**: A chunk from project P that lacks any project-level vocabulary still carries deployment-baseline fields after extraction.
- **AC-004-03**: The embedded chunk does not contain duplicate keys when deployment and project lists overlap (impossible per FR-003 enforcement, but the merge MUST be defensive against in-memory drift).
- **AC-004-04**: The merge never mutates either source array — both deployment vocabulary and project config remain unmodified after merge.

### FR-005: Documentation

`docs/architecture/data-model.md` MUST describe the layered vocabulary precedence and where each layer lives (deployment file vs project config), with a worked example. The GH#7 vocabulary table MUST remain unchanged; only the surrounding narrative is extended.

**Acceptance Criteria**:
- **AC-005-01**: `docs/architecture/data-model.md` includes a "Layered Vocabulary" section explaining built-in / deployment / project layers and merge semantics.
- **AC-005-02**: The example deployment config snippet shows the new `metadata_vocabulary` block.
- **AC-005-03**: A note states the GH#7 spec target ("declared in deployment config; validated at startup") is now satisfied by this layer.

---

## 3. Non-Functional Requirements

### NFR-001: Backward compatibility
Existing deployments with no `metadata_vocabulary` section in `data/config.json` continue to work without change. Existing per-project `metadata_vocabulary.custom_link_fields` configs continue to work with no migration required.

### NFR-002: No new runtime dependency
The change MUST be implementable with existing dependencies — no new npm packages.

### NFR-003: Test parity
All 692 existing unit tests MUST continue to pass. New tests MUST cover deployment validation (positive + negative), merge logic, overlap rejection at create/update, and worker merge plumbing.

### NFR-004: Constitutional compliance
- **Article I (Specification Primacy)**: This REQ traces FR-001..005 to GH#7 and to existing project-store ACs.
- **Article V (Pluggability Invariants)**: No adapter contract change — Vector DB and Model adapters untouched.
- **Article VI (Reliability and Idempotency)**: Stable chunk IDs unchanged; vocabulary changes do not invalidate existing IDs.
- **Article VII (Security)**: No credential surface change.

---

## 4. Edge Cases

| ID | Case | Expected behavior |
|---|---|---|
| EC-01 | `data/config.json` missing entirely | `start` continues to surface the existing "run setup first" error. No regression. |
| EC-02 | `data/config.json` malformed JSON | `start` fails with the existing JSON parse error. No new behavior introduced here. |
| EC-03 | `metadata_vocabulary` is `null` | Validation error: must be an object. (Mirrors existing per-project behavior.) |
| EC-04 | `metadata_vocabulary.custom_link_fields` is `null` | Treated as absent — empty deployment list. |
| EC-05 | `metadata_vocabulary.custom_link_fields` is `[]` | Valid — empty deployment list. |
| EC-06 | Deployment list contains the same field twice | Validation error naming the duplicate. |
| EC-07 | Project list contains a field already present in deployment list | `createProject` / `updateProject` rejects with overlap error. |
| EC-08 | Project store constructed without `deploymentVocabulary` option (legacy callers) | Behaves exactly as today — only built-in redeclaration rejected. |
| EC-09 | Worker dispatch receives a project config with no `metadata_vocabulary` and deployment has fields | Effective vocabulary equals deployment list. |
| EC-10 | Worker dispatch receives a project with project-level fields and no deployment baseline | Effective vocabulary equals project list. |
| EC-11 | A chunk's metadata bag contains a field declared by neither deployment nor project | Field is dropped at extract time. (Existing GH#7 behavior — undeclared custom fields are ignored.) |

---

## 5. Out of Scope

- Vector DB adapter filtering on these fields (GH#1 territory).
- Setup-wizard prompt for deployment vocabulary (admins hand-edit `data/config.json` for now).
- Per-source vocabulary scoping (one source declares one set of fields). Out of scope for this REQ — all fields apply to all sources within a deployment.
- Removing built-in fields. Out of scope.
- Renaming or deprecating built-in fields. Out of scope.

---

## 6. Traceability

| FR | AC | Tasks | Tests |
|---|---|---|---|
| FR-001 | AC-001-01..05 | T002 | UT-deploy-validate |
| FR-002 | AC-002-01..03 | T004 | UT-cli-startup |
| FR-003 | AC-003-01..05 | T003 | UT-project-store |
| FR-004 | AC-004-01..04 | T002, T005 | UT-merge, UT-worker-merge |
| FR-005 | AC-005-01..03 | T006 | (doc-only) |
