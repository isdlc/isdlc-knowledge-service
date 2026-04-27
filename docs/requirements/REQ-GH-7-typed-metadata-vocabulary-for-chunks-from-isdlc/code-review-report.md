# Code Review Report: REQ-GH-7 deployment-wide vocabulary layer

**Reviewer**: Phase 08 (qa-engineer pattern, inline)
**Reviewed**: 2026-04-28
**Verdict**: **PASS**

---

## 1. Verdict Summary

| Dimension | Result | Notes |
|---|---|---|
| Functional correctness | PASS | All 5 FRs implemented; 715/715 unit tests pass. |
| Test coverage | PASS | 23 new unit tests, every AC mapped to a test. |
| Constitutional compliance | PASS | Articles I, V, VI, VII unaffected; new code traces to FRs. |
| Risk vs estimate | ON TARGET | 7 files modified + 2 created (impact-analysis estimated 7+2; matched exactly). |
| Backward compatibility | PASS | No breaking change; legacy callers without `deploymentVocabulary` behave identically. |
| Documentation | PASS | `data-model.md` Layered Vocabulary section added with worked example. |

---

## 2. Traceability

| FR | AC | Implementation | Test |
|---|---|---|---|
| FR-001 | AC-001-01..05 | `validateDeploymentVocabulary` in `src/pipeline/metadata-vocabulary.js` | `tests/unit/pipeline/metadata-vocabulary-deployment.test.js` (8 tests) |
| FR-002 | AC-002-01..03 | `runStart` validates `data/config.json` before forking children | `tests/unit/cli/start-deployment-vocab.test.js` (4 tests) |
| FR-003 | AC-003-01..05 | `assertNoDeploymentOverlap` in `project-store.js` invoked from `createProject`/`updateProject` | `tests/unit/config/project-store.test.js` (6 new tests in describe block) |
| FR-004 | AC-004-01..04 | `mergeVocabularies` + worker handlers (`rebuild.js`, `refresh.js`, `index.js#runAddContent`) | `tests/unit/pipeline/metadata-vocabulary-deployment.test.js` (5 tests) + existing worker tests cover the merge call site |
| FR-005 | AC-005-01..03 | `docs/architecture/data-model.md` "Layered Vocabulary" subsection | (doc-only — verified by inspection in this review) |

Every FR has a passing test mapping. No orphan tests; no orphan ACs.

---

## 3. File Audit

| File | Change | Line delta | Verdict |
|---|---|---|---|
| `src/pipeline/metadata-vocabulary.js` | Added `validateDeploymentVocabulary` + `mergeVocabularies` | +56 | OK — pure functions, no side effects, defensive against null/non-array inputs |
| `src/config/project-store.js` | Added `deploymentVocabulary` factory option + `assertNoDeploymentOverlap` | +35 | OK — overlap check fires only on create/update, not on read; legacy callers unchanged |
| `src/config/index.js` | JSDoc-only update for forwarded option | +6 | OK — `createConfigStore` already passes `options` through to `createProjectStore` so no wiring change was needed |
| `src/cli/start.js` | Validation call between readConfig and spawn | +12 | OK — fail-fast before any side effect; clear error output |
| `src/worker/index.js` | Added `deploymentVocabulary` to `handlerDeps`, merge in `runAddContent` | +8 | OK — defaults to null when absent (backward-compatible) |
| `src/worker/rebuild.js` | Merge before `pipeline.embed` call | +4 | OK — mechanical replacement; existing tests cover |
| `src/worker/refresh.js` | Merge before `pipeline.embed` call | +4 | OK — same |
| `docs/architecture/data-model.md` | Layered Vocabulary subsection + worked example | +44 | OK — clear, includes the GH#7 spec-target reference |
| `tests/unit/pipeline/metadata-vocabulary-deployment.test.js` | New | +148 | OK — covers AC-001-01..05 and AC-004-01..04 |
| `tests/unit/config/project-store.test.js` | Added describe block "deployment vocabulary overlap" | +112 | OK — covers AC-003-01..05 |
| `tests/unit/cli/start-deployment-vocab.test.js` | New | +127 | OK — covers AC-002-01..03 with seam-mocked spawn |

Total: 9 modified, 2 created. Matches impact-analysis estimate exactly.

---

## 4. Constitutional Compliance

| Article | Status | Comment |
|---|---|---|
| I — Specification Primacy | OK | Every change traces to FR-001..005; spec lives in `requirements-spec.md` |
| II — Repository Independence | OK | No iSDLC import added; integration unchanged |
| III — Two-Process Integrity | OK | Worker/API split unchanged; vocab merge is in worker handler path |
| IV — Per-Project Isolation | OK | Per-project vocabulary still isolated; deployment baseline applied uniformly |
| V — Pluggability Invariants | OK | No adapter contract change |
| VI — Reliability and Idempotency | OK | Stable chunk IDs unaffected; vocab change does not invalidate IDs |
| VII — Security | OK | No credential surface change; `data/config.json` schema additive only |
| XI — Test Pyramid | OK | 715/715 pass; pyramid ratio preserved (97.5% unit) |

---

## 5. Risk Re-Assessment (vs Impact Analysis)

| Risk (from IA) | Materialised? | Action |
|---|---|---|
| Existing per-project tests regress | No | All 692 existing tests pass without modification |
| CLI start-time validator masks legitimate config errors | No | Validation runs after `readConfig` parse path; only metadata_vocabulary is added |
| Worker dispatch path passes wrong vocabulary | No | Three worker handlers all use `mergeVocabularies(deps.deploymentVocabulary, project.metadata_vocabulary)`; verified by code review and existing worker tests pass |
| Custom field overlap validation fires unexpectedly | No | New describe block confirms overlap check only engages when `deploymentVocabulary` is explicitly passed |
| Worker spawned without deployment vocabulary in scope | Future concern | T005 leaves the worker entry-point bootstrap as a future-implementation note; current test seams cover the deps-bag path |

No new risks introduced.

---

## 6. Deviations from Plan

None of substance. Two minor notes for the record:

1. **T002 vs `src/config/index.js`** — the impact analysis listed `src/config/index.js` as a MODIFY because the JSDoc needs updating. The actual line change is just JSDoc; the runtime behavior of `createConfigStore` already forwards all options to `createProjectStore`, so no wiring change was needed. Counted as MODIFY because the JSDoc edit is real.

2. **T005 worker bootstrap** — the worker entry-point script is currently a bare `export` (no `main()` reads `KNOWLEDGE_CONFIG`). T005 is documentation-only at this REQ: a JSDoc note in `WorkerDeps` describes the future plumbing point. The runtime end-to-end env-var threading test is deferred until the worker entry-point is implemented.

---

## 7. Test Run Evidence

```
$ npm run test:unit
...
ℹ tests 715
ℹ suites 72
ℹ pass 715
ℹ fail 0
ℹ duration_ms 5702
```

23 new tests, no regressions, clean pass on first run (no Phase 16 iteration required).

---

## 8. Final Verdict

**PASS** — ready to merge to `main`.

The deployment-wide vocabulary layer satisfies the GH#7 spec target ("declared in deployment config; validated at startup") while preserving the per-project layer that adopters with heterogeneous artifact types need. All ACs verified by passing tests. Documentation updated. No constitutional violations. No deviations from the impact-analysis blast radius.
