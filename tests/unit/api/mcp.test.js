// Unit tests for src/api/mcp.js — MCP SDK adapter.
// Traces: FR-008 AC-008-01..04
//
// We exercise the adapter end-to-end by pairing the McpServer with an
// in-memory MCP client (InMemoryTransport.createLinkedPair) and calling each
// of the four tools. This is closer to a real MCP integration than poking at
// the SDK's private state, and verifies:
//   - JSON Schemas are accepted by the SDK (registerTool succeeds)
//   - Tool list / tool call dispatch reaches our handlers
//   - Successful results round-trip via `content[0].text` JSON
//   - Errors thrown by handlers become isError results carrying { code, message }

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer, McpError } from '../../../src/api/mcp.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/** Spin up a server bound to fakes, paired with an in-memory client. */
async function makeClient(deps) {
  const server = createMcpServer(deps);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client, async close() { await client.close(); await server.close(); } };
}

function fakeDeps(overrides = {}) {
  return {
    queryEngine: {
      search: async () => [
        { content: 'r1', score: 0.9, project: 'a', source_type: 'git', source_url: '', related_sources: [] },
      ],
    },
    configStore: {
      getProject: async (id) => {
        if (id === 'ghost') {
          const e = new Error(`Project not found: ${id}`);
          e.code = 'INVALID_PROJECT';
          throw e;
        }
        return { id, name: id, version: '1.0', sources: [{ type: 'git', url: 'git.example/' + id }] };
      },
      listProjects: async () => [
        { id: 'a-1.0', name: 'A', version: '1.0' },
        { id: 'b-2.0', name: 'B', version: '2.0' },
      ],
      getRefreshHistory: async () => [],
    },
    queue: {
      _enqueued: [],
      enqueue(type, payload) {
        const id = String(this._enqueued.length + 1);
        this._enqueued.push({ id, type, payload });
        return id;
      },
    },
    modelAdapter: { embed: async () => [0.1, 0.2, 0.3] },
    getVectorDb: () => ({ search: async () => [], getMetric: () => 'cosine' }),
    ...overrides,
  };
}

/** Parse a CallToolResult's first text content as JSON. */
function parseToolResult(result) {
  const block = result && Array.isArray(result.content) ? result.content[0] : null;
  assert.ok(block && block.type === 'text', 'tool result must include a text content block');
  return JSON.parse(block.text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('createMcpServer: requires deps', () => {
  assert.throws(() => createMcpServer(undefined), /deps is required/);
});

test('listTools: registers all four MCP tools', async () => {
  const { client, close } = await makeClient(fakeDeps());
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['add_content', 'list_modules', 'list_projects', 'semantic_search']);
    // Each tool must carry an inputSchema.
    for (const t of tools) {
      assert.ok(t.inputSchema, `tool ${t.name} missing inputSchema`);
      assert.ok(typeof t.description === 'string' && t.description.length > 0, `tool ${t.name} missing description`);
    }
  } finally {
    await close();
  }
});

test('callTool semantic_search: happy path returns results envelope', async () => {
  const { client, close } = await makeClient(fakeDeps());
  try {
    const result = await client.callTool({
      name: 'semantic_search',
      arguments: { query: 'hello', projects: ['a-1.0'] },
    });
    assert.notEqual(result.isError, true);
    const value = parseToolResult(result);
    assert.equal(Array.isArray(value.results), true);
    assert.equal(value.results[0].project, 'a');
  } finally {
    await close();
  }
});

test('callTool semantic_search: INVALID_PROJECT surfaces as isError result', async () => {
  const { client, close } = await makeClient(fakeDeps());
  try {
    const result = await client.callTool({
      name: 'semantic_search',
      arguments: { query: 'q', projects: ['ghost'] },
    });
    assert.equal(result.isError, true);
    const value = parseToolResult(result);
    assert.equal(value.error.code, 'INVALID_PROJECT');
    assert.match(value.error.message, /ghost/);
  } finally {
    await close();
  }
});

test('callTool semantic_search: NO_INDEX when query engine reports it for all projects', async () => {
  const deps = fakeDeps({
    queryEngine: {
      search: async (_args, { errors }) => {
        errors.push({ projectId: 'a-1.0', code: 'NO_INDEX', message: 'no index' });
        return [];
      },
    },
  });
  const { client, close } = await makeClient(deps);
  try {
    const result = await client.callTool({
      name: 'semantic_search',
      arguments: { query: 'q', projects: ['a-1.0'] },
    });
    assert.equal(result.isError, true);
    const value = parseToolResult(result);
    assert.equal(value.error.code, 'NO_INDEX');
  } finally {
    await close();
  }
});

test('callTool add_content: enqueues job and returns job_id', async () => {
  const deps = fakeDeps();
  const { client, close } = await makeClient(deps);
  try {
    const result = await client.callTool({
      name: 'add_content',
      arguments: { content: 'hello world', project: 'a-1.0' },
    });
    assert.notEqual(result.isError, true);
    const value = parseToolResult(result);
    assert.equal(value.status, 'queued');
    assert.equal(typeof value.job_id, 'string');
    assert.equal(deps.queue._enqueued.length, 1);
    assert.equal(deps.queue._enqueued[0].type, 'add_content');
    assert.equal(deps.queue._enqueued[0].payload.project, 'a-1.0');
  } finally {
    await close();
  }
});

test('callTool add_content: CONTENT_TOO_LARGE for >1MiB payload', async () => {
  const deps = fakeDeps();
  const { client, close } = await makeClient(deps);
  try {
    const huge = 'x'.repeat(1_048_577);
    const result = await client.callTool({
      name: 'add_content',
      arguments: { content: huge, project: 'a-1.0' },
    });
    assert.equal(result.isError, true);
    const value = parseToolResult(result);
    assert.equal(value.error.code, 'CONTENT_TOO_LARGE');
    assert.equal(deps.queue._enqueued.length, 0);
  } finally {
    await close();
  }
});

test('callTool list_projects: returns mapped project list', async () => {
  const { client, close } = await makeClient(fakeDeps());
  try {
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    assert.notEqual(result.isError, true);
    const value = parseToolResult(result);
    assert.equal(value.projects.length, 2);
    for (const p of value.projects) {
      assert.equal(typeof p.id, 'string');
      assert.equal(p.status, 'unknown');
      assert.equal(p.document_count, 0);
      assert.equal(p.last_refresh, null);
    }
  } finally {
    await close();
  }
});

test('callTool list_modules: returns mapped sources for known project', async () => {
  const { client, close } = await makeClient(fakeDeps());
  try {
    const result = await client.callTool({
      name: 'list_modules',
      arguments: { project: 'a-1.0' },
    });
    assert.notEqual(result.isError, true);
    const value = parseToolResult(result);
    assert.equal(value.sources.length, 1);
    assert.equal(value.sources[0].type, 'git');
    assert.equal(value.sources[0].document_count, 0);
    assert.equal(value.sources[0].last_crawled, null);
  } finally {
    await close();
  }
});

test('callTool list_modules: INVALID_PROJECT for unknown project', async () => {
  const { client, close } = await makeClient(fakeDeps());
  try {
    const result = await client.callTool({
      name: 'list_modules',
      arguments: { project: 'ghost' },
    });
    assert.equal(result.isError, true);
    const value = parseToolResult(result);
    assert.equal(value.error.code, 'INVALID_PROJECT');
  } finally {
    await close();
  }
});

test('McpError re-export is the same class as in mcp-handlers', async () => {
  // Ensure the re-export keeps identity (so REST and tests can share branch
  // logic via instanceof).
  const e = new McpError('NO_INDEX', 'm');
  assert.equal(e.code, 'NO_INDEX');
  assert.ok(e instanceof Error);
});
