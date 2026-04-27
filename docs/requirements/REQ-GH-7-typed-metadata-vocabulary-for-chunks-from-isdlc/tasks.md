# Task Plan: REQ-GH-7 typed-metadata-vocabulary-for-chunks-from-isdlc

**Source**: GitHub Issue #7
**Scope at this REQ**: Deployment-wide vocabulary layer only (per-project layer already shipped).
**Tier**: Light. Phase 03 (Architecture) and Phase 04 (Design) are skipped — no new modules or interface contracts. Phase 05 (Test Strategy) is rolled into the test cases listed inline with each Phase 06 task.

## Progress Summary

| Phase | Total | Done | Remaining |
|---|---|---|---|
| 06 | 7 | 0 | 7 |
| 16 | 1 | 0 | 1 |
| 08 | 1 | 0 | 1 |
| **Total** | **9** | **0** | **9** |

## Phase 06: Implementation -- PENDING

- [ ] T001 Vocabulary library: add deployment validator + merger | traces: FR-001, FR-004, AC-001-01..05, AC-004-01..04
  files: src/pipeline/metadata-vocabulary.js (MODIFY)
  tests: tests/unit/pipeline/metadata-vocabulary-deployment.test.js (CREATE)
  description: |
    Add two new exports to src/pipeline/metadata-vocabulary.js:
      1. `validateDeploymentVocabulary(deploymentConfig)` — accepts the deployment config object,
         returns a string[] of validation errors. Validates the `metadata_vocabulary.custom_link_fields[]`
         array under the same rules as the per-project validator: lowercase snake_case, `linked_` prefix,
         no built-in redeclaration, no in-list duplicates, no null/non-array shapes. Reuses the existing
         `CUSTOM_LINK_FIELD_PATTERN` regex and `BUILTIN_LINK_FIELDS` set.
      2. `mergeVocabularies(deploymentVocab, projectVocab)` — accepts two `MetadataVocabularyConfig` objects
         (either may be undefined/null), returns a new `MetadataVocabularyConfig` with `custom_link_fields`
         set to the de-duplicated union. Defensive: never mutates inputs. Returns `{ custom_link_fields: [] }`
         when both inputs are absent.
    The existing `validateMetadataVocabularyConfig`, `customLinkFields`, and `extractTraceabilityMetadata`
    functions remain unchanged.

- [ ] T002 Project store: accept deploymentVocabulary, reject overlap | traces: FR-003, AC-003-01..05
  files: src/config/project-store.js (MODIFY), src/config/index.js (MODIFY)
  tests: tests/unit/config/project-store.test.js (MODIFY — add 4 new cases)
  blocked_by: [T001]
  description: |
    1. Extend `createProjectStore({ dataDir, deploymentVocabulary })` factory signature. The new option
       is optional — when omitted, behavior is identical to today.
    2. Extend `assertMetadataVocabularyIsValid(config)` to also reject any project field that appears
       in `deploymentVocabulary.custom_link_fields`. Error must name the offending field and identify
       it as a deployment-level declaration. Use a separate well-named helper (e.g.
       `assertNoDeploymentOverlap`) so the existing `assertMetadataVocabularyIsValid` semantics remain
       isolated and individually testable.
    3. Apply the overlap check in `createProject` and `updateProject` only — `readConfig` continues to
       validate per-project shape only (it cannot know the deployment baseline at every read site).
    4. `createConfigStore` (in `src/config/index.js`) passes `deploymentVocabulary` through to
       `createProjectStore`.

- [ ] T003 Worker: merge deployment + project vocab | traces: FR-004, AC-004-01..04
  files: src/worker/rebuild.js (MODIFY), src/worker/refresh.js (MODIFY), src/worker/index.js (MODIFY)
  tests: tests/unit/worker/rebuild.test.js (MODIFY — add 1 case), tests/unit/worker/refresh.test.js (MODIFY — add 1 case), tests/unit/worker/index.test.js (MODIFY — add 1 case for runAddContent)
  blocked_by: [T001]
  description: |
    1. `RebuildDeps` / worker dependency bag accepts a `deploymentVocabulary` field (optional).
       `startWorker(deps)` already builds `handlerDeps` — add `deploymentVocabulary` there and forward.
    2. In `runFullRebuild`, replace the existing `metadata_vocabulary: project.metadata_vocabulary` argument
       to `pipeline.embed` with `metadata_vocabulary: mergeVocabularies(deps.deploymentVocabulary, project.metadata_vocabulary)`.
       Same change in `runIncrementalRefresh` and `runAddContent`.
    3. Each worker test gains one assertion: when `deps.deploymentVocabulary` is set with one field and
       the project has another, the spy `pipeline.embed` mock receives both in its `metadata_vocabulary`
       option.

- [ ] T004 CLI start: validate deployment vocabulary at startup | traces: FR-002, AC-002-01..03
  files: src/cli/start.js (MODIFY)
  tests: tests/unit/cli/start-deployment-vocab.test.js (CREATE)
  blocked_by: [T001]
  description: |
    In `runStart`, after `readConfig()` succeeds, call `validateDeploymentVocabulary(config)`. If errors
    are returned:
      - Print each error to stdout / process.stdout (matching existing `write()` pattern).
      - Throw a clear error before `spawn()` is called. The thrown error message must reference
        `data/config.json` and list every validation error.
    The new test file uses the existing `_spawn`, `_readConfig`, `_writePid` seams to verify:
      - Invalid `metadata_vocabulary` causes throw before any spawn call.
      - Valid block proceeds normally and spawns both children.
      - Absent `metadata_vocabulary` block proceeds normally.

- [ ] T005 Wire deploymentVocabulary into Worker bootstrap | traces: FR-002, FR-004
  files: (touches the same files as T003, but specifically the worker entry-point)
  blocked_by: [T001, T003]
  description: |
    The worker entry currently reads `KNOWLEDGE_CONFIG` env var (set by start.js). In the deps wiring,
    extract `deploymentVocabulary = JSON.parse(KNOWLEDGE_CONFIG)?.metadata_vocabulary || undefined`
    and pass it to `startWorker({ deploymentVocabulary, ... })`. If the worker entry-point is currently
    a stub (T019 module-design notes the queue entry is the live wiring), this task documents the
    plumbing point and adds a TODO comment in the eventual entry script. No runtime change beyond what
    T003 already adds to the deps bag — the test for end-to-end env-var threading is deferred until the
    worker entry-point is implemented in a later REQ.

- [ ] T006 Documentation: layered vocabulary section | traces: FR-005, AC-005-01..03
  files: docs/architecture/data-model.md (MODIFY)
  blocked_by: [T001]
  description: |
    Add a "Layered Vocabulary" subsection under `2.4 NormalisedChunk` § GH#7 Traceability Metadata Vocabulary.
    Describe the three layers (built-in / deployment / project), the precedence (union with overlap rejection
    at create/update), and where each is declared (`data/config.json` for deployment, `data/projects/{id}/config.json`
    for project). Include a worked example showing both layers and the resulting effective vocabulary.
    Add a brief note that this completes the GH#7 spec target ("declared in deployment config; validated at startup").

- [ ] T007 Update REQ-GH-263 traceability — note layer added | traces: FR-005
  files: docs/architecture/data-model.md (MODIFY — already in T006)
  blocked_by: [T006]
  description: |
    Bookkeeping merge with T006: ensure the data-model.md update notes that the deployment layer was
    added under REQ-GH-7 (this REQ — the deployment layer specifically) and references GH#7 as the originating issue. No code change.

## Phase 16: Quality Loop -- PENDING

- [ ] T008 Run full test suite, lint, contract checks | traces: NFR-003
  files: (no file changes; verification only)
  blocked_by: [T001, T002, T003, T004, T005, T006, T007]
  description: |
    Run `npm run test:unit` — expected: 692 existing + ~12 new tests, all passing.
    Run `git diff --check` — expected: clean.
    Run `npm run lint` — expected to fail to start (pre-existing ESLint config issue, not introduced
    by this REQ); record the fact and continue.
    Verify all touched files are committed.

## Phase 08: Code Review -- PENDING

- [ ] T009 Code review report — coverage, risk, traceability | traces: (all)
  files: docs/requirements/REQ-GH-7-typed-metadata-vocabulary-for-chunks-from-isdlc/code-review-report.md (CREATE)
  blocked_by: [T008]
  description: |
    Standard code-review report covering: traceability completeness (every FR has a task and a test),
    constitutional compliance, risk re-assessment after implementation, deviations from the original
    impact-analysis estimates, and a final PASS / CONDITIONAL PASS / BLOCK verdict.

## Dependency Graph

```
T001 (vocab library)
 ├─→ T002 (project store)
 ├─→ T003 (worker merge)
 ├─→ T004 (CLI startup)
 ├─→ T006 (docs)
 └─→ T005 (depends on T003 too)

T002, T003, T004, T005, T006 (independent after T001)
                            |
                            └─→ T007 (docs cleanup)
                                  |
                                  └─→ T008 (quality loop)
                                        |
                                        └─→ T009 (code review)
```

Critical path: T001 → T003 → T005 → T008 → T009 (5 tasks).

## Traceability Matrix

| FR | AC | Tasks |
|---|---|---|
| FR-001 | AC-001-01..05 | T001 |
| FR-002 | AC-002-01..03 | T004, T005 |
| FR-003 | AC-003-01..05 | T002 |
| FR-004 | AC-004-01..04 | T001, T003 |
| FR-005 | AC-005-01..03 | T006, T007 |
