// T022: REST API — route registry / dispatcher.
// Traces: FR-004, FR-007, FR-011, FR-014, FR-015
// See: docs/requirements/REQ-GH-263-.../interface-spec.md §REST API
//      docs/requirements/REQ-GH-263-.../module-design.md §Module 1
//
// Design:
// - Pure-handler pattern: each route exports `handle(req, body, deps) -> { status, body, headers? }`.
//   Handlers are transport-agnostic — no req.write, no res.end, no http coupling.
// - The dispatcher (this file) handles the HTTP concerns:
//     * Parse the URL, method, path params
//     * Buffer + JSON-parse the request body
//     * Match the request against registered routes
//     * Call the handler, serialize the result, write to res
//     * Translate uncaught errors into a 500 envelope
//
// We deliberately use Node's built-in `http` module — no Express, no Koa, no Fastify.
// The route table is a small array of { method, pattern, handle } entries; pattern is a
// path string with `:name` placeholders, compiled to a RegExp at registration time.

import { createRefreshRoutes } from './routes/refresh.js';
import { createProjectRoutes } from './routes/projects.js';
import { createModelRoutes } from './routes/models.js';
import { createSystemRoutes } from './routes/system.js';

/**
 * @typedef {object} RouteDeps
 * @property {object} configStore  — createConfigStore() return value
 * @property {object} queue        — createQueue() return value
 * @property {object} modelManager — ModelManager instance
 * @property {object} auditLogger  — createAuditLogger() return value
 * @property {object} [vectordb]   — optional, for /api/system/health document counts
 * @property {() => object} [memoryUsage] — test seam: returns { used_mb, available_mb }
 * @property {() => string} [now]  — test seam: ISO-8601 timestamp factory
 */

/**
 * @typedef {object} RouteHandlerResult
 * @property {number} status
 * @property {*}      body
 * @property {object} [headers]
 */

/**
 * @typedef {object} Route
 * @property {string} method
 * @property {string} pattern
 * @property {RegExp} regex
 * @property {string[]} paramNames
 * @property {(req: object, body: any, deps: RouteDeps) => Promise<RouteHandlerResult> | RouteHandlerResult} handle
 */

/**
 * Compile a pattern like "/api/projects/:id/status" into a regex with named param positions.
 * Returns { regex, paramNames }. Trailing slash on the pattern or input is tolerated.
 *
 * @param {string} pattern
 * @returns {{ regex: RegExp, paramNames: string[] }}
 */
export function compilePattern(pattern) {
  const paramNames = [];
  // Escape regex specials EXCEPT the slashes we'll be matching as literals,
  // then replace `:name` with a capturing group.
  const escaped = pattern.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
  const regexSrc = escaped.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    paramNames.push(name);
    // Match a single path segment (no slashes).
    return '([^/]+)';
  });
  // Anchor and tolerate optional trailing slash.
  const regex = new RegExp(`^${regexSrc}/?$`);
  return { regex, paramNames };
}

/**
 * Build the full route table from the per-route factories.
 * Each factory takes deps and returns an array of { method, pattern, handle } entries.
 *
 * @param {RouteDeps} deps
 * @returns {Route[]}
 */
export function buildRoutes(deps) {
  const factories = [
    createRefreshRoutes,
    createProjectRoutes,
    createModelRoutes,
    createSystemRoutes,
  ];
  /** @type {Route[]} */
  const routes = [];
  for (const factory of factories) {
    const entries = factory(deps);
    for (const entry of entries) {
      const { regex, paramNames } = compilePattern(entry.pattern);
      routes.push({ ...entry, regex, paramNames });
    }
  }
  return routes;
}

/**
 * Match an incoming { method, pathname } against the route table.
 *
 * Returns:
 *   { match: 'route', route, params }     — exact method + path match
 *   { match: 'method-mismatch', allowed } — path matches at least one route, but no
 *                                           registered route accepts this method
 *   { match: 'none' }                     — no route matches the path at all
 *
 * The dispatcher uses 'method-mismatch' to emit 405 with an Allow header.
 *
 * @param {Route[]} routes
 * @param {string} method
 * @param {string} pathname
 */
export function matchRoute(routes, method, pathname) {
  /** @type {Set<string>} */
  const allowed = new Set();
  let hadPathMatch = false;
  for (const route of routes) {
    const m = route.regex.exec(pathname);
    if (!m) continue;
    hadPathMatch = true;
    allowed.add(route.method);
    if (route.method !== method) continue;
    /** @type {Record<string, string>} */
    const params = {};
    route.paramNames.forEach((name, idx) => {
      params[name] = decodeURIComponent(m[idx + 1]);
    });
    return { match: 'route', route, params };
  }
  if (hadPathMatch) {
    return { match: 'method-mismatch', allowed: [...allowed] };
  }
  return { match: 'none' };
}

/**
 * Read a request body to a string, capped at maxBytes. Resolves the parsed JSON
 * (or null if empty), or rejects with a typed error suitable for 400 mapping.
 *
 * @param {import('http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<any>}
 */
export function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        const err = new Error('Request body too large');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        const e = new Error('Invalid JSON body');
        e.statusCode = 400;
        e.cause = err;
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Build a request handler suitable for `http.createServer(handler)` from a deps bag.
 *
 * The handler:
 *   1. Parses the URL.
 *   2. Matches a route. If the path matches but method doesn't, replies 405 with Allow.
 *   3. Reads the JSON body for non-GET/DELETE methods. Replies 400 on parse failure.
 *   4. Decorates `req` with `params` (path) and `query` (URL search params as plain object).
 *   5. Awaits handler. Writes status + JSON body.
 *   6. Catches uncaught errors -> 500 envelope.
 *
 * @param {RouteDeps} deps
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void>}
 */
export function createRestHandler(deps) {
  const routes = buildRoutes(deps);

  return async function restHandler(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const match = matchRoute(routes, req.method, url.pathname);

      if (match.match === 'none') {
        return writeJson(res, 404, { error: 'NOT_FOUND', message: `No route for ${req.method} ${url.pathname}` });
      }

      if (match.match === 'method-mismatch') {
        res.setHeader('Allow', match.allowed.join(', '));
        return writeJson(res, 405, { error: 'METHOD_NOT_ALLOWED', allowed: match.allowed });
      }

      const { route, params } = match;

      // Body parsing — only for methods that conventionally carry a body.
      let body = null;
      if (req.method !== 'GET' && req.method !== 'DELETE' && req.method !== 'HEAD') {
        try {
          body = await readJsonBody(req);
        } catch (err) {
          const status = err.statusCode || 400;
          return writeJson(res, status, { error: 'INVALID_BODY', message: err.message });
        }
      }

      // Decorate req with parsed bits the handlers need.
      req.params = params;
      const query = {};
      for (const [k, v] of url.searchParams) query[k] = v;
      req.query = query;

      const result = await route.handle(req, body, deps);
      const status = (result && result.status) || 200;
      const headers = (result && result.headers) || {};
      const respBody = result ? result.body : undefined;
      return writeJson(res, status, respBody, headers);
    } catch (err) {
      // Last-resort 500. Do not leak stack traces to clients.
      const message = err && err.message ? err.message : 'Internal server error';
      // Eslint won't flag — `console` is the project's structured-log fallback during T022.
      // eslint-disable-next-line no-console
      console.error('[rest] unhandled error:', err);
      return writeJson(res, 500, { error: 'INTERNAL_ERROR', message });
    }
  };
}

/**
 * Serialize and write a JSON response. Handles undefined body (-> empty string).
 *
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {*} body
 * @param {object} [extraHeaders]
 */
export function writeJson(res, status, body, extraHeaders = {}) {
  const isText = typeof body === 'string' && extraHeaders['Content-Type']?.startsWith('text/');
  const payload = body === undefined ? '' : isText ? body : JSON.stringify(body);
  const headers = {
    'Content-Type': isText ? extraHeaders['Content-Type'] : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  };
  // If the caller passed an explicit Content-Type, preserve it.
  if (extraHeaders['Content-Type']) headers['Content-Type'] = extraHeaders['Content-Type'];
  res.writeHead(status, headers);
  res.end(payload);
}

/**
 * Helper for handlers: resolve the client's IP address for audit logging.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {string|undefined}
 */
export function getClientIp(req) {
  // Prefer X-Forwarded-For when present (proxy-aware), fall back to socket.
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.socket && req.socket.remoteAddress;
}
