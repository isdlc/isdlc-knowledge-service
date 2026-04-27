// Module 11: Config Store — Project CRUD (T003 / FR-001)
// Storage: JSON files at {dataDir}/projects/{id}/config.json
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 11
// See: docs/requirements/REQ-GH-263-.../interface-spec.md §ProjectConfig
// See: docs/requirements/REQ-GH-263-.../error-taxonomy.md ERR-API-001

import { readFile, writeFile, mkdir, rm, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isCredentialReference } from '../credentials/resolver.js';
import { validateMetadataVocabularyConfig } from '../pipeline/metadata-vocabulary.js';

const DEFAULT_DATA_DIR = './data';
const PROJECTS_SUBDIR = 'projects';
const CONFIG_FILENAME = 'config.json';

/**
 * Error class for invalid-project conditions (ERR-API-001 INVALID_PROJECT).
 * Used for: not-found, duplicate creation, missing/invalid id, validation failures.
 */
export class InvalidProjectError extends Error {
  constructor(message, code = 'INVALID_PROJECT') {
    super(message);
    this.name = 'InvalidProjectError';
    this.code = code;
  }
}

/**
 * Reject bare-string credentials (Constitution V.5, VII.5, VII.6).
 * Credential fields are model_config.api_key, vectordb_config.api_key,
 * sources[].auth.password, sources[].auth.apiToken (or api_token alias).
 *
 * Throws InvalidProjectError with code "ERR-API-004" when a bare value is found.
 *
 * @param {object} config
 */
function assertCredentialsAreReferences(config) {
  const checks = [];

  if (config?.model_config && config.model_config.api_key !== undefined) {
    checks.push(['model_config.api_key', config.model_config.api_key]);
  }
  if (config?.vectordb_config && config.vectordb_config.api_key !== undefined) {
    checks.push(['vectordb_config.api_key', config.vectordb_config.api_key]);
  }
  if (Array.isArray(config?.sources)) {
    config.sources.forEach((src, idx) => {
      if (!src || typeof src !== 'object') return;
      const auth = src.auth;
      if (!auth || typeof auth !== 'object') return;
      if (auth.password !== undefined) {
        checks.push([`sources[${idx}].auth.password`, auth.password]);
      }
      if (auth.apiToken !== undefined) {
        checks.push([`sources[${idx}].auth.apiToken`, auth.apiToken]);
      }
      if (auth.api_token !== undefined) {
        checks.push([`sources[${idx}].auth.api_token`, auth.api_token]);
      }
    });
  }

  for (const [field, value] of checks) {
    if (!isCredentialReference(value)) {
      throw new InvalidProjectError(
        `${field} must be a secret reference (e.g. { env: "VAR_NAME" }), not a bare string. ` +
          'See Constitution Articles V.5, VII.5, VII.6.',
        'ERR-API-004'
      );
    }
  }
}

/**
 * Validate the project-level metadata vocabulary extension point. Built-in
 * GH#7 fields are always available; config may only add custom linked_* fields.
 *
 * @param {object} config
 */
function assertMetadataVocabularyIsValid(config) {
  const errors = validateMetadataVocabularyConfig(config);
  if (errors.length > 0) {
    throw new InvalidProjectError(errors.join('; '));
  }
}

/**
 * Derive a kebab-case project id from a name and version.
 * - Lowercases the name
 * - Replaces non-alphanumeric runs with '-'
 * - Strips leading/trailing '-'
 * - Joins with the version using '-' (version is preserved verbatim, dots intact)
 * Example: ("Payments", "2.7") -> "payments-2.7"
 *
 * @param {string} name
 * @param {string} version
 * @returns {string}
 */
export function slugifyProjectId(name, version) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new InvalidProjectError('Project name is required');
  }
  if (!version || typeof version !== 'string' || !version.trim()) {
    throw new InvalidProjectError('Project version is required');
  }
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new InvalidProjectError(`Project name "${name}" produces empty slug`);
  }
  return `${slug}-${version.trim()}`;
}

/**
 * Atomic write: write to a temp file then rename. POSIX-atomic; on Windows it
 * is atomic for same-volume same-name overwrites (which is our case).
 *
 * @param {string} path
 * @param {string} contents
 */
async function atomicWriteFile(path, contents) {
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, contents, 'utf8');
  await rename(tmpPath, path);
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
function projectsRoot(dataDir) {
  return join(dataDir, PROJECTS_SUBDIR);
}

/**
 * @param {string} dataDir
 * @param {string} id
 * @returns {string}
 */
function projectDir(dataDir, id) {
  return join(projectsRoot(dataDir), id);
}

/**
 * @param {string} dataDir
 * @param {string} id
 * @returns {string}
 */
function configPath(dataDir, id) {
  return join(projectDir(dataDir, id), CONFIG_FILENAME);
}

/**
 * @param {string} id
 */
function assertValidId(id) {
  if (!id || typeof id !== 'string') {
    throw new InvalidProjectError('Project id is required');
  }
}

/**
 * @typedef {object} ProjectConfig
 * @property {string} id
 * @property {string} name
 * @property {string} version
 * @property {string} [description]
 * @property {Array<object>} sources
 * @property {object} model_config
 * @property {object} vectordb_config
 * @property {import('../pipeline/metadata-vocabulary.js').MetadataVocabularyConfig} [metadata_vocabulary]
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * Read a single project config from disk. Returns null when absent / unreadable.
 *
 * @param {string} dataDir
 * @param {string} id
 * @returns {Promise<ProjectConfig | null>}
 */
async function readConfig(dataDir, id) {
  try {
    const raw = await readFile(configPath(dataDir, id), 'utf8');
    const parsed = JSON.parse(raw);
    assertMetadataVocabularyIsValid(parsed);
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Create a project store bound to a specific dataDir.
 *
 * The factory keeps state out of module scope so tests can use os.tmpdir()
 * isolation and the API server can wire a configured root at startup.
 *
 * @param {{ dataDir?: string }} [options]
 */
export function createProjectStore(options = {}) {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;

  /**
   * List all projects whose config.json is present under projects/.
   * Returns [] when the projects dir does not exist (fresh install).
   *
   * @returns {Promise<ProjectConfig[]>}
   */
  async function listProjects() {
    const root = projectsRoot(dataDir);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    /** @type {ProjectConfig[]} */
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cfg = await readConfig(dataDir, entry.name);
      if (cfg) out.push(cfg);
    }
    return out;
  }

  /**
   * @param {string} id
   * @returns {Promise<ProjectConfig>}
   */
  async function getProject(id) {
    assertValidId(id);
    const cfg = await readConfig(dataDir, id);
    if (!cfg) {
      throw new InvalidProjectError(`Project not found: ${id}`);
    }
    return cfg;
  }

  /**
   * @param {Omit<ProjectConfig, 'id'|'created_at'|'updated_at'>} config
   * @returns {Promise<ProjectConfig>}
   */
  async function createProject(config) {
    if (!config || typeof config !== 'object') {
      throw new InvalidProjectError('Project config is required');
    }
    assertCredentialsAreReferences(config);
    assertMetadataVocabularyIsValid(config);
    const id = slugifyProjectId(config.name, config.version);

    const exists = await readConfig(dataDir, id);
    if (exists) {
      throw new InvalidProjectError(`Project already exists: ${id}`);
    }

    const now = new Date().toISOString();
    /** @type {ProjectConfig} */
    const project = {
      id,
      name: config.name,
      version: config.version,
      description: config.description,
      sources: Array.isArray(config.sources) ? config.sources : [],
      model_config: config.model_config ?? {},
      vectordb_config: config.vectordb_config ?? {},
      ...(config.metadata_vocabulary !== undefined
        ? { metadata_vocabulary: config.metadata_vocabulary }
        : {}),
      created_at: now,
      updated_at: now,
    };

    await mkdir(projectDir(dataDir, id), { recursive: true });
    await atomicWriteFile(configPath(dataDir, id), JSON.stringify(project, null, 2));
    return project;
  }

  /**
   * @param {string} id
   * @param {Partial<ProjectConfig>} patch
   * @returns {Promise<ProjectConfig>}
   */
  async function updateProject(id, patch) {
    assertValidId(id);
    if (!patch || typeof patch !== 'object') {
      throw new InvalidProjectError('Update payload is required');
    }
    assertCredentialsAreReferences(patch);
    assertMetadataVocabularyIsValid(patch);
    const current = await readConfig(dataDir, id);
    if (!current) {
      throw new InvalidProjectError(`Project not found: ${id}`);
    }

    // Apply patch but never let the caller mutate id or created_at.
    /** @type {ProjectConfig} */
    const next = {
      ...current,
      ...patch,
      id: current.id,
      created_at: current.created_at,
      updated_at: new Date().toISOString(),
    };

    await atomicWriteFile(configPath(dataDir, id), JSON.stringify(next, null, 2));
    return next;
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function deleteProject(id) {
    assertValidId(id);
    // Confirm existence first so unknown ids fail fast with INVALID_PROJECT.
    try {
      await stat(configPath(dataDir, id));
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new InvalidProjectError(`Project not found: ${id}`);
      }
      throw err;
    }
    await rm(projectDir(dataDir, id), { recursive: true, force: true });
  }

  return {
    dataDir,
    listProjects,
    getProject,
    createProject,
    updateProject,
    deleteProject,
  };
}
