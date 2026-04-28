# API authentication for REST, MCP, and web UI

**Source**: TBD (file as GitHub issue, then rename folder to `REQ-GH-{n}-api-authentication`)
**Type**: REQ (Feature)
**Tier**: Standard (cross-cuts every API surface; new auth module; touches audit + setup; no architecture overhaul)

## Summary

Add token-based authentication and a minimal role model (`admin`, `reader`) to every external surface served by the service: REST API, MCP server, and the web UI admin dashboard. Tokens are issued and rotated via the CLI, persisted in the Postgres state store (REQ-GH-3 substrate), validated on every request, and propagated as the `actor` field on audit log entries. No anonymous access in the default configuration.

## Motivation

The PRD positions the service as **centrally hosted** and **team-lead administered** with developers consuming it over MCP. Today every surface is open:

- `src/api/server.js` accepts any inbound request without identity checks.
- The MCP server exposes `add_content`, `semantic_search`, `list_projects`, `list_modules` to anyone who can reach the socket.
- The web UI (project CRUD, source attach, rebuild trigger) is reachable from any browser on the network.
- The audit logger (FR-014, hardened by REQ-GH-3) has no caller identity to record — `actor` is structurally `null`.

This blocks every "centralised hosting" path in the PRD §4 user journeys, makes the GH-3 audit log half-useful, and is far cheaper to retrofit now (one auth module, one middleware) than after additional surfaces and connectors land. Access control between teams/projects (PRD §9) is still deferred — this REQ only delivers the *authentication and coarse role* layer underneath it.

## Scope

### In scope

- **Token store**: new table `ks.api_tokens` in the Postgres state schema (added by REQ-GH-3). Columns: `id`, `name`, `token_hash` (sha256), `role` (`admin` | `reader`), `created_at`, `last_used_at`, `revoked_at`. Plain tokens never persisted.
- **Auth module** (`src/auth/`): token verification, role check, and Express/MCP middleware. Single source of truth — REST routes, MCP transport, and UI endpoints all consume the same verifier.
- **REST middleware**: every route except `GET /api/system/health` and `GET /metrics` requires a valid token. `Authorization: Bearer <token>`. `reader` role permits `GET` + `POST /api/refresh`; `admin` permits everything.
- **MCP authentication**: bearer token required at MCP handshake. Reader-role tokens may call `semantic_search`, `list_projects`, `list_modules`; only admin (or a dedicated `ingest` role — see open question) may call `add_content`.
- **Web UI**: cookie-based session backed by an admin token; login page accepts an admin token, sets an HttpOnly cookie, and gates all admin pages.
- **CLI commands**:
  - `isdlc-knowledge token create --role <admin|reader> --name <label>` — prints token once, persists hash.
  - `isdlc-knowledge token list` — id, name, role, last used, revoked status.
  - `isdlc-knowledge token revoke <id>`.
- **Setup wizard**: `isdlc-knowledge setup` generates and prints an initial admin token, instructs the operator to record it. Re-running setup never re-prints; explicit `token create` required after initial bootstrap.
- **Audit propagation**: every audit row written by the API/MCP/web UI carries the resolved token id and role as the `actor` field. CLI-originated actions (worker, scheduled jobs) record a synthetic `actor: system:<source>`.
- **Rate-limiting hook (light)**: per-token request counter incremented on each authenticated call; surfaced in `/metrics` for downstream rate-limit policy decisions. Hard limits not enforced in this REQ.

### Out of scope

- OAuth / SSO / OIDC — deferred to a later REQ once a hosting topology demands it.
- Per-project ACLs / team boundaries — explicitly deferred per PRD §9.
- mTLS or transport-level auth — operator-level concern (TLS terminator in front of the service).
- Token expiry / TTL — v1 tokens are long-lived until revoked; rotation via CLI.
- UI flow for self-service token issuance — admins create tokens via CLI for v1.
- Browser-based developer login — developers authenticate by configuring an MCP token in their iSDLC config.

## Acceptance signals

- A request to any REST route (other than `/api/system/health`, `/metrics`) without a valid `Authorization` header returns `401` with a structured error code.
- A request with a `reader` token to `POST /api/projects` returns `403`; the same token to `POST /api/refresh` returns `200`.
- An MCP client without a token cannot complete the handshake; with a `reader` token it can call `semantic_search`; calling `add_content` returns an authorization error.
- The web UI admin page redirects to `/login` when no session cookie is present and admits the user when a valid admin token is supplied.
- After any authenticated mutation, the resulting `audit_entries` row carries the token id and role in `actor`; CLI-originated mutations carry `actor: system:cli`.
- `isdlc-knowledge token create` returns a token only once; the same token never appears in DB queries or logs (only its hash).
- `isdlc-knowledge setup` on a fresh deployment prints an initial admin token and documents it in setup output; running setup a second time does not regenerate or print it.
- All existing unit, integration, and e2e suites remain green; new tests cover token creation/verification, role enforcement on every surface, audit actor propagation, and middleware short-circuit on `/health` and `/metrics`.

## Open questions

1. Should `add_content` get its own `ingest` role, or does `admin` cover it for v1? (Recommendation: dedicated `ingest` role — keeps CI/CD push-paths from holding admin credentials.)
2. Should the initial admin token be derivable from setup input (so it survives operator loss) or strictly randomly generated? (Recommendation: random; loss → run `token create` from a host shell with DB access.)
3. Is HTTP basic auth needed for the `/metrics` endpoint when scraped from outside the cluster? (Recommendation: leave open; route stays public for v1, operator fronts with reverse proxy if needed.)

## References

- Architecture: `docs/architecture/architecture-overview.md` — adds Module 15 (Auth) to the module map.
- Substrate: `REQ-GH-3` — the `ks` schema, `audit_entries`, and DB roles this REQ extends.
- Audit logging: PRD §6 FR-014, ACs AC-014-01 .. AC-014-05.
- Constitution: `docs/isdlc/constitution.md` Articles V.5, VII.5, VII.6 (credential handling — token hashes only, no plaintext at rest).
