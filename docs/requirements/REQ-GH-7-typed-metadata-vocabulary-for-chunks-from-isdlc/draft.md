# Typed metadata vocabulary for chunks from iSDLC artifacts (GH#7)

**Source**: GitHub Issue #7
**Type**: REQ (Feature)
**Tier**: Light (skip Phase 03 architecture, Phase 04 design — small scope, no new modules)
**Scope at this REQ**: The per-project vocabulary layer of GH#7 was implemented off-framework in earlier commits (`src/pipeline/metadata-vocabulary.js`, `src/config/project-store.js`, etc., already on `main`). What remains to satisfy the GH#7 spec is the **deployment-wide vocabulary layer** described below.

## Summary

Add a deployment-wide layer for the GH#7 typed metadata vocabulary so adopters can declare custom `linked_X` artifact-link fields once at the deployment level instead of per project. Project-level `metadata_vocabulary.custom_link_fields` continues to work and is treated as additions on top of the deployment baseline. The effective vocabulary used at chunk-extract time is the union of built-ins, deployment, and project (de-duplicated, with overlap rejection at project create/update).

## Motivation

GH#7 was partially implemented on `main` by an earlier agent (commit history under `src/pipeline/metadata-vocabulary.js`, `src/config/project-store.js`, etc.). That implementation places `metadata_vocabulary.custom_link_fields` on each project's `data/projects/{id}/config.json` and validates per-project. The GH#7 issue text, however, specifies declaration "in deployment config; validated at startup". The current behavior diverges from the issue spec.

Operationally, most adopters will have one consistent custom vocabulary across all projects on a deployment (e.g. `linked_jira_epic`, `linked_compliance_check`). Forcing them to re-declare those fields in every project config is friction without benefit. At the same time, retaining a project-level override preserves flexibility for projects with genuinely distinct artifact types.

## Scope

### In scope
- Deployment-wide `metadata_vocabulary.custom_link_fields` declaration in `data/config.json` (the file written by `isdlc-knowledge setup`).
- Validation of the deployment vocabulary at server startup (CLI `start` reads and validates `data/config.json` before forking children — fail-fast).
- Project-level vocabulary continues to work; project fields rejected on create/update if they redeclare a built-in field (existing) **or** a deployment field (new).
- Worker handlers (`runFullRebuild`, `runIncrementalRefresh`, `runAddContent`) merge deployment + project vocabularies before passing to `pipeline.embed`. Pipeline is unchanged.
- Documentation update in `docs/architecture/data-model.md` describing the layered vocabulary precedence.

### Out of scope
- Setup wizard prompts for deployment-wide custom fields (admins hand-edit `data/config.json` initially).
- Vector DB adapter filtering on these fields (covered by GH#1).
- Any new fields beyond `custom_link_fields` in `metadata_vocabulary`.

## Acceptance signals

- Adopter declares `metadata_vocabulary.custom_link_fields: ["linked_jira_epic"]` in `data/config.json` and the field is preserved on every chunk extracted from every project, without per-project declaration.
- Adopter declares the same field in a project config — `createProject` rejects with a clear error stating the field is already declared at deployment level.
- Adopter declares an additional project-only field — both deployment and project fields are preserved on chunks from that project.
- Adopter ships an invalid deployment vocabulary (bad regex, redeclares built-in) — `isdlc-knowledge start` fails immediately with a clear error before any child process spawns.
- All 692 existing unit tests still pass; new tests cover deployment validation, merge logic, overlap rejection, and worker merging.

## References

- GH#7 issue text — the original spec calling for deployment-wide declaration.
- Existing implementation: `src/pipeline/metadata-vocabulary.js`, `src/config/project-store.js`, `src/worker/{rebuild,refresh,index}.js` (per-project layer, already on `main`).
- REQ-GH-263 architecture: this change does not introduce new modules; it extends Module 11 (Config Store) and Module 6 (Embedding Pipeline) plumbing only.
