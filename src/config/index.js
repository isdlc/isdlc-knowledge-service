// Module 11: Config Store — public entry point (T003 / FR-001)
// Responsibility: Project config CRUD and refresh history.
// Storage: JSON files at {dataDir}/projects/{id}/config.json and refresh-history.json
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 11
//
// This module exposes two surfaces:
//   1. createConfigStore({ dataDir }) — factory returning an isolated store
//      (preferred for tests and for the API server which configures dataDir
//      at startup).
//   2. The standalone async functions listed in module-design.md, backed by
//      a lazily-constructed default singleton at ./data. These are the
//      module-design "Interface" methods used by callers that have not yet
//      adopted dependency injection.

import { createProjectStore, InvalidProjectError, slugifyProjectId } from './project-store.js';
import { createRefreshHistoryStore, MAX_HISTORY_ENTRIES } from './refresh-history.js';

/**
 * Compose the project + refresh-history stores into one config store.
 *
 * @param {{
 *   dataDir?: string,
 *   deploymentVocabulary?: import('../pipeline/metadata-vocabulary.js').MetadataVocabularyConfig | null,
 * }} [options]
 *   `deploymentVocabulary` is forwarded to the project store and used to reject
 *   project-level custom_link_fields that overlap with the deployment baseline.
 */
export function createConfigStore(options = {}) {
  const projects = createProjectStore(options);
  const history = createRefreshHistoryStore(options);
  return {
    dataDir: projects.dataDir,
    // Project CRUD
    listProjects: projects.listProjects,
    getProject: projects.getProject,
    createProject: projects.createProject,
    updateProject: projects.updateProject,
    deleteProject: projects.deleteProject,
    // Refresh history
    addRefreshRecord: history.addRefreshRecord,
    getRefreshHistory: history.getRefreshHistory,
  };
}

// ---------------------------------------------------------------------------
// Default singleton (backwards-compatible standalone exports)
// ---------------------------------------------------------------------------

let defaultStore;
function getDefaultStore() {
  if (!defaultStore) {
    defaultStore = createConfigStore();
  }
  return defaultStore;
}

/** @returns {Promise<import('./project-store.js').ProjectConfig[]>} */
export async function listProjects() {
  return getDefaultStore().listProjects();
}

/** @param {string} id */
export async function getProject(id) {
  return getDefaultStore().getProject(id);
}

/** @param {Omit<import('./project-store.js').ProjectConfig, 'id'|'created_at'|'updated_at'>} config */
export async function createProject(config) {
  return getDefaultStore().createProject(config);
}

/** @param {string} id @param {Partial<import('./project-store.js').ProjectConfig>} config */
export async function updateProject(id, config) {
  return getDefaultStore().updateProject(id, config);
}

/** @param {string} id */
export async function deleteProject(id) {
  return getDefaultStore().deleteProject(id);
}

/** @param {string} id @param {import('./refresh-history.js').RefreshRecord} record */
export async function addRefreshRecord(id, record) {
  return getDefaultStore().addRefreshRecord(id, record);
}

/** @param {string} id @returns {Promise<import('./refresh-history.js').RefreshRecord[]>} */
export async function getRefreshHistory(id) {
  return getDefaultStore().getRefreshHistory(id);
}

// Re-export factory pieces and helpers for callers that need them.
export {
  createProjectStore,
  createRefreshHistoryStore,
  InvalidProjectError,
  slugifyProjectId,
  MAX_HISTORY_ENTRIES,
};
