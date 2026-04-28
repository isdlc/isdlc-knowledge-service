// REQ-GH-3 / FR-004 — public entry point for the state layer.

export {
  createPostgresStateStore,
  StateConflictError,
} from './postgres-state-store.js';
