-- REQ-GH-3 / FR-003 / AC-003-03 — initial Postgres state substrate.
--
-- Creates schema `ks`, the five state tables, and idempotently provisions
-- the three DB roles. All statements are CREATE … IF NOT EXISTS so the
-- migration is safe to re-run if interrupted.
--
-- Roles (FR-005 / AC-005-01..03):
--   ks_owner       — owns the schema; runs migrations and grants.
--   ks_app         — normal app-runtime: inserts/selects audit; CRUDs other
--                    state tables; CANNOT update/delete audit_entries.
--   ks_maintenance — retention/maintenance: can purge or archive audit rows.

CREATE SCHEMA IF NOT EXISTS ks;

-- Role bootstrap. Wrapped in DO blocks so existing roles aren't recreated.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ks_owner') THEN
    CREATE ROLE ks_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ks_app') THEN
    CREATE ROLE ks_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ks_maintenance') THEN
    CREATE ROLE ks_maintenance NOLOGIN;
  END IF;
END
$$;

-- ------------------------------------------------------------------------
-- ks.schema_migrations — applied service migration records
-- ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ks.schema_migrations (
  id            TEXT PRIMARY KEY,                  -- "001_state_substrate"
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum      TEXT,                              -- optional sha256 of the SQL file
  notes         TEXT
);

-- ------------------------------------------------------------------------
-- ks.projects — project config (replaces JSON files at runtime; per FR-002 /
-- AC-002-04, JSON files are import/export payloads only).
-- ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ks.projects (
  id                    TEXT PRIMARY KEY,            -- slug "payments-2.7"
  name                  TEXT NOT NULL,
  version               TEXT NOT NULL,
  description           TEXT,
  sources               JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  vectordb_config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_vocabulary   JSONB,                       -- REQ-GH-7 per-project layer
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON ks.projects (updated_at);

-- ------------------------------------------------------------------------
-- ks.refresh_history — full/incremental/add-content operational history
-- ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ks.refresh_history (
  id                    BIGSERIAL PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES ks.projects(id) ON DELETE CASCADE,
  ts                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  type                  TEXT NOT NULL,             -- 'full' | 'incremental' | 'add_content'
  trigger_source        TEXT,
  duration_seconds      INTEGER,
  documents_processed   INTEGER,
  status                TEXT NOT NULL,             -- 'success' | 'partial' | 'failure'
  error                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_history_project_ts
  ON ks.refresh_history (project_id, ts DESC);

-- ------------------------------------------------------------------------
-- ks.audit_entries — append-only audit log (FR-005). UPDATE/DELETE are
-- revoked from ks_app at the role level below.
-- ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ks.audit_entries (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  action        TEXT NOT NULL,
  project_id    TEXT,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address    INET,
  actor         TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_entries_ts ON ks.audit_entries (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entries_project ON ks.audit_entries (project_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entries_action ON ks.audit_entries (action, ts DESC);

-- ------------------------------------------------------------------------
-- ks.import_export_runs — config-as-code run history (FR-007).
-- ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ks.import_export_runs (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  direction     TEXT NOT NULL,                       -- 'export' | 'import'
  scope         TEXT NOT NULL,                       -- 'project' | 'all' | 'deployment'
  target_id     TEXT,                                -- project id when scope='project'
  status        TEXT NOT NULL,                       -- 'success' | 'partial' | 'failure'
  payload_size  BIGINT,
  manifest      JSONB NOT NULL DEFAULT '{}'::jsonb,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_import_export_runs_ts ON ks.import_export_runs (ts DESC);

-- ------------------------------------------------------------------------
-- Grants (FR-005 / AC-005-01..03)
-- ------------------------------------------------------------------------
GRANT USAGE ON SCHEMA ks TO ks_app, ks_maintenance;

-- ks_app: full DML on projects/refresh_history/import_export_runs;
--         INSERT + SELECT on audit_entries (no UPDATE/DELETE).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  ks.projects,
  ks.refresh_history,
  ks.import_export_runs
TO ks_app;
GRANT SELECT, INSERT ON ks.audit_entries TO ks_app;
GRANT USAGE, SELECT ON
  ks.refresh_history_id_seq,
  ks.audit_entries_id_seq,
  ks.import_export_runs_id_seq
TO ks_app;

-- ks_maintenance: full audit lifecycle for purge/archive operations.
GRANT SELECT, INSERT, UPDATE, DELETE ON ks.audit_entries TO ks_maintenance;
GRANT SELECT ON
  ks.projects,
  ks.refresh_history,
  ks.import_export_runs
TO ks_maintenance;

-- Schema migrations table is read-only for app/maintenance; ks_owner writes.
GRANT SELECT ON ks.schema_migrations TO ks_app, ks_maintenance;

-- Default privileges so future objects in `ks` follow the same pattern.
ALTER DEFAULT PRIVILEGES IN SCHEMA ks
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ks_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA ks
  GRANT USAGE, SELECT ON SEQUENCES TO ks_app;

-- Record this migration as applied. Re-runs are no-ops because of the
-- INSERT … ON CONFLICT below.
INSERT INTO ks.schema_migrations (id, notes)
VALUES ('001_state_substrate', 'REQ-GH-3 initial state substrate')
ON CONFLICT (id) DO NOTHING;
