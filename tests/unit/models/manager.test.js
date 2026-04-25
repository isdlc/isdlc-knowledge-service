// T008: ModelManager — unit tests
// Traces: FR-011 (AC-011-01, AC-011-02, AC-011-03, AC-011-04, AC-011-05)
// See: src/models/manager.js
//      docs/requirements/REQ-GH-263-.../module-design.md §Module 8
//
// Mock strategy: we never construct a real OnnxLocalAdapter. Tests pass an
// `adapterFactories.local` (and where relevant `adapterFactories.cloud`)
// that returns a fake adapter — quacking like ModelAdapter — with a
// controllable identifier and memory footprint. A monotonic fake clock
// gives us deterministic LRU ordering.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ModelManager } from '../../../src/models/manager.js';
import { ModelAdapter } from '../../../src/models/adapter.js';

/** Build a quacking-like-ModelAdapter fake with a fixed memory and a tag. */
function makeFakeAdapter({ name, memory_mb = 100, type = 'local', precision = 'fp16' } = {}) {
  const adapter = new ModelAdapter();
  adapter._fakeName = name;
  adapter._fakeMemory = memory_mb;
  adapter.embed = async () => [0];
  adapter.batchEmbed = async (texts) => texts.map(() => [0]);
  adapter.getInfo = () => ({
    name,
    type,
    dimensions: 384,
    max_input_tokens: 512,
    precision: type === 'local' ? precision : undefined,
    memory_mb,
  });
  adapter.getMemoryUsage = () => memory_mb;
  return adapter;
}

/** Monotonic fake clock — each read advances by 1ms. */
function makeClock(start = 1_000) {
  let t = start;
  const fn = () => ++t;
  fn.peek = () => t;
  return fn;
}

/** Default factories: every "local" config gets a fresh fake; cloud likewise. */
function defaultFactories(memoryByName = {}) {
  return {
    local: (cfg) =>
      makeFakeAdapter({
        name: cfg.name,
        memory_mb: memoryByName[cfg.name] ?? 100,
        type: 'local',
        precision: cfg.precision ?? 'fp16',
      }),
    cloud: (cfg) =>
      makeFakeAdapter({
        name: cfg.name,
        memory_mb: 0,
        type: 'cloud',
      }),
  };
}

const cfg = (name, extra = {}) => ({ name, type: 'local', precision: 'fp16', ...extra });
const cloudCfg = (name, extra = {}) => ({ name, type: 'cloud', provider: 'openai', ...extra });

// ---------------------------------------------------------------------------
// Construction / argument validation
// ---------------------------------------------------------------------------

test('constructor: rejects invalid maxLoadedModels', () => {
  assert.throws(() => new ModelManager({ maxLoadedModels: 0 }), /positive integer/);
  assert.throws(() => new ModelManager({ maxLoadedModels: -1 }), /positive integer/);
  assert.throws(() => new ModelManager({ maxLoadedModels: 1.5 }), /positive integer/);
});

test('getAdapter: rejects bad inputs', () => {
  const m = new ModelManager({ adapterFactories: defaultFactories() });
  assert.throws(() => m.getAdapter(null), /config is required/);
  assert.throws(() => m.getAdapter({ type: 'local' }), /config\.name is required/);
  assert.throws(
    () => m.getAdapter({ name: 'x', type: 'remote' }),
    /must be "local" or "cloud"/,
  );
});

test('pin/unpin: reject empty names', () => {
  const m = new ModelManager({ adapterFactories: defaultFactories() });
  assert.throws(() => m.pin(''), /name is required/);
  assert.throws(() => m.unpin(undefined), /name is required/);
});

// ---------------------------------------------------------------------------
// Load + cache hit
// ---------------------------------------------------------------------------

test('getAdapter: lazy-loads then returns the cached adapter (cache hit)', () => {
  let calls = 0;
  const m = new ModelManager({
    adapterFactories: {
      local: (c) => {
        calls++;
        return makeFakeAdapter({ name: c.name });
      },
    },
  });

  const a1 = m.getAdapter(cfg('m-a'));
  const a2 = m.getAdapter(cfg('m-a'));
  assert.strictEqual(calls, 1, 'factory must run only once for the same name');
  assert.strictEqual(a1, a2, 'cached adapter must be the same instance');
});

// ---------------------------------------------------------------------------
// AC-011-02: lazy load + LRU eviction
// ---------------------------------------------------------------------------

test('AC-011-02: LRU evicts the least-recently-used unpinned model when at capacity', () => {
  const clock = makeClock();
  const m = new ModelManager({
    maxLoadedModels: 2,
    adapterFactories: defaultFactories(),
    clock,
  });

  m.getAdapter(cfg('A'));            // A loaded at t=1001
  m.getAdapter(cfg('B'));            // B loaded at t=1002
  m.getAdapter(cfg('A'));            // A touched at t=1003 -> A is newer than B

  // Loading C must evict B (oldest unpinned), not A.
  m.getAdapter(cfg('C'));

  const names = m.getStatus().filter((s) => s.loaded).map((s) => s.name).sort();
  assert.deepStrictEqual(names, ['A', 'C']);
});

test('AC-011-02: cache hit refreshes recency (last_used updated)', () => {
  const clock = makeClock();
  const m = new ModelManager({
    maxLoadedModels: 3,
    adapterFactories: defaultFactories(),
    clock,
  });

  m.getAdapter(cfg('A'));
  const beforeTouch = m.getStatus().find((s) => s.name === 'A').last_used;
  m.getAdapter(cfg('A'));
  const afterTouch = m.getStatus().find((s) => s.name === 'A').last_used;
  assert.ok(afterTouch > beforeTouch, 'last_used must advance on cache hit');
});

// ---------------------------------------------------------------------------
// AC-011-01: pinned models stay loaded; cannot be evicted
// ---------------------------------------------------------------------------

test('AC-011-01: pinned model is NOT evicted when newer models load', () => {
  const clock = makeClock();
  const m = new ModelManager({
    maxLoadedModels: 2,
    adapterFactories: defaultFactories(),
    clock,
  });

  m.getAdapter(cfg('PIN'));
  m.pin('PIN');
  m.getAdapter(cfg('B'));

  // Loading C exceeds capacity. PIN is the oldest entry but is pinned, so B
  // (the only unpinned candidate) must be evicted.
  m.getAdapter(cfg('C'));

  const loaded = m.getStatus().filter((s) => s.loaded).map((s) => s.name).sort();
  assert.deepStrictEqual(loaded, ['C', 'PIN']);
});

test('AC-011-01: pin() before load is sticky — the model inherits the pin on load', () => {
  const clock = makeClock();
  const m = new ModelManager({
    maxLoadedModels: 2,
    adapterFactories: defaultFactories(),
    clock,
  });

  m.pin('FUTURE');               // no adapter loaded yet
  m.getAdapter(cfg('FUTURE'));   // first load -> inherits pin
  m.getAdapter(cfg('B'));
  m.getAdapter(cfg('C'));        // would normally evict the oldest; FUTURE is pinned

  const status = m.getStatus().filter((s) => s.loaded);
  const future = status.find((s) => s.name === 'FUTURE');
  assert.ok(future, 'FUTURE must remain loaded');
  assert.strictEqual(future.pinned, true, 'FUTURE must be pinned');
});

test('AC-011-01: getAdapter throws if cache is full and every loaded model is pinned', () => {
  const m = new ModelManager({
    maxLoadedModels: 2,
    adapterFactories: defaultFactories(),
  });

  m.getAdapter(cfg('A'));
  m.getAdapter(cfg('B'));
  m.pin('A');
  m.pin('B');

  assert.throws(() => m.getAdapter(cfg('C')), /every loaded model is pinned/);
});

// ---------------------------------------------------------------------------
// AC-011-02: unpin makes the model evictable again
// ---------------------------------------------------------------------------

test('AC-011-02 (unpin): previously pinned model becomes evictable', () => {
  const clock = makeClock();
  const m = new ModelManager({
    maxLoadedModels: 2,
    adapterFactories: defaultFactories(),
    clock,
  });

  m.getAdapter(cfg('A'));
  m.pin('A');
  m.getAdapter(cfg('B'));

  // While A is pinned, loading C must evict B (not A).
  m.getAdapter(cfg('C'));
  let loaded = m.getStatus().filter((s) => s.loaded).map((s) => s.name).sort();
  assert.deepStrictEqual(loaded, ['A', 'C']);

  // Now unpin A. Touch C so A becomes the LRU. Loading D must evict A.
  m.unpin('A');
  m.getAdapter(cfg('C'));      // refresh C's recency
  m.getAdapter(cfg('D'));      // evicts oldest unpinned -> A
  loaded = m.getStatus().filter((s) => s.loaded).map((s) => s.name).sort();
  assert.deepStrictEqual(loaded, ['C', 'D']);
});

// ---------------------------------------------------------------------------
// AC-011-03 + AC-011-04: getStatus shape — name, loaded, pinned, memory_mb, last_used
// ---------------------------------------------------------------------------

test('AC-011-03: getStatus() returns the expected shape per loaded model', () => {
  const clock = makeClock();
  const m = new ModelManager({
    maxLoadedModels: 3,
    adapterFactories: defaultFactories({ A: 250, B: 80 }),
    clock,
  });

  m.getAdapter(cfg('A'));
  m.getAdapter(cfg('B'));
  m.pin('B');

  const status = m.getStatus();
  assert.strictEqual(status.length, 2);

  const a = status.find((s) => s.name === 'A');
  assert.deepStrictEqual(Object.keys(a).sort(), [
    'last_used',
    'loaded',
    'memory_mb',
    'name',
    'pinned',
  ]);
  assert.strictEqual(a.loaded, true);
  assert.strictEqual(a.pinned, false);
  assert.strictEqual(a.memory_mb, 250);
  assert.ok(typeof a.last_used === 'number');

  const b = status.find((s) => s.name === 'B');
  assert.strictEqual(b.pinned, true);
  assert.strictEqual(b.memory_mb, 80);
});

test('AC-011-04: total memory can be aggregated from getStatus() entries', () => {
  const m = new ModelManager({
    maxLoadedModels: 3,
    adapterFactories: defaultFactories({ A: 250, B: 80, C: 120 }),
  });
  m.getAdapter(cfg('A'));
  m.getAdapter(cfg('B'));
  m.getAdapter(cfg('C'));

  const total = m.getStatus().reduce((sum, s) => sum + s.memory_mb, 0);
  assert.strictEqual(total, 250 + 80 + 120);
});

test('AC-011-03: pinned-but-not-loaded models surface in getStatus() as loaded:false', () => {
  const m = new ModelManager({ adapterFactories: defaultFactories() });
  m.pin('GHOST');
  const status = m.getStatus();
  assert.strictEqual(status.length, 1);
  assert.deepStrictEqual(status[0], {
    name: 'GHOST',
    loaded: false,
    pinned: true,
    memory_mb: 0,
    last_used: null,
  });
});

// ---------------------------------------------------------------------------
// AC-011-05: cloud configs bypass the local cache (no memory footprint)
// ---------------------------------------------------------------------------

test('AC-011-05: cloud configs bypass cache — fresh adapter per call, no LRU footprint', () => {
  let cloudCalls = 0;
  let localCalls = 0;
  const m = new ModelManager({
    maxLoadedModels: 2,
    adapterFactories: {
      local: (c) => {
        localCalls++;
        return makeFakeAdapter({ name: c.name });
      },
      cloud: (c) => {
        cloudCalls++;
        return makeFakeAdapter({ name: c.name, type: 'cloud', memory_mb: 0 });
      },
    },
  });

  const c1 = m.getAdapter(cloudCfg('openai-3-small'));
  const c2 = m.getAdapter(cloudCfg('openai-3-small'));

  assert.strictEqual(cloudCalls, 2, 'cloud adapter is built fresh each call');
  assert.notStrictEqual(c1, c2, 'cloud adapters must NOT be cached');

  // Cloud calls must not affect the local cache or status.
  assert.strictEqual(m.getStatus().length, 0, 'cloud calls leave local status empty');
  assert.strictEqual(localCalls, 0);

  // Cloud calls must not consume LRU slots — capacity remains for two locals.
  m.getAdapter(cfg('A'));
  m.getAdapter(cfg('B'));
  const loaded = m.getStatus().filter((s) => s.loaded).map((s) => s.name).sort();
  assert.deepStrictEqual(loaded, ['A', 'B']);
});

test('AC-011-05: cloud config with no cloud factory throws an actionable error', () => {
  const m = new ModelManager({
    adapterFactories: { local: defaultFactories().local },  // cloud omitted
  });
  assert.throws(
    () => m.getAdapter(cloudCfg('cohere-embed-v3')),
    /cloud adapter factory not configured/,
  );
});

// ---------------------------------------------------------------------------
// Defensive — pin/unpin idempotency, factory validation
// ---------------------------------------------------------------------------

test('pin/unpin: idempotent', () => {
  const m = new ModelManager({ adapterFactories: defaultFactories() });
  m.getAdapter(cfg('A'));
  m.pin('A');
  m.pin('A');
  assert.strictEqual(m.getStatus().find((s) => s.name === 'A').pinned, true);
  m.unpin('A');
  m.unpin('A');
  assert.strictEqual(m.getStatus().find((s) => s.name === 'A').pinned, false);
});

test('factory must return a ModelAdapter-shaped object', () => {
  const m = new ModelManager({
    adapterFactories: { local: () => ({ /* no embed/batchEmbed/getInfo */ }) },
  });
  assert.throws(() => m.getAdapter(cfg('bad')), /invalid adapter/);
});

test('memory falls back to getInfo().memory_mb when getMemoryUsage is absent', () => {
  const m = new ModelManager({
    adapterFactories: {
      local: () => ({
        embed: async () => [0],
        batchEmbed: async (t) => t.map(() => [0]),
        getInfo: () => ({
          name: 'INFO-ONLY',
          type: 'local',
          dimensions: 384,
          max_input_tokens: 512,
          memory_mb: 175,
        }),
      }),
    },
  });
  m.getAdapter(cfg('INFO-ONLY'));
  assert.strictEqual(m.getStatus()[0].memory_mb, 175);
});
