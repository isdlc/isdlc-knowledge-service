# Impact Analysis: REQ-GH-7 Typed metadata vocabulary — deployment-wide layer

**Source**: GitHub Issue #7
**Last updated**: 2026-04-27
**Scope at this REQ**: Deployment-wide vocabulary layer only. The per-project layer is already on `main`.

---

## 1. Sizing Metrics

| Metric | Value |
|---|---|
| Files affected | 7 (5 modified, 2 created) |
| Modules touched | 4 (Pipeline, Config Store, CLI, Worker) |
| Risk score | low |
| Coupling | low |
| Coverage gaps | 0 (all touched modules already have unit tests) |

**Sizing recommendation**: **Light**.

Rationale: Small surface area (7 files, ~250 LOC change estimate). No new modules, no new public APIs at the wire level (deployment validation is purely additive in the CLI startup path). All existing modules touched have established test coverage (692 passing tests). No data-model migration. No security-sensitive surface change.

---

## 2. Blast Radius

### Files modified

| File | Module | Change | Reason |
|---|---|---|---|
| `src/pipeline/metadata-vocabulary.js` | Pipeline | MODIFY | Add `validateDeploymentVocabulary()` and `mergeVocabularies()`. Existing exports unchanged. |
| `src/config/project-store.js` | Config Store | MODIFY | `createProjectStore({ deploymentVocabulary? })` factory option. Validator extended to reject overlap with deployment list. |
| `src/config/index.js` | Config Store | MODIFY | Pass-through `deploymentVocabulary` option through `createConfigStore`. |
| `src/cli/start.js` | CLI | MODIFY | Read + validate `data/config.json` `metadata_vocabulary` block before forking children. |
| `src/worker/rebuild.js` | Worker | MODIFY | Compute merged vocabulary from `deps.deploymentVocabulary` + `project.metadata_vocabulary`, pass to `pipeline.embed`. |
| `src/worker/refresh.js` | Worker | MODIFY | Same as rebuild.js. |
| `src/worker/index.js` | Worker | MODIFY | Same as above for `runAddContent`. |
| `docs/architecture/data-model.md` | Docs | MODIFY | Add Layered Vocabulary section. |

### Files created

| File | Purpose |
|---|---|
| `tests/unit/pipeline/metadata-vocabulary-deployment.test.js` | Unit tests for `validateDeploymentVocabulary` + `mergeVocabularies`. |
| `tests/unit/cli/start-deployment-vocab.test.js` | Unit tests for CLI start-time validation of `data/config.json` `metadata_vocabulary`. |

### Files NOT modified (intentional preservation)

- `src/pipeline/index.js` — pipeline `embed()` accepts `metadata_vocabulary` option; the merged value is passed in by the worker. Pipeline stays vocabulary-agnostic.
- `src/connectors/connector.js` — `NormalisedChunk` JSDoc already widened in the GH#7 work.
- All `src/connectors/*.js` — no connector changes; deployment vocabulary is consumed at the chunk-extract step in the pipeline.
- All `src/vectordb/*.js` — adapter contract unchanged.
- All `src/models/*.js` — model contract unchanged.

---

## 3. Coupling Map

```
data/config.json (deployment)        [source of truth — deployment baseline]
        |
        |  read at startup
        v
src/cli/start.js                     [validator + child-process spawner]
        |
        |  KNOWLEDGE_CONFIG env var (existing pipe)
        v
src/worker/index.js                  [Worker entry]
        |
        |  deps.deploymentVocabulary + project.metadata_vocabulary
        v
src/worker/{rebuild,refresh}.js      [merge step before pipeline.embed]
        |
        |  options.metadata_vocabulary (merged)
        v
src/pipeline/index.js                [embed() — unchanged, vocabulary-agnostic]
        |
        |  extractTraceabilityMetadata(chunk.metadata, options.metadata_vocabulary)
        v
src/pipeline/metadata-vocabulary.js  [extraction + new validators]
                                     [validateDeploymentVocabulary, mergeVocabularies]
```

Coupling is one-directional and shallow: the deployment vocabulary value is read once at CLI startup and threaded through the existing dependency-injection chain. No circular coupling. No new module-to-module imports beyond what already exists.

---

## 4. Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Existing per-project tests regress | low | Project-store factory's `deploymentVocabulary` option defaults to undefined — legacy behavior preserved (AC-003-04). Existing tests should pass without modification. |
| CLI start-time validator masks legitimate config errors | low | Validation runs AFTER existing `readConfig()` parse error path. Only the new `metadata_vocabulary` block is added to validation. JSON parse / file-missing errors retain current handling. |
| Worker dispatch path passes wrong vocabulary | low | All three worker handlers (rebuild, refresh, add_content) currently pass `project.metadata_vocabulary` directly. Change is mechanical: replace direct pass with `mergeVocabularies(deps.deploymentVocabulary, project.metadata_vocabulary)`. New unit test verifies pass-through with merged value. |
| Custom field overlap validation fires unexpectedly | low | Overlap check only triggers when `deploymentVocabulary` is explicitly passed to the project store — i.e. only when deployment config declares fields. Adopters who don't use the deployment layer see no behavior change. |
| Worker spawned without deployment vocabulary in scope | low | Worker entry receives `KNOWLEDGE_CONFIG` env var (already established pipe). The worker bootstrap (currently outside the scope of this REQ — worker entry script is a stub) reads `KNOWLEDGE_CONFIG.metadata_vocabulary?.custom_link_fields` and threads through `deps.deploymentVocabulary`. Defensive default: empty list when missing. |

---

## 5. Testing Surface

### New unit tests

1. **`validateDeploymentVocabulary`** — positive cases (valid declaration, empty list, missing block) + negative cases (bad regex, redeclares built-in, duplicates, wrong shape).
2. **`mergeVocabularies(deployment, project)`** — concatenation + de-dup; merge of empty lists; merge with one or both null/undefined.
3. **`createProject` with `deploymentVocabulary` set** — accepts non-overlapping project field; rejects overlapping field with descriptive error mentioning deployment level.
4. **`updateProject` with `deploymentVocabulary` set** — same overlap rules.
5. **CLI start.js** — invalid `metadata_vocabulary` block in `data/config.json` causes non-zero exit before children spawn. Valid block proceeds.
6. **Worker handlers** — rebuild / refresh / add_content all pass merged vocabulary to `pipeline.embed`.

### Existing tests touched

- `tests/unit/config/project-store.test.js` — extend with overlap-rejection cases. Existing cases unchanged.
- `tests/unit/pipeline/pipeline.test.js` — no change required; the pipeline test already passes a vocabulary directly. The pipeline doesn't know whether the vocabulary came from a single source or a merge.
- `tests/unit/pipeline/metadata-vocabulary.test.js` — unchanged, supplemented by the new deployment-specific test file.

### Integration / E2E surface

No integration or E2E test changes required. The deployment vocabulary is a configuration-time concern; once validated at startup it is invisible to integration tests of the indexing pipeline (they will see fields on chunks, which is what they already test via the per-project layer).

---

## 6. Rollout

- Single PR. No phased rollout, no feature flag. The change is additive: deployments without a `metadata_vocabulary` block in `data/config.json` see identical behavior to today.
- Documentation update lands with the code change.
- No data migration needed.
