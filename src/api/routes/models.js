// T022: REST API — Model management.
// Traces: FR-011 (AC-011-01..05), FR-014 (audit log)
// See: docs/requirements/REQ-GH-263-.../interface-spec.md GET /api/models, POST/DELETE /api/models/:name/pin
//
// Endpoints:
//   GET    /api/models                  -> { models: [...] }
//   POST   /api/models/:name/pin        -> { pinned: true }   (404, 400 cloud-cannot-pin)
//   DELETE /api/models/:name/pin        -> { pinned: false }  (404)
//
// Model listing combines:
//   - LIVE models from modelManager.getStatus()  (loaded local + pinned local intent)
//   - KNOWN cloud models from project model_configs (cloud adapters bypass the manager)
//
// Cloud-vs-local pin check uses the modelManager when possible. When the requested
// model is unknown to the manager and is referenced by a project as a cloud model,
// we return 400 (cannot pin). Unknown to both -> 404.

import { getClientIp } from '../rest.js';

/**
 * Build the list of "known" models combining manager.getStatus() + project model_configs.
 *
 * @param {object} deps
 * @returns {Promise<{ list: Array<object>, cloudNames: Set<string>, localNames: Set<string> }>}
 */
async function knownModels(deps) {
  const local = deps.modelManager?.getStatus ? deps.modelManager.getStatus() : [];
  const projects = (await deps.configStore.listProjects?.()) ?? [];
  const cloudNames = new Set();
  const localNames = new Set(local.map((m) => m.name));

  // Cloud models declared in project configs.
  /** @type {Map<string, object>} */
  const cloudByName = new Map();
  for (const project of projects) {
    const mc = project.model_config || {};
    const isCloud = (mc.source === 'cloud' || mc.type === 'cloud');
    const name = mc.model_name || mc.name;
    if (isCloud && name && !cloudByName.has(name)) {
      cloudByName.set(name, {
        name,
        type: 'cloud',
        loaded: true, // cloud APIs are always reachable from the model manager's perspective
        pinned: false,
        provider: mc.provider,
        dimensions: mc.dimensions ?? null,
      });
      cloudNames.add(name);
    }
  }

  const localList = local.map((m) => ({
    name: m.name,
    type: 'local',
    loaded: m.loaded,
    pinned: m.pinned,
    memory_mb: m.memory_mb,
    dimensions: m.dimensions ?? null,
  }));

  return {
    list: [...localList, ...cloudByName.values()],
    cloudNames,
    localNames,
  };
}

/**
 * Resolve a model name to its category for the pin handler.
 *  - 'local'   — manager knows about it (loaded or pinned-but-unloaded)
 *  - 'cloud'   — declared by some project as a cloud model
 *  - 'unknown' — neither
 *
 * @param {object} deps
 * @param {string} name
 * @returns {Promise<'local'|'cloud'|'unknown'>}
 */
async function resolveModelType(deps, name) {
  const manager = deps.modelManager;
  if (manager?.getStatus) {
    const known = manager.getStatus().some((m) => m.name === name);
    if (known) return 'local';
  }
  const projects = (await deps.configStore.listProjects?.()) ?? [];
  for (const project of projects) {
    const mc = project.model_config || {};
    const isCloud = (mc.source === 'cloud' || mc.type === 'cloud');
    if (isCloud && (mc.model_name === name || mc.name === name)) return 'cloud';
  }
  return 'unknown';
}

/**
 * @param {import('../rest.js').RouteDeps} deps
 */
export function createModelRoutes(deps) {
  return [
    {
      method: 'GET',
      pattern: '/api/models',
      handle: async () => {
        const { list } = await knownModels(deps);
        return { status: 200, body: { models: list } };
      },
    },

    {
      method: 'POST',
      pattern: '/api/models/:name/pin',
      handle: async (req) => {
        const name = req.params.name;
        const type = await resolveModelType(deps, name);
        if (type === 'unknown') {
          return {
            status: 404,
            body: { error: 'MODEL_NOT_FOUND', message: `Model not found: ${name}` },
          };
        }
        if (type === 'cloud') {
          return {
            status: 400,
            body: {
              error: 'CLOUD_CANNOT_PIN',
              message: `Cloud model "${name}" cannot be pinned (no resident memory)`,
            },
          };
        }
        deps.modelManager.pin(name);
        await deps.auditLogger.log('model.pinned', {
          model_name: name,
          ip_address: getClientIp(req),
        });
        return { status: 200, body: { pinned: true } };
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/models/:name/pin',
      handle: async (req) => {
        const name = req.params.name;
        const type = await resolveModelType(deps, name);
        if (type === 'unknown') {
          return {
            status: 404,
            body: { error: 'MODEL_NOT_FOUND', message: `Model not found: ${name}` },
          };
        }
        if (type === 'cloud') {
          // Unpinning a cloud model is a no-op semantically, but we still 400 to
          // be symmetric with pin and surface the user's misunderstanding.
          return {
            status: 400,
            body: {
              error: 'CLOUD_CANNOT_PIN',
              message: `Cloud model "${name}" cannot be pinned/unpinned`,
            },
          };
        }
        deps.modelManager.unpin(name);
        await deps.auditLogger.log('model.unpinned', {
          model_name: name,
          ip_address: getClientIp(req),
        });
        return { status: 200, body: { pinned: false } };
      },
    },
  ];
}
