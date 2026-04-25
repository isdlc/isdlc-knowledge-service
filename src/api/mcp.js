// T021: MCP Server adapter — registers the four MCP tools on an
// `@modelcontextprotocol/sdk` McpServer and connects it to a transport.
// Traces: FR-008 (AC-008-01..04)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 1
//      docs/requirements/REQ-GH-263-.../interface-spec.md  (MCP Tools)
//
// Architectural split (per T021 design): the actual handler logic lives in
// mcp-handlers.js as plain async functions (so the REST layer in T022 can
// reuse them). This file ONLY:
//   1. Builds the MCP server, declares each tool with its JSON Schema.
//   2. On invocation: calls the matching handler, formats the response per
//      MCP `CallToolResult`.
//   3. Translates McpError → MCP-level isError result with the code in text.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  semanticSearch,
  addContent,
  listProjects,
  listModules,
  McpError,
} from './mcp-handlers.js';

const SERVER_INFO = {
  name: 'isdlc-knowledge-service',
  version: '0.1.0-alpha',
};

/**
 * Format an MCP CallToolResult from a successful handler return value.
 * Per the MCP spec, tool results are returned as a `content` array. We emit
 * a single text block carrying JSON; clients that prefer structured output
 * can parse it. The structured representation also lands in `structuredContent`
 * for SDK clients that surface it.
 *
 * @param {unknown} value
 */
function ok(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value && typeof value === 'object' ? value : { value },
  };
}

/**
 * Format an MCP CallToolResult from a thrown error.
 * McpError → isError + JSON envelope carrying { error: { code, message } }.
 * Anything else → INTERNAL.
 *
 * @param {unknown} err
 */
function fail(err) {
  let code = 'INTERNAL';
  let message = 'Internal error';
  if (err instanceof McpError) {
    code = err.code;
    message = err.message;
  } else if (err && typeof err === 'object') {
    code = (err.code && String(err.code)) || code;
    message = (err.message && String(err.message)) || message;
  }
  const envelope = { error: { code, message } };
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    isError: true,
  };
}

/**
 * Wrap a handler so any thrown error becomes an MCP isError result.
 * (Per MCP semantics, a thrown exception inside a tool callback gets sent
 * back as an internal protocol error; we want named errors to flow as
 * structured tool results so clients can branch on `code`.)
 *
 * @template A
 * @param {(args: A, deps: object) => Promise<object>} handler
 * @param {object} deps
 */
function wrap(handler, deps) {
  return async (args) => {
    try {
      const value = await handler(args ?? {}, deps);
      return ok(value);
    } catch (err) {
      return fail(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Input schemas — Zod raw shapes per interface-spec.md §MCP Tools.
// The MCP SDK accepts a "raw shape" (Record<string, ZodType>) and wraps it in
// a z.object() internally; we mirror the spec via Zod constraints. Detailed
// validation (size limits, project existence) lives in the handlers — these
// schemas guarantee structural shape only.
// ---------------------------------------------------------------------------

const SEMANTIC_SEARCH_INPUT = {
  query: z.string().min(1).max(1024),
  projects: z.array(z.string().min(1)).min(1),
};

const ADD_CONTENT_INPUT = {
  content: z.union([
    z.string(),
    z.array(
      z.object({
        path: z.string().optional(),
        text: z.string(),
      }),
    ),
  ]),
  project: z.string().min(1),
};

const LIST_PROJECTS_INPUT = {};

const LIST_MODULES_INPUT = {
  project: z.string().min(1),
};

/**
 * Build an MCP server with the four tools registered against the given deps.
 * Returns the configured McpServer instance — caller is responsible for
 * connecting it to a transport (or pass `{ transport }` to auto-connect).
 *
 * `deps` contract:
 *   - queryEngine     (T020 src/query/index.js)
 *   - configStore     (T003 src/config/index.js)
 *   - queue           (T004 src/queue/queue.js)
 *   - modelAdapter    (T006/T007)
 *   - getVectorDb     (T009..T011)
 *
 * @param {object} deps
 * @returns {McpServer}
 */
export function createMcpServer(deps) {
  if (!deps) {
    throw new TypeError('createMcpServer: deps is required');
  }

  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
  });

  server.registerTool(
    'semantic_search',
    {
      description:
        'Search across one or more project knowledge indexes. Returns ranked, project-tagged results.',
      inputSchema: SEMANTIC_SEARCH_INPUT,
    },
    wrap(semanticSearch, deps),
  );

  server.registerTool(
    'add_content',
    {
      description:
        'Queue a chunk of content (string or array of {path,text}) for embedding into a project index.',
      inputSchema: ADD_CONTENT_INPUT,
    },
    wrap(addContent, deps),
  );

  server.registerTool(
    'list_projects',
    {
      description: 'List all projects available in the knowledge service.',
      inputSchema: LIST_PROJECTS_INPUT,
    },
    wrap(listProjects, deps),
  );

  server.registerTool(
    'list_modules',
    {
      description: 'List indexed sources for a given project.',
      inputSchema: LIST_MODULES_INPUT,
    },
    wrap(listModules, deps),
  );

  return server;
}

/**
 * Convenience entry point: build the server AND connect it to stdio.
 * Used by the CLI when launching the MCP endpoint as a child process for
 * `claude-code` / other MCP clients.
 *
 * @param {object} deps
 * @returns {Promise<McpServer>}
 */
export async function startMcpStdioServer(deps) {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

// Re-exports for testing convenience.
export { McpError };
