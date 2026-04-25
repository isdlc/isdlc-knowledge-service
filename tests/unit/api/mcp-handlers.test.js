// Unit tests for src/api/mcp-handlers.js — pure handler functions.
// Traces: FR-008 AC-008-01..04
// Errors covered: ERR-API-001 (INVALID_PROJECT), ERR-API-002 (NO_INDEX),
//                 ERR-API-003 (CONTENT_TOO_LARGE), INVALID_INPUT.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  semanticSearch,
  addContent,
  listProjects,
  listModules,
  McpError,
  LIMITS,
} from '../../../src/api/mcp-handlers.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

class FakeInvalidProjectError extends Error {
  constructor(id) {
    super(`Project not found: ${id}`);
    this.name = 'InvalidProjectError';
    this.code = 'INVALID_PROJECT';
  }
}

function mockConfigStore({ projects = {}, history = {} } = {}) {
  return {
    getProject: async (id) => {
      if (!Object.prototype.hasOwnProperty.call(projects, id)) {
        throw new FakeInvalidProjectError(id);
      }
      return projects[id];
    },
    listProjects: async () => Object.values(projects),
    getRefreshHistory: async (id) => history[id] || [],
  };
}

function mockQueue() {
  let next = 1;
  const enqueued = [];
  return {
    enqueue: (type, payload) => {
      const id = String(next++);
      enqueued.push({ id, type, payload });
      return id;
    },
    enqueued,
  };
}

const mockModel = { embed: async () => [0.1, 0.2, 0.3] };
const mockGetVectorDb = (_id) => ({ search: async () => [], getMetric: () => 'cosine' });

// ---------------------------------------------------------------------------
// semanticSearch
// ---------------------------------------------------------------------------

test('semanticSearch: validates query is non-empty string', async () => {
  const deps = {
    queryEngine: { search: async () => [] },
    configStore: mockConfigStore({ projects: { a: { id: 'a' } } }),
    modelAdapter: mockModel,
    getVectorDb: mockGetVectorDb,
  };
  await assert.rejects(
    () => semanticSearch({ query: '', projects: ['a'] }, deps),
    (e) => e instanceof McpError && e.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => semanticSearch({ projects: ['a'] }, deps),
    (e) => e instanceof McpError && e.code === 'INVALID_INPUT',
  );
});

test('semanticSearch: rejects query above MAX_QUERY_LENGTH', async () => {
  const deps = {
    queryEngine: { search: async () => [] },
    configStore: mockConfigStore({ projects: { a: { id: 'a' } } }),
    modelAdapter: mockModel,
    getVectorDb: mockGetVectorDb,
  };
  const huge = 'x'.repeat(LIMITS.MAX_QUERY_LENGTH + 1);
  await assert.rejects(
    () => semanticSearch({ query: huge, projects: ['a'] }, deps),
    (e) => e instanceof McpError && e.code === 'INVALID_INPUT' && /maximum length/i.test(e.message),
  );
});

test('semanticSearch: rejects empty/non-array projects', async () => {
  const deps = {
    queryEngine: { search: async () => [] },
    configStore: mockConfigStore({ projects: { a: { id: 'a' } } }),
    modelAdapter: mockModel,
    getVectorDb: mockGetVectorDb,
  };
  await assert.rejects(
    () => semanticSearch({ query: 'q', projects: [] }, deps),
    (e) => e instanceof McpError && e.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => semanticSearch({ query: 'q', projects: 'a' }, deps),
    (e) => e instanceof McpError && e.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => semanticSearch({ query: 'q', projects: ['a', ''] }, deps),
    (e) => e instanceof McpError && e.code === 'INVALID_INPUT',
  );
});

test('semanticSearch: happy path returns results from queryEngine', async () => {
  let captured;
  const deps = {
    queryEngine: {
      search: async (args, depsArg) => {
        captured = { args, depsArg };
        return [
          { content: 'hit-1', score: 0.9, project: 'a', source_type: 'git', source_url: '', related_sources: [] },
        ];
      },
    },
    configStore: mockConfigStore({ projects: { a: { id: 'a' }, b: { id: 'b' } } }),
    modelAdapter: mockModel,
    getVectorDb: mockGetVectorDb,
  };

  const result = await semanticSearch({ query: 'hello', projects: ['a', 'b'] }, deps);
  assert.deepEqual(result, {
    results: [
      { content: 'hit-1', score: 0.9, project: 'a', source_type: 'git', source_url: '', related_sources: [] },
    ],
  });
  assert.deepEqual(captured.args, { query: 'hello', projects: ['a', 'b'] });
  assert.equal(typeof captured.depsArg.errors, 'object'); // collector array
  assert.equal(Array.isArray(captured.depsArg.errors), true);
});

test('semanticSearch: INVALID_PROJECT when one project unknown (pre-validation)', async () => {
  const deps = {
    queryEngine: { search: async () => [] },
    configStore: mockConfigStore({ projects: { a: { id: 'a' } } }),
    modelAdapter: mockModel,
    getVectorDb: mockGetVectorDb,
  };
  await assert.rejects(
    () => semanticSearch({ query: 'q', projects: ['a', 'ghost'] }, deps),
    (e) => e instanceof McpError && e.code === 'INVALID_PROJECT' && /ghost/.test(e.message),
  );
});

test('semanticSearch: NO_INDEX when all projects have no embeddings', async () => {
  const deps = {
    queryEngine: {
      search: async (_args, { errors }) => {
        // Simulate Query Engine collecting NO_INDEX errors for every project.
        errors.push({ projectId: 'a', code: 'NO_INDEX', message: 'no index' });
        errors.push({ projectId: 'b', code: 'NO_INDEX', message: 'no index' });
        return [];
      },
    },
    configStore: mockConfigStore({ projects: { a: { id: 'a' }, b: { id: 'b' } } }),
    modelAdapter: mockModel,
    getVectorDb: mockGetVectorDb,
  };
  await assert.rejects(
    () => semanticSearch({ query: 'q', projects: ['a', 'b'] }, deps),
    (e) => e instanceof McpError && e.code === 'NO_INDEX' && /a, b/.test(e.message),
  );
});

test('semanticSearch: mixed errors → empty results, throws first non-NO_INDEX code', async () => {
  const deps = {
    queryEngine: {
      search: async (_args, { errors }) => {
        errors.push({ projectId: 'a', code: 'INTERNAL', message: 'boom' });
        return [];
      },
    },
    configStore: mockConfigStore({ projects: { a: { id: 'a' } } }),
    modelAdapter: mockModel,
    getVectorDb: mockGetVectorDb,
  };
  await assert.rejects(
    () => semanticSearch({ query: 'q', projects: ['a'] }, deps),
    (e) => e instanceof McpError && e.code === 'INTERNAL',
  );
});

test('semanticSearch: partial failures still return what succeeded', async () => {
  const deps = {
    queryEngine: {
      search: async (_args, { errors }) => {
        errors.push({ projectId: 'b', code: 'NO_INDEX', message: 'no index' });
        return [{ content: 'from-a', score: 0.5, project: 'a', source_type: '', source_url: '', related_sources: [] }];
      },
    },
    configStore: mockConfigStore({ projects: { a: { id: 'a' }, b: { id: 'b' } } }),
    modelAdapter: mockModel,
    getVectorDb: mockGetVectorDb,
  };
  const result = await semanticSearch({ query: 'q', projects: ['a', 'b'] }, deps);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].project, 'a');
});

test('semanticSearch: requires deps.queryEngine and deps.configStore', async () => {
  await assert.rejects(
    () => semanticSearch({ query: 'q', projects: ['a'] }, {}),
    /queryEngine/i,
  );
});

// ---------------------------------------------------------------------------
// addContent
// ---------------------------------------------------------------------------

test('addContent: happy path enqueues add_content job and returns job_id', async () => {
  const queue = mockQueue();
  const deps = {
    configStore: mockConfigStore({ projects: { a: { id: 'a' } } }),
    queue,
  };
  const result = await addContent({ content: 'hello world', project: 'a' }, deps);
  assert.deepEqual(result, { job_id: '1', status: 'queued' });
  assert.equal(queue.enqueued.length, 1);
  assert.equal(queue.enqueued[0].type, 'add_content');
  assert.equal(queue.enqueued[0].payload.project, 'a');
  assert.equal(queue.enqueued[0].payload.content, 'hello world');
});

test('addContent: array form of content is accepted', async () => {
  const queue = mockQueue();
  const deps = {
    configStore: mockConfigStore({ projects: { a: { id: 'a' } } }),
    queue,
  };
  const content = [
    { path: 'a.md', text: 'alpha' },
    { path: 'b.md', text: 'beta' },
  ];
  const result = await addContent({ content, project: 'a' }, deps);
  assert.equal(result.status, 'queued');
  assert.deepEqual(queue.enqueued[0].payload.content, content);
});

test('addContent: rejects content above 1MiB (CONTENT_TOO_LARGE)', async () => {
  const queue = mockQueue();
  const deps = {
    configStore: mockConfigStore({ projects: { a: { id: 'a' } } }),
    queue,
  };
  const huge = 'x'.repeat(LIMITS.MAX_CONTENT_BYTES + 1);
  await assert.rejects(
    () => addContent({ content: huge, project: 'a' }, deps),
    (e) => e instanceof McpError && e.code === 'CONTENT_TOO_LARGE',
  );
  assert.equal(queue.enqueued.length, 0, 'must not enqueue oversized payload');
});

test('addContent: rejects array form whose total bytes exceed limit', async () => {
  const queue = mockQueue();
  const deps = {
    configStore: mockConfigStore({ projects: { a: { id: 'a' } } }),
    queue,
  };
  const half = 'x'.repeat(Math.floor(LIMITS.MAX_CONTENT_BYTES / 2) + 1);
  const content = [
    { path: '1.md', text: half },
    { path: '2.md', text: half },
  ];
  await assert.rejects(
    () => addContent({ content, project: 'a' }, deps),
    (e) => e instanceof McpError && e.code === 'CONTENT_TOO_LARGE',
  );
});

test('addContent: rejects unknown project (INVALID_PROJECT)', async () => {
  const queue = mockQueue();
  const deps = {
    configStore: mockConfigStore({ projects: {} }),
    queue,
  };
  await assert.rejects(
    () => addContent({ content: 'hi', project: 'ghost' }, deps),
    (e) => e instanceof McpError && e.code === 'INVALID_PROJECT',
  );
  assert.equal(queue.enqueued.length, 0);
});

test('addContent: validates input shapes', async () => {
  const queue = mockQueue();
  const deps = { configStore: mockConfigStore({ projects: { a: { id: 'a' } } }), queue };
  await assert.rejects(
    () => addContent({ content: 'hi', project: '' }, deps),
    (e) => e instanceof McpError && e.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => addContent({ content: 123, project: 'a' }, deps),
    (e) => e instanceof McpError && e.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => addContent({ content: [{ text: 1 }], project: 'a' }, deps),
    (e) => e instanceof McpError && e.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => addContent({ content: [null], project: 'a' }, deps),
    (e) => e instanceof McpError && e.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => addContent({ project: 'a' }, deps),
    (e) => e instanceof McpError && e.code === 'INVALID_INPUT',
  );
});

test('addContent: requires deps.configStore and deps.queue', async () => {
  await assert.rejects(
    () => addContent({ content: 'hi', project: 'a' }, {}),
    /configStore.*queue/i,
  );
});

// ---------------------------------------------------------------------------
// listProjects
// ---------------------------------------------------------------------------

test('listProjects: maps ProjectConfig list to MCP shape', async () => {
  const projects = {
    'a-1.0': { id: 'a-1.0', name: 'A', version: '1.0' },
    'b-2.0': { id: 'b-2.0', name: 'B', version: '2.0' },
  };
  const result = await listProjects({}, { configStore: mockConfigStore({ projects }) });
  assert.equal(result.projects.length, 2);
  for (const p of result.projects) {
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.name, 'string');
    assert.equal(typeof p.version, 'string');
    assert.equal(p.status, 'unknown'); // default — no history
    assert.equal(p.document_count, 0);
    assert.equal(p.last_refresh, null);
  }
});

test('listProjects: hydrates last_refresh + status from refresh-history', async () => {
  const projects = { 'a-1.0': { id: 'a-1.0', name: 'A', version: '1.0' } };
  const history = {
    'a-1.0': [{ timestamp: '2026-04-25T09:00:00Z', status: 'success' }],
  };
  const result = await listProjects({}, {
    configStore: mockConfigStore({ projects, history }),
  });
  assert.equal(result.projects[0].status, 'fresh');
  assert.equal(result.projects[0].last_refresh, '2026-04-25T09:00:00Z');
});

test('listProjects: returns [] when configStore has no projects', async () => {
  const result = await listProjects({}, { configStore: mockConfigStore({ projects: {} }) });
  assert.deepEqual(result, { projects: [] });
});

test('listProjects: requires deps.configStore', async () => {
  await assert.rejects(() => listProjects({}, {}), /configStore/);
});

// ---------------------------------------------------------------------------
// listModules
// ---------------------------------------------------------------------------

test('listModules: returns project sources mapped to MCP shape', async () => {
  const sources = [
    { type: 'git', url: 'git.example.com/repo' },
    { type: 'confluence', url: 'wiki.example.com/space' },
  ];
  const projects = { 'a-1.0': { id: 'a-1.0', name: 'A', version: '1.0', sources } };
  const result = await listModules({ project: 'a-1.0' }, {
    configStore: mockConfigStore({ projects }),
  });
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].type, 'git');
  assert.equal(result.sources[0].url, 'git.example.com/repo');
  assert.equal(result.sources[0].document_count, 0);
  assert.equal(result.sources[0].last_crawled, null);
});

test('listModules: rejects unknown project (INVALID_PROJECT)', async () => {
  await assert.rejects(
    () => listModules({ project: 'ghost' }, {
      configStore: mockConfigStore({ projects: {} }),
    }),
    (e) => e instanceof McpError && e.code === 'INVALID_PROJECT',
  );
});

test('listModules: validates input', async () => {
  const deps = { configStore: mockConfigStore({ projects: {} }) };
  await assert.rejects(
    () => listModules({ project: '' }, deps),
    (e) => e instanceof McpError && e.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => listModules({}, deps),
    (e) => e instanceof McpError && e.code === 'INVALID_INPUT',
  );
});

test('listModules: empty sources array yields empty list', async () => {
  const projects = { 'a-1.0': { id: 'a-1.0', name: 'A', version: '1.0', sources: [] } };
  const result = await listModules({ project: 'a-1.0' }, {
    configStore: mockConfigStore({ projects }),
  });
  assert.deepEqual(result, { sources: [] });
});

test('listModules: missing sources field yields empty list', async () => {
  const projects = { 'a-1.0': { id: 'a-1.0', name: 'A', version: '1.0' } };
  const result = await listModules({ project: 'a-1.0' }, {
    configStore: mockConfigStore({ projects }),
  });
  assert.deepEqual(result, { sources: [] });
});

test('McpError: carries code + cause and is identifiable by instanceof', () => {
  const cause = new Error('inner');
  const e = new McpError('NO_INDEX', 'msg', cause);
  assert.equal(e instanceof McpError, true);
  assert.equal(e.code, 'NO_INDEX');
  assert.equal(e.cause, cause);
  assert.equal(e.name, 'McpError');
});
