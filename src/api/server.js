// T023: API Server — HTTP binding, route registration, static file serving.
// Traces: FR-007 (AC-007-01)
// See: docs/requirements/REQ-GH-263-.../requirements-spec.md FR-007
//      docs/requirements/REQ-GH-263-.../module-design.md §Module 1
//      docs/requirements/REQ-GH-263-.../draft.md (remote MCP via /mcp HTTP endpoint)
//
// Responsibilities:
//   1. Bind a Node http.Server to host/port.
//   2. Dispatch each request to one of three sub-handlers based on URL/method:
//        - REST: pathname starts with /api/ OR equals /metrics
//        - MCP-over-HTTP: pathname === '/mcp' AND method === 'POST'
//        - Static: GET (or HEAD) for everything else, served from `staticRoot`
//   3. Add CORS headers (origin allow-list configurable; defaults permit
//      localhost:* for local dev) and short-circuit OPTIONS preflight with 204.
//   4. Provide a graceful close() and address() on the returned handle so
//      callers (CLI, tests) can shut the server down deterministically.
//
// Why no Express/Fastify?
//   The REST dispatcher (rest.js, T022) and MCP handlers (mcp-handlers.js, T021)
//   are already framework-free. Adding Express here would only add dependencies
//   and a layer of indirection. Node's `http` is a perfect fit.
//
// MCP-over-HTTP shape:
//   We accept the standard JSON-RPC 2.0 envelope used by MCP clients:
//
//     POST /mcp
//     { "jsonrpc": "2.0", "id": <int|string>, "method": "tools/call",
//       "params": { "name": "<tool>", "arguments": {...} } }
//
//   The `name` field selects the handler from mcp-handlers.js. Successful
//   handler returns are wrapped in `result: { content, structuredContent }`
//   to mirror the MCP CallToolResult shape (so this transport is interchangeable
//   with the stdio transport from mcp.js). Handler-thrown McpErrors become
//   `result: { isError: true, content }` — also matching mcp.js semantics —
//   so that tool-level error semantics survive the HTTP hop.
//
//   Protocol-level errors (unknown method, bad JSON-RPC envelope) are returned
//   as the JSON-RPC `error` field (negative integer code) per spec.

import { createServer as createHttpServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createRestHandler } from './rest.js';
import {
  semanticSearch,
  addContent,
  listProjects,
  listModules,
  McpError,
} from './mcp-handlers.js';

// Standard JSON-RPC error codes (per https://www.jsonrpc.org/specification §5.1).
const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
// const JSONRPC_INVALID_PARAMS = -32602; // reserved — we surface tool-level errors as isError instead
const JSONRPC_INTERNAL_ERROR = -32603;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_STATIC_ROOT = path.resolve(process.cwd(), 'ui');
const DEFAULT_ALLOWED_ORIGIN_PATTERNS = [
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

const MCP_TOOL_REGISTRY = {
  semantic_search: semanticSearch,
  add_content: addContent,
  list_projects: listProjects,
  list_modules: listModules,
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Start an HTTP server bound to the given host:port that dispatches REST,
 * MCP-over-HTTP, and static-file requests.
 *
 * @param {object}  arg
 * @param {number}  arg.port      — port to listen on; pass 0 for ephemeral
 * @param {string} [arg.host]     — host/interface to bind; default 127.0.0.1
 * @param {object}  arg.deps      — shared dependency bag (see RouteDeps in rest.js + MCP handler deps)
 * @param {object} [arg.options]  — server-level options
 * @param {string} [arg.options.staticRoot]      — directory to serve static files from
 * @param {Array<string|RegExp>} [arg.options.allowedOrigins]
 *                                — additional CORS origin patterns; localhost variants are always allowed
 * @returns {Promise<{ close: () => Promise<void>, address: () => any }>}
 */
export async function startServer({ port, host = DEFAULT_HOST, deps, options = {} }) {
  if (port === undefined || port === null) {
    throw new TypeError('startServer: { port } is required');
  }
  if (!deps) {
    throw new TypeError('startServer: { deps } is required');
  }

  const staticRoot = path.resolve(options.staticRoot || DEFAULT_STATIC_ROOT);
  const allowedOrigins = compileAllowedOrigins(options.allowedOrigins);
  const restHandler = createRestHandler(deps);
  const requestHandler = makeRequestHandler({
    deps,
    staticRoot,
    allowedOrigins,
    restHandler,
  });

  const server = createHttpServer(requestHandler);

  // Bind listen + listen-error to a single Promise — whichever fires first
  // settles it. This is the canonical pattern for surfacing EADDRINUSE.
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  return {
    address: () => server.address(),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// ---------------------------------------------------------------------------
// Request handler — routes to REST / MCP / static.
// ---------------------------------------------------------------------------

function makeRequestHandler({ deps, staticRoot, allowedOrigins, restHandler }) {
  return async function requestHandler(req, res) {
    try {
      // Apply CORS to *every* response for any allowed origin.
      applyCors(req, res, allowedOrigins);

      // Preflight short-circuit.
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      // 1. REST dispatch — /api/** or /metrics
      if (url.pathname.startsWith('/api/') || url.pathname === '/metrics') {
        return restHandler(req, res);
      }

      // 2. MCP-over-HTTP — POST /mcp
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return writeJson(res, 405, { error: 'METHOD_NOT_ALLOWED', allowed: ['POST'] });
        }
        return handleMcp(req, res, deps);
      }

      // 3. Static file serving — GET / HEAD only
      if (req.method === 'GET' || req.method === 'HEAD') {
        return handleStatic(req, res, url, staticRoot);
      }

      // Anything else → 404.
      return writeJson(res, 404, { error: 'NOT_FOUND', message: `No handler for ${req.method} ${url.pathname}` });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[server] unhandled error:', err);
      if (!res.headersSent) {
        return writeJson(res, 500, { error: 'INTERNAL_ERROR', message: 'Internal server error' });
      }
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return undefined;
    }
  };
}

// ---------------------------------------------------------------------------
// MCP-over-HTTP handler
// ---------------------------------------------------------------------------

async function handleMcp(req, res, deps) {
  let envelope;
  try {
    envelope = await readJson(req);
  } catch (err) {
    const status = err.statusCode || 400;
    return writeJson(res, status, { error: 'INVALID_BODY', message: err.message });
  }
  if (!envelope || typeof envelope !== 'object') {
    return writeJsonRpcError(res, null, JSONRPC_INVALID_REQUEST, 'Request body must be a JSON-RPC envelope');
  }

  const { jsonrpc, id = null, method, params } = envelope;
  if (jsonrpc !== '2.0') {
    return writeJsonRpcError(res, id, JSONRPC_INVALID_REQUEST, 'jsonrpc must be "2.0"');
  }
  if (typeof method !== 'string') {
    return writeJsonRpcError(res, id, JSONRPC_INVALID_REQUEST, 'method must be a string');
  }

  // We only implement tools/call here — sufficient for what the MCP clients
  // we care about (Claude Code, local dashboards) need over the HTTP transport.
  // A full server.connect()-style protocol negotiation lives in mcp.js (stdio).
  if (method !== 'tools/call') {
    return writeJsonRpcError(res, id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  const toolName = params && params.name;
  const args = (params && params.arguments) || {};
  const handler = MCP_TOOL_REGISTRY[toolName];
  if (!handler) {
    return writeJsonRpcError(res, id, JSONRPC_METHOD_NOT_FOUND, `Unknown tool: ${toolName}`);
  }

  try {
    const value = await handler(args, deps);
    return writeJsonRpcResult(res, id, formatToolOk(value));
  } catch (err) {
    if (err instanceof McpError) {
      // Tool-level error → isError CallToolResult (NOT a JSON-RPC error).
      // Mirrors mcp.js so HTTP and stdio transports look identical to clients.
      return writeJsonRpcResult(res, id, formatToolError(err));
    }
    // Anything else is a true server fault.
    // eslint-disable-next-line no-console
    console.error('[server][mcp] tool handler threw:', err);
    return writeJsonRpcError(res, id, JSONRPC_INTERNAL_ERROR, err && err.message ? err.message : 'Internal error');
  }
}

function formatToolOk(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value && typeof value === 'object' ? value : { value },
  };
}

function formatToolError(err) {
  const envelope = { error: { code: err.code, message: err.message } };
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Static file handler
// ---------------------------------------------------------------------------

async function handleStatic(req, res, url, staticRoot) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return writeJson(res, 400, { error: 'BAD_PATH', message: 'Could not decode path' });
  }

  // Reject literal traversal segments BEFORE we touch the filesystem.
  // Splitting on both POSIX and Windows separators is paranoid but cheap.
  const segments = pathname.split(/[\\/]+/).filter(Boolean);
  if (segments.some((s) => s === '..' || s === '.')) {
    return writeJson(res, 400, { error: 'BAD_PATH', message: 'Path traversal detected' });
  }

  // Default to index.html for "/" or directory paths.
  let relPath = segments.length === 0 ? 'index.html' : segments.join('/');

  // Resolve the candidate against staticRoot and confirm it stays inside.
  const candidate = path.resolve(staticRoot, relPath);
  if (!isInside(candidate, staticRoot)) {
    return writeJson(res, 400, { error: 'BAD_PATH', message: 'Path escapes static root' });
  }

  let target = candidate;
  let stat;
  try {
    stat = await fs.stat(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return writeJson(res, 404, { error: 'NOT_FOUND', message: 'File not found' });
    }
    throw err;
  }

  // Directory → look for an index.html under it.
  if (stat.isDirectory()) {
    target = path.join(target, 'index.html');
    if (!isInside(target, staticRoot)) {
      return writeJson(res, 400, { error: 'BAD_PATH', message: 'Path escapes static root' });
    }
    try {
      stat = await fs.stat(target);
    } catch {
      return writeJson(res, 404, { error: 'NOT_FOUND', message: 'File not found' });
    }
  }

  if (!stat.isFile()) {
    return writeJson(res, 404, { error: 'NOT_FOUND', message: 'Not a regular file' });
  }

  const ext = path.extname(target).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
    });
    return res.end();
  }

  const data = await fs.readFile(target);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': data.length,
  });
  return res.end(data);
}

function isInside(candidate, root) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(resolvedRoot + path.sep)
  );
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function compileAllowedOrigins(extra) {
  const patterns = [...DEFAULT_ALLOWED_ORIGIN_PATTERNS];
  if (Array.isArray(extra)) {
    for (const e of extra) {
      if (e instanceof RegExp) {
        patterns.push(e);
      } else if (typeof e === 'string') {
        // Plain string — treat as exact match.
        patterns.push(new RegExp(`^${escapeRegex(e)}$`));
      }
    }
  }
  return patterns;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.some((re) => re.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] || 'Content-Type, Authorization',
    );
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

// ---------------------------------------------------------------------------
// Body parsing + response helpers
// ---------------------------------------------------------------------------

function readJson(req, maxBytes = 1024 * 1024) {
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
        return reject(err);
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

function writeJson(res, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function writeJsonRpcResult(res, id, result) {
  writeJson(res, 200, { jsonrpc: '2.0', id, result });
}

function writeJsonRpcError(res, id, code, message) {
  writeJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
}
