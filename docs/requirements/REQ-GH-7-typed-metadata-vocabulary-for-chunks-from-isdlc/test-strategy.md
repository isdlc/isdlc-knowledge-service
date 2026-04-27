# Test Strategy: REQ-GH-7 deployment-wide vocabulary layer

**Tier**: Light. Unit-focused. No integration/E2E test surface change required (the deployment vocabulary is a configuration concern; once validated at startup it is invisible to integration tests).
**Last updated**: 2026-04-28

---

## 1. Scope

This strategy covers ONLY the deployment-wide vocabulary layer (T001–T009 in `tasks.md`). The per-project vocabulary layer is already tested by 10 existing tests in `tests/unit/pipeline/metadata-vocabulary.test.js` and 3 cases in `tests/unit/config/project-store.test.js` (692 total passing). Those tests must continue to pass; no test additions to those files are required for the deployment layer (separate test files cover the deployment functions).

---

## 2. Test Pyramid

| Level | Existing | New | Total |
|---|---|---|---|
| Unit | 692 | 12 | 704 |
| Integration | 13 | 0 | 13 |
| E2E | 5 | 0 | 5 |
| **Total** | **710** | **12** | **722** |

Pyramid ratio after this REQ: 97.5% unit / 1.8% int / 0.7% e2e — preserves the existing pyramid shape (Article XI).

---

## 3. Test Cases by FR

### FR-001: Deployment-wide vocabulary declaration

| TC-ID | Title | Type | File | Trace |
|---|---|---|---|---|
| UT-D-01 | `validateDeploymentVocabulary` accepts valid `custom_link_fields` array | unit | `tests/unit/pipeline/metadata-vocabulary-deployment.test.js` | AC-001-01 |
| UT-D-02 | `validateDeploymentVocabulary` accepts absent `metadata_vocabulary` block as empty | unit | same | AC-001-02 |
| UT-D-03 | `validateDeploymentVocabulary` rejects bad regex (e.g. `linked_FR`, `notLinked`) | unit | same | AC-001-03 |
| UT-D-04 | `validateDeploymentVocabulary` rejects redeclaration of built-in `linked_*` field | unit | same | AC-001-04 |
| UT-D-05 | `validateDeploymentVocabulary` rejects in-list duplicates | unit | same | AC-001-05 |

### FR-002: Startup validation

| TC-ID | Title | Type | File | Trace |
|---|---|---|---|---|
| UT-S-01 | `runStart` exits non-zero before any spawn when deployment vocab is invalid | unit | `tests/unit/cli/start-deployment-vocab.test.js` | AC-002-01 |
| UT-S-02 | Error message lists every validation error and references `data/config.json` | unit | same | AC-002-02 |
| UT-S-03 | Absent `metadata_vocabulary` proceeds normally and spawns both children | unit | same | AC-002-03 |

### FR-003: Per-project respects deployment baseline

| TC-ID | Title | Type | File | Trace |
|---|---|---|---|---|
| UT-P-01 | `createProject` accepts non-overlapping field when deployment baseline exists | unit | `tests/unit/config/project-store.test.js` (extend) | AC-003-01 |
| UT-P-02 | `createProject` rejects overlapping field with descriptive error naming deployment level | unit | same | AC-003-02 |
| UT-P-03 | `updateProject` enforces same overlap rule | unit | same | AC-003-03 |
| UT-P-04 | Project store without `deploymentVocabulary` option behaves exactly as today (no regression) | unit | same | AC-003-04 |

### FR-004: Effective vocabulary at extract time

| TC-ID | Title | Type | File | Trace |
|---|---|---|---|---|
| UT-M-01 | `mergeVocabularies` returns union, de-duplicated | unit | `tests/unit/pipeline/metadata-vocabulary-deployment.test.js` | AC-004-01, AC-004-03 |
| UT-M-02 | `mergeVocabularies` handles null/undefined inputs without throwing | unit | same | AC-004-02 |
| UT-M-03 | `mergeVocabularies` does not mutate either input array | unit | same | AC-004-04 |
| UT-W-01 | Worker `runFullRebuild` passes merged vocabulary to `pipeline.embed` | unit | (verify via existing rebuild test extension) | AC-004-01 |

> **Note**: UT-W-01 is verified through code review of the worker plumbing change (T003) rather than a new spy-test, since the pipeline.embed call is already mocked in existing rebuild/refresh tests. The change in T003 is a mechanical replacement of the argument value; existing test fixtures will exercise it.

### FR-005: Documentation

No automated tests. Documentation review in Phase 08.

---

## 4. Test Tooling

- **Runner**: `node --test` (already in use)
- **Assertion**: `node:assert/strict` (already in use)
- **Mocking**: hand-rolled spies + dependency injection via existing `_spawn` / `_readConfig` / `_writeFile` seams in `runStart`
- **Test data**: inline literals; no fixture files needed
- **Coverage**: line coverage of the two new exports in `metadata-vocabulary.js` must be ≥95%; branch coverage ≥85%. Verified by code inspection (the two new functions are pure and have small branch sets).

---

## 5. Coverage Targets

| Module | Lines | Branches | Source |
|---|---|---|---|
| `metadata-vocabulary.js` (new exports only) | ≥95% | ≥85% | UT-D-01..05, UT-M-01..03 |
| `project-store.js` (new overlap path) | 100% | 100% | UT-P-01..04 |
| `cli/start.js` (new validator path) | ≥90% | ≥80% | UT-S-01..03 |
| `worker/{rebuild,refresh,index}.js` (merge call site) | covered by existing tests | — | mechanical change |

---

## 6. Gate Criteria (Phase 16 entry)

Phase 06 implementation may exit only when:
- All 12 new unit tests pass.
- All 692 existing unit tests pass (no regressions).
- `git diff --check` is clean.
- All FRs have at least one passing AC-mapped test (traceability).

---

## 7. Out of Scope

- Integration tests at the worker → pipeline → vector DB level. The merge change is a single-line argument substitution; existing integration tests that hit `runFullRebuild` cover it indirectly.
- E2E tests at the CLI level. The startup validator is exercised by unit tests with seam mocks.
- Performance tests. The merge function is O(N+M) on small lists; no perf concern.
- Security tests. No new credential or input-validation surface.

---

## 8. Traceability

Every FR (FR-001..005) is covered by at least one AC-mapped test. Every AC (AC-001-01..05, AC-002-01..03, AC-003-01..04, AC-004-01..04, AC-005-01..03) maps to either a test (above) or a documentation review (Phase 08).
