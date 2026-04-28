# isdlc-knowledge-service

Centralised knowledge management service — relationship-aware embedding, multi-project indexes, pluggable Vector DB and model backends, web UI admin, MCP interface.

## Requirements

- **Node.js** `>= 22.12.0` (required for `pg-boss` queue support — REQ-GH-3)
- **PostgreSQL** `>= 14` for runtime state (project config, refresh history, audit, queue) — see Postgres setup below
- A vector database (pluggable: sqlite-vec, OpenSearch, Pinecone, Qdrant, Milvus, Weaviate, ChromaDB, FAISS)

## Postgres setup

The service uses Postgres as the only runtime state substrate. There is no SQLite fallback, no auto-launched Docker — you provide Postgres and point the service at it.

### Local development quick start

```bash
# Option A: Homebrew (macOS)
brew install postgresql@16
brew services start postgresql@16
createdb isdlc_knowledge

# Option B: Existing Postgres / Docker / managed service
# Provide a connection URL via environment variable
export KNOWLEDGE_DATABASE_URL=postgres://user:password@host:5432/isdlc_knowledge
```

After the database is reachable:

```bash
isdlc-knowledge setup    # writes .ks/config.json with database.urlEnv reference
isdlc-knowledge start    # validates DB connectivity, runs migrations, starts API + worker
```

### Production

Provide externally managed Postgres (RDS, Aurora, Cloud SQL, self-hosted) reachable from the service host. Set `KNOWLEDGE_DATABASE_URL` in the service environment. Setup writes only the non-secret config to `.ks/config.json`; the credential reference (`database.urlEnv`) points at the env var.

## Tests

```bash
npm run test:unit          # unit tests (no DB required)
npm run test:integration   # integration tests (DB-dependent suites skip cleanly when KNOWLEDGE_DATABASE_URL is unset)
npm run test:e2e           # E2E tests (DB-dependent suites skip cleanly when KNOWLEDGE_DATABASE_URL is unset)
```

DB-dependent test suites use `tests/helpers/postgres.js` and skip with an explicit reason when `KNOWLEDGE_DATABASE_URL` is unset, so a freshly cloned checkout can run the test suite without provisioning Postgres first.
