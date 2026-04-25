// T017: Correlation strategies — pluggable matchers that emit relationship links.
// Traces: FR-002 (AC-002-01, AC-002-02, AC-002-04)
// See: docs/requirements/REQ-GH-263-.../module-design.md §Module 5
//
// Each strategy is a pure function:
//   strategy(chunks) → Array<{ from_id, to_id, relationship, confidence }>
//
// The id used for `from_id` / `to_id` is the chunk's index inside the input
// array. The Correlation Engine (./index.js) is responsible for combining,
// deduplicating, and attaching the resulting links back to the chunks.
//
// Confidence convention (calibrated against AC-002-02 / AC-002-04):
//   trace-comment match     → 0.95  (explicit human-authored linkage)
//   path/name match         → 0.90  (very strong heuristic — same stem)
//   import-graph link       → 0.80  (concrete code dependency)
//   confluence-title match  → 0.60  (loose semantic linkage on title only)

/**
 * @typedef {object} CorrelationLink
 * @property {number} from_id
 * @property {number} to_id
 * @property {"spec"|"test"|"doc"|"impl"} relationship
 * @property {number} confidence
 */

const CONFIDENCE = Object.freeze({
  TRACE_COMMENT: 0.95,
  PATH_NAME: 0.9,
  IMPORT_GRAPH: 0.8,
  CONFLUENCE_TITLE: 0.6,
});

const CODE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.go',
  '.java',
  '.rb',
]);
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt', '.adoc']);

/**
 * Split a path into directory, basename and extension.
 * @param {string} p
 */
function splitPath(p) {
  const norm = String(p || '').replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  const dir = slash >= 0 ? norm.slice(0, slash) : '';
  const base = slash >= 0 ? norm.slice(slash + 1) : norm;
  const dot = base.lastIndexOf('.');
  const name = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : '';
  return { dir, base, name, ext };
}

/**
 * Strip common test/spec suffixes and prefixes so that `foo.test`, `foo.spec`,
 * `test_foo` and `foo` all resolve to the same stem `foo`.
 * @param {string} stem
 */
function canonicalStem(stem) {
  const lower = stem.toLowerCase();
  // Strip suffixes: .test, .spec, _test, -test, _spec, -spec
  let s = lower.replace(/[._-](test|spec)$/i, '');
  // Strip prefixes: test_, spec_
  s = s.replace(/^(test|spec)[_-]/i, '');
  return s;
}

function isTestPath(path) {
  const { name, dir } = splitPath(path);
  if (/(^|\/)(__tests__|tests?|spec)(\/|$)/i.test(dir)) return true;
  return /(^|[._-])(test|spec)([._-]|$)/i.test(name);
}

function isDocPath(path) {
  const { ext, dir } = splitPath(path);
  if (DOC_EXTENSIONS.has(ext)) return true;
  if (/(^|\/)(docs?|documentation)(\/|$)/i.test(dir)) return true;
  return false;
}

function isCodePath(path) {
  const { ext } = splitPath(path);
  return CODE_EXTENSIONS.has(ext);
}

/**
 * Determine the relationship label between two chunks once we already know
 * they reference each other.
 * @param {object} from
 * @param {object} to
 * @returns {"spec"|"test"|"doc"|"impl"}
 */
function classify(from, to) {
  if (isTestPath(to.path)) return 'test';
  if (isDocPath(to.path)) {
    return /requirements|spec|prd|user-?story|nfr/i.test(to.path) ? 'spec' : 'doc';
  }
  if (isCodePath(to.path)) return 'impl';
  // Confluence pages and other source types default to "doc" unless their
  // path/title hints otherwise.
  if (to.source_type === 'confluence') return 'doc';
  return 'doc';
}

/**
 * Strategy 1 — Path/Name matching.
 *
 * Links chunks that share a canonical filename stem (e.g. foo.js ↔ foo.test.js,
 * payment.md ↔ payment.js). Bidirectional: emits a link from each side so the
 * engine can attach both ways.
 *
 * @param {Array<import('../connectors/connector.js').NormalisedChunk>} chunks
 * @returns {CorrelationLink[]}
 */
export function pathNameStrategy(chunks) {
  /** @type {CorrelationLink[]} */
  const links = [];
  const byStem = new Map();
  chunks.forEach((c, idx) => {
    const { name } = splitPath(c.path);
    if (!name) return;
    const stem = canonicalStem(name);
    if (!stem) return;
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(idx);
  });

  for (const ids of byStem.values()) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = 0; j < ids.length; j++) {
        if (i === j) continue;
        const from = chunks[ids[i]];
        const to = chunks[ids[j]];
        // Only link when the two paths are actually distinct.
        if (from.path === to.path && from.source_type === to.source_type) continue;
        links.push({
          from_id: ids[i],
          to_id: ids[j],
          relationship: classify(from, to),
          confidence: CONFIDENCE.PATH_NAME,
        });
      }
    }
  }
  return links;
}

/**
 * Extract import targets from JS/TS/Python source. Regex-level only — good
 * enough for v1 to identify same-project relative imports.
 *
 * Returns paths exactly as written in the source (not yet resolved against
 * the project tree). Path resolution to a chunk happens in
 * importGraphStrategy() below.
 *
 * @param {string} content
 * @param {string} path
 * @returns {string[]} raw module specifiers
 */
function extractImportSpecifiers(content, path) {
  /** @type {string[]} */
  const out = [];
  if (typeof content !== 'string' || !content) return out;
  const { ext } = splitPath(path);
  const text = content;

  if (
    ext === '.js' ||
    ext === '.mjs' ||
    ext === '.cjs' ||
    ext === '.jsx' ||
    ext === '.ts' ||
    ext === '.tsx'
  ) {
    // ES imports: import ... from 'x'; import 'x'; export ... from 'x';
    const esRe = /(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
    const bareRe = /import\s+['"]([^'"]+)['"]/g;
    const cjsRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const m of text.matchAll(esRe)) out.push(m[1]);
    for (const m of text.matchAll(bareRe)) out.push(m[1]);
    for (const m of text.matchAll(cjsRe)) out.push(m[1]);
  } else if (ext === '.py') {
    const fromRe = /^\s*from\s+([.\w]+)\s+import\s+/gm;
    const impRe = /^\s*import\s+([.\w]+)/gm;
    for (const m of text.matchAll(fromRe)) out.push(m[1]);
    for (const m of text.matchAll(impRe)) out.push(m[1]);
  }
  return out;
}

/**
 * Resolve a relative module specifier (e.g. './foo', '../bar/baz') against
 * the importing file's directory. Returns a posix-style path stem (no
 * extension) so it can be matched against candidate chunk paths.
 *
 * Handles two flavours:
 *   - JS/TS: spec uses '/' separators (./foo, ../bar/baz)
 *   - Python: spec uses dot-notation (.b, ..pkg.mod). One leading dot means
 *     "current package", each additional dot pops one parent.
 *
 * @param {string} fromPath
 * @param {string} spec
 * @returns {string|null} normalised path or null if not relative
 */
function resolveRelativeSpec(fromPath, spec) {
  if (!spec.startsWith('.')) return null;
  const { dir, ext } = splitPath(fromPath);

  // Python relative imports: dot-notation, no slashes.
  if (ext === '.py' && !spec.includes('/')) {
    // Count leading dots.
    let dots = 0;
    while (dots < spec.length && spec[dots] === '.') dots++;
    const tail = spec.slice(dots).split('.').filter(Boolean);
    const dirParts = dir ? dir.split('/').filter(Boolean) : [];
    // First dot = current package; each extra dot pops one parent.
    const popCount = Math.max(0, dots - 1);
    const base = dirParts.slice(0, Math.max(0, dirParts.length - popCount));
    return base.concat(tail).join('/');
  }

  // JS/TS-style relative path with '/'.
  const parts = (dir ? dir.split('/') : []).concat(spec.split('/'));
  /** @type {string[]} */
  const stack = [];
  for (const seg of parts) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return stack.join('/');
}

/**
 * Strategy 2 — Import graph.
 *
 * Parses JS/TS/Python imports (regex-level) and links a source chunk to the
 * chunk it imports. Only relative imports are resolved — package imports
 * (`import 'react'`) cannot be matched to a chunk in the same index and are
 * skipped silently.
 *
 * @param {Array<import('../connectors/connector.js').NormalisedChunk>} chunks
 * @returns {CorrelationLink[]}
 */
export function importGraphStrategy(chunks) {
  /** @type {CorrelationLink[]} */
  const links = [];

  // Build path lookup: full path AND path-without-extension → chunk index.
  const byExact = new Map();
  const byStemPath = new Map();
  chunks.forEach((c, idx) => {
    if (!c.path) return;
    const norm = c.path.replace(/\\/g, '/');
    byExact.set(norm, idx);
    const { dir, name } = splitPath(norm);
    const stemPath = dir ? `${dir}/${name}` : name;
    if (!byStemPath.has(stemPath)) byStemPath.set(stemPath, []);
    byStemPath.get(stemPath).push(idx);
  });

  chunks.forEach((c, idx) => {
    if (!isCodePath(c.path || '')) return;
    const specs = extractImportSpecifiers(c.content, c.path);
    for (const spec of specs) {
      const resolved = resolveRelativeSpec(c.path, spec);
      if (!resolved) continue;
      // Try exact match first (with extension), then stem match.
      let target = byExact.get(resolved);
      if (target === undefined) {
        // Try common code extensions.
        for (const ext of CODE_EXTENSIONS) {
          const guess = `${resolved}${ext}`;
          if (byExact.has(guess)) {
            target = byExact.get(guess);
            break;
          }
        }
      }
      if (target === undefined) {
        const candidates = byStemPath.get(resolved);
        if (candidates && candidates.length === 1) target = candidates[0];
      }
      if (target === undefined || target === idx) continue;
      links.push({
        from_id: idx,
        to_id: target,
        relationship: 'impl',
        confidence: CONFIDENCE.IMPORT_GRAPH,
      });
    }
  });
  return links;
}

/**
 * Strategy 3 — iSDLC artifact trace comments.
 *
 * Detects REQ-IDs and FR-IDs in code comments / doc bodies and cross-links
 * the chunk that *mentions* the id to the chunk that *defines* it (i.e. a
 * spec/requirement document whose path or content contains the same id).
 *
 * Recognised forms:
 *   // traces: FR-002
 *   // REQ-GH-263
 *   # traces: FR-002, FR-003
 *   <!-- traces: REQ-GH-263 -->
 *
 * @param {Array<import('../connectors/connector.js').NormalisedChunk>} chunks
 * @returns {CorrelationLink[]}
 */
export function traceCommentStrategy(chunks) {
  /** @type {CorrelationLink[]} */
  const links = [];

  const idRe = /\b(REQ-[A-Z]+-\d+|FR-\d+|NFR-\d+|AC-\d+(?:-\d+)*)\b/g;

  // First pass — find every chunk that *defines* an id (spec docs whose path
  // contains the id) and every chunk that *mentions* an id in its content.
  /** @type {Map<string, number[]>} */
  const definers = new Map();
  /** @type {Array<{ id: string, chunk_id: number }>} */
  const mentions = [];

  chunks.forEach((c, idx) => {
    const path = c.path || '';
    const content = typeof c.content === 'string' ? c.content : '';
    const isDoc = isDocPath(path);

    // Definer: doc-typed chunk whose path contains the id.
    const pathIds = path.toUpperCase().match(idRe) || [];
    if (isDoc) {
      for (const id of pathIds) {
        if (!definers.has(id)) definers.set(id, []);
        definers.get(id).push(idx);
      }
    }
    // Mentions: any id reference inside the content (typically code or doc
    // comment), excluding the path itself.
    for (const m of content.matchAll(idRe)) {
      mentions.push({ id: m[1], chunk_id: idx });
    }
  });

  for (const { id, chunk_id } of mentions) {
    const targets = definers.get(id);
    if (!targets) continue;
    for (const t of targets) {
      if (t === chunk_id) continue;
      links.push({
        from_id: chunk_id,
        to_id: t,
        relationship: 'spec',
        confidence: CONFIDENCE.TRACE_COMMENT,
      });
    }
  }
  return links;
}

/**
 * Strategy 4 — Confluence title ↔ module matching.
 *
 * If a Confluence page title (or path-derived title) contains the name of a
 * code module/directory in the same index, link the page to the code chunks
 * that live in that module.
 *
 * Page title is read from `chunk.metadata.title` if present, otherwise from
 * the trailing path segment.
 *
 * @param {Array<import('../connectors/connector.js').NormalisedChunk>} chunks
 * @returns {CorrelationLink[]}
 */
export function confluenceTitleStrategy(chunks) {
  /** @type {CorrelationLink[]} */
  const links = [];

  // Index code chunks by their module token (top-level directory under src/
  // or, failing that, the immediate parent directory).
  /** @type {Map<string, number[]>} */
  const byModule = new Map();
  chunks.forEach((c, idx) => {
    if (!isCodePath(c.path || '')) return;
    const norm = c.path.replace(/\\/g, '/');
    let mod = '';
    const srcMatch = norm.match(/(?:^|\/)src\/([^/]+)\//);
    if (srcMatch) mod = srcMatch[1];
    else {
      const { dir } = splitPath(norm);
      const segs = dir.split('/').filter(Boolean);
      mod = segs[segs.length - 1] || '';
    }
    if (!mod) return;
    const key = mod.toLowerCase();
    if (!byModule.has(key)) byModule.set(key, []);
    byModule.get(key).push(idx);
  });

  chunks.forEach((c, idx) => {
    if (c.source_type !== 'confluence') return;
    const title =
      (c.metadata && typeof c.metadata.title === 'string' && c.metadata.title) ||
      splitPath(c.path || '').name ||
      '';
    if (!title) return;
    const titleLower = title.toLowerCase();
    for (const [mod, codeIdxs] of byModule) {
      if (mod.length < 3) continue; // avoid matching tiny tokens
      // Word-boundary check so "auth" doesn't match "author".
      const re = new RegExp(`\\b${escapeRegExp(mod)}\\b`, 'i');
      if (!re.test(titleLower)) continue;
      for (const codeIdx of codeIdxs) {
        if (codeIdx === idx) continue;
        links.push({
          from_id: idx,
          to_id: codeIdx,
          relationship: 'doc',
          confidence: CONFIDENCE.CONFLUENCE_TITLE,
        });
        // Also emit the reverse so code → doc is captured.
        links.push({
          from_id: codeIdx,
          to_id: idx,
          relationship: 'doc',
          confidence: CONFIDENCE.CONFLUENCE_TITLE,
        });
      }
    }
  });
  return links;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const ALL_STRATEGIES = Object.freeze([
  pathNameStrategy,
  importGraphStrategy,
  traceCommentStrategy,
  confluenceTitleStrategy,
]);

export { CONFIDENCE };
