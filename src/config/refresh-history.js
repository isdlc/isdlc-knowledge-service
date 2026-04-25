// Module 11: Config Store — Refresh History (T003 / FR-001, FR-007 AC-007-05)
// Storage: JSON file at {dataDir}/projects/{id}/refresh-history.json
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 11
// Shape:  docs/requirements/REQ-GH-263-.../interface-spec.md §RefreshRecord

import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InvalidProjectError } from './project-store.js';

const DEFAULT_DATA_DIR = './data';
const PROJECTS_SUBDIR = 'projects';
const HISTORY_FILENAME = 'refresh-history.json';
const CONFIG_FILENAME = 'config.json';
const MAX_HISTORY_ENTRIES = 100;

/**
 * @typedef {object} RefreshRecord
 * @property {string} timestamp ISO-8601
 * @property {"full"|"incremental"} type
 * @property {string} trigger_source e.g. "github-actions" | "jenkins" | "web-ui"
 * @property {number} duration_seconds
 * @property {number} documents_processed
 * @property {"success"|"failed"} status
 * @property {string|null} error
 */

function projectDir(dataDir, id) {
  return join(dataDir, PROJECTS_SUBDIR, id);
}

function historyPath(dataDir, id) {
  return join(projectDir(dataDir, id), HISTORY_FILENAME);
}

function configPath(dataDir, id) {
  return join(projectDir(dataDir, id), CONFIG_FILENAME);
}

async function atomicWriteFile(path, contents) {
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, contents, 'utf8');
  await rename(tmpPath, path);
}

async function ensureProjectExists(dataDir, id) {
  if (!id || typeof id !== 'string') {
    throw new InvalidProjectError('Project id is required');
  }
  try {
    await stat(configPath(dataDir, id));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new InvalidProjectError(`Project not found: ${id}`);
    }
    throw err;
  }
}

/**
 * Read raw history array from disk; returns [] when the file is absent.
 *
 * @param {string} dataDir
 * @param {string} id
 * @returns {Promise<RefreshRecord[]>}
 */
async function readHistory(dataDir, id) {
  try {
    const raw = await readFile(historyPath(dataDir, id), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Create a refresh-history store bound to a specific dataDir. Mirrors
 * createProjectStore so the same dataDir can be passed to both factories.
 *
 * @param {{ dataDir?: string }} [options]
 */
export function createRefreshHistoryStore(options = {}) {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;

  /**
   * Append a refresh record at index 0 (latest first) and persist.
   * Caps total history at 100 entries per project.
   *
   * @param {string} id
   * @param {RefreshRecord} record
   * @returns {Promise<void>}
   */
  async function addRefreshRecord(id, record) {
    await ensureProjectExists(dataDir, id);
    if (!record || typeof record !== 'object') {
      throw new InvalidProjectError('Refresh record is required');
    }
    const history = await readHistory(dataDir, id);
    const updated = [record, ...history].slice(0, MAX_HISTORY_ENTRIES);
    await atomicWriteFile(historyPath(dataDir, id), JSON.stringify(updated, null, 2));
  }

  /**
   * @param {string} id
   * @returns {Promise<RefreshRecord[]>}
   */
  async function getRefreshHistory(id) {
    await ensureProjectExists(dataDir, id);
    return readHistory(dataDir, id);
  }

  return {
    dataDir,
    addRefreshRecord,
    getRefreshHistory,
    MAX_HISTORY_ENTRIES,
  };
}

export { MAX_HISTORY_ENTRIES };
