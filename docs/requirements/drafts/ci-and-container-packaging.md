# CI pipeline and container packaging for centralised deployment

**Source**: TBD (file as GitHub issue, then rename folder to `REQ-GH-{n}-ci-and-container-packaging`)
**Type**: REQ (Feature)
**Tier**: Light (no new runtime modules; CI config + Dockerfile + compose + docs only)

## Summary

Add a GitHub Actions CI pipeline that runs lint, unit, and integration tests on every PR and push to `main`, plus a Dockerfile and `docker-compose.yml` that produce a runnable container image with Postgres for local development and centralised hosting. Together these turn the PRD's "centrally hosted" claim into something operators can actually stand up, and give every future REQ a verification gate before merge.

## Motivation

Two structural gaps block the PRD's core deployment narrative:

1. **No CI**: there is no `.github/workflows/` directory. Every REQ to date has been verified by the author locally and merged without an external green check. As surface area grows (REQ-GH-3 substrate, upcoming auth, connectors), this scales poorly and risks silent regressions in code paths that depend on Postgres or pg-boss.
2. **No deployment artefact**: the README documents `npm install -g isdlc-knowledge-service` but the PRD targets "centrally hosted, team-lead administered" deployment. There is no Dockerfile, no compose file, no published image. Operators cannot stand the service up without hand-rolling their own packaging and Postgres provisioning.

This REQ addresses both as one cross-cutting foundation piece, since the CI pipeline naturally produces and verifies the container image and the compose file is what CI uses to spin up Postgres for the integration suite.

## Scope

### In scope

- **GitHub Actions workflow** at `.github/workflows/ci.yml` triggered on PR and push to `main`:
  - `lint` job: `npm ci && npm run lint`.
  - `test-unit` job: `npm run test:unit` on Node 22.12.
  - `test-integration` job: spins up Postgres 16 as a service container, exports `KNOWLEDGE_DATABASE_URL`, runs `npm run test:integration`.
  - `test-e2e` job: same Postgres service, runs `npm run test:e2e`. Skip-with-reason behavior continues to be valid; this job verifies the suite executes (does not silently skip everything).
  - `build-image` job (on `main` only): builds the Docker image and runs a smoke `docker run` against it.
- **Dockerfile** at the repo root:
  - Multi-stage build on `node:22.12-bookworm-slim`.
  - Production dependencies only in the final stage; non-root user; `EXPOSE` for API and metrics ports.
  - Entry point invokes `bin/cli.js start`. Reads config from a mounted `/etc/ks/config.json` (override via env) and `KNOWLEDGE_DATABASE_URL` from environment.
  - HEALTHCHECK that hits `GET /api/system/health`.
- **`docker-compose.yml`** at the repo root for local development and for CI's integration job:
  - `postgres` service (Postgres 16, named volume).
  - `knowledge` service (this image), depending on Postgres readiness; environment wires `KNOWLEDGE_DATABASE_URL`.
  - Default config mounts `.ks/config.json` from the host.
- **Docs**: README "Centralised hosting" section showing the compose flow, image build, and the env-var contract; `docs/operations/` (new) with a one-page deployment guide covering image build, Postgres provisioning, secrets handling.
- **Image publishing**: post-merge job pushes the image to GitHub Container Registry tagged `latest` and `sha-<short>`. No semver tags until a release flow is added.

### Out of scope

- Kubernetes manifests / Helm chart — file as a follow-up REQ once the image proves stable in compose.
- Multi-arch builds (arm64) — `linux/amd64` only for v1.
- Release/version tagging workflow — covered by a separate release-management REQ.
- Production-grade Postgres operator concerns (HA, backup, point-in-time recovery) — operator responsibility; this REQ documents the connection contract only.
- Secrets management beyond environment variables — REQ-API-AUTH and a future secrets REQ cover persistent credential storage.

## Acceptance signals

- Opening a PR triggers the workflow; lint, unit, integration, and e2e jobs each report status; the integration and e2e jobs run against a live Postgres service container.
- A PR that breaks any unit, integration, or e2e test fails CI and blocks merge (branch protection update is operator-configured but the failing status is produced).
- `docker compose up` from a freshly cloned checkout brings Postgres and the service to a healthy state (`/api/system/health` returns 200) without manual intervention beyond `cp .ks/config.example.json .ks/config.json`.
- `docker run --rm <image> --version` exits 0 and prints the package version.
- After a merge to `main`, an image is published to GHCR tagged with the commit SHA and `latest`.
- The README "Centralised hosting" section walks through the compose flow end to end and references the operations doc for production guidance.

## Open questions

1. Image base — `node:22.12-bookworm-slim` vs `node:22.12-alpine`. Recommendation: `bookworm-slim` (better ONNX Runtime compatibility for local-model paths).
2. Should the integration job use the docker-compose stack or the GitHub Actions native `services:` block? Recommendation: native `services:` block — faster, matches how upstream `pg-boss` tests run.
3. Do we need a single combined image or a separate worker image? Recommendation: single image; entry point chooses API vs worker via CLI subcommand. Keeps deployment topology aligned with ADR-001 without doubling registry assets.

## References

- PRD §4.1, §10 — centralised hosting narrative this REQ delivers on.
- Architecture: ADR-001 (API/Worker split — both processes share the image).
- Constitution: `docs/isdlc/constitution.md` Article on cross-platform support — Linux container production target satisfies the cross-platform NFR.
- Test scripts: `package.json` — `test:unit`, `test:integration`, `test:e2e` are the existing CI inputs.
