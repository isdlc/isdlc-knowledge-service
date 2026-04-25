// Observability — Staleness detection (per-project source revision comparison + badge)
// See: FR-015 AC-015-05, AC-015-06
// Module: src/observability/staleness.js (Module 14: Observability)
// Task: T030
//
// Pure-function semantics: this module ONLY computes staleness from inputs;
// it does NOT poll sources itself. Polling is orchestrated upstream by a
// periodic job in the worker (out of scope for T030).
//
// Public interface:
//   computeProjectStaleness(projectConfig, refreshHistory, currentSourceState, opts?) -> StalenessResult
//
// Inputs:
//   projectConfig       — { id, name?, version?, sources: [{ type, url, ... }], ... }
//   refreshHistory      — Array<RefreshRecord>, latest first (index 0).
//                         Records may carry `per_source` map with last-indexed
//                         { revision, indexed_at } per source URL; if not, the
//                         record's `timestamp` is used as last-indexed time
//                         for all sources (legacy behaviour).
//   currentSourceState  — { [source_url]: { revision: string, modified_at: ISO } }
//   opts                — { now?: Date, staleSeconds?: number (default 3600) }
//
// Output (StalenessResult):
//   {
//     project_id: string,
//     badge: "fresh" | "stale" | "unknown",
//     reasons: string[],
//     staleness_seconds: number,
//     per_source: Array<{
//       source_url: string,
//       last_indexed: string | null,    // ISO timestamp or null
//       current_revision: string | null,
//       drift_seconds: number,
//       badge: "fresh" | "stale" | "unknown"
//     }>
//   }
//
// Badge thresholds (default, per AC-015-05):
//   "fresh"   : drift < 1 hour (3600s) AND revision matches current source
//   "stale"   : drift >= staleSeconds OR revision mismatch detected
//   "unknown" : no refresh history, OR no currentSourceState entry for the source
//
// Project-level aggregation:
//   stale > unknown > fresh
//   (stale dominates; otherwise any unknown raises project to unknown.)

const DEFAULT_STALE_SECONDS = 3600;

const BADGE_FRESH = 'fresh';
const BADGE_STALE = 'stale';
const BADGE_UNKNOWN = 'unknown';

// Severity ordering: higher index = higher severity for project rollup.
const SEVERITY = { fresh: 0, unknown: 1, stale: 2 };

function severityOf(badge) {
  return SEVERITY[badge] ?? 0;
}

function maxBadge(a, b) {
  return severityOf(a) >= severityOf(b) ? a : b;
}

/**
 * Compute project-level staleness from precomputed inputs.
 * Pure function: no I/O, no async work.
 *
 * @param {object} projectConfig    Project config with `id` and `sources[]`.
 * @param {Array|null|undefined} refreshHistory  RefreshRecord[], latest first.
 * @param {object} currentSourceState            { source_url -> { revision, modified_at } }.
 * @param {{ now?: Date, staleSeconds?: number }} [opts]
 * @returns {{
 *   project_id: string,
 *   badge: "fresh"|"stale"|"unknown",
 *   reasons: string[],
 *   staleness_seconds: number,
 *   per_source: Array<{
 *     source_url: string,
 *     last_indexed: string|null,
 *     current_revision: string|null,
 *     drift_seconds: number,
 *     badge: "fresh"|"stale"|"unknown"
 *   }>
 * }}
 */
export function computeProjectStaleness(
  projectConfig,
  refreshHistory,
  currentSourceState,
  opts = {},
) {
  // --- Input validation -----------------------------------------------------
  if (!projectConfig || typeof projectConfig !== 'object') {
    throw new Error('computeProjectStaleness: projectConfig is required');
  }
  if (!projectConfig.id || typeof projectConfig.id !== 'string') {
    throw new Error('computeProjectStaleness: projectConfig.id is required');
  }

  const now = opts.now instanceof Date ? opts.now : new Date();
  const staleSeconds =
    typeof opts.staleSeconds === 'number' && opts.staleSeconds > 0
      ? opts.staleSeconds
      : DEFAULT_STALE_SECONDS;
  const sourceState = currentSourceState && typeof currentSourceState === 'object'
    ? currentSourceState
    : {};

  const sources = Array.isArray(projectConfig.sources) ? projectConfig.sources : [];
  const reasons = [];

  // --- Empty sources --------------------------------------------------------
  if (sources.length === 0) {
    reasons.push('Project has no sources configured');
    return {
      project_id: projectConfig.id,
      badge: BADGE_UNKNOWN,
      reasons,
      staleness_seconds: 0,
      per_source: [],
    };
  }

  // --- No refresh history ---------------------------------------------------
  const hasHistory = Array.isArray(refreshHistory) && refreshHistory.length > 0;
  if (!hasHistory) {
    reasons.push('No refresh history available for project');
    const per_source = sources.map((s) => ({
      source_url: s.url,
      last_indexed: null,
      current_revision: sourceState[s.url]?.revision ?? null,
      drift_seconds: 0,
      badge: BADGE_UNKNOWN,
    }));
    return {
      project_id: projectConfig.id,
      badge: BADGE_UNKNOWN,
      reasons,
      staleness_seconds: 0,
      per_source,
    };
  }

  // --- Per-source evaluation ------------------------------------------------
  const latest = refreshHistory[0];
  const latestPerSource = latest && typeof latest.per_source === 'object' && latest.per_source !== null
    ? latest.per_source
    : null;
  const fallbackTimestamp = latest?.timestamp ?? null;

  let projectBadge = BADGE_FRESH;
  let maxDriftSeconds = 0;

  const per_source = sources.map((source) => {
    const url = source.url;
    const sourceType = source.type ?? 'source';

    // Resolve last-indexed entry: prefer per-source record, else fall back to the
    // refresh record's top-level timestamp (legacy behaviour).
    const perSrc = latestPerSource ? latestPerSource[url] : undefined;
    const lastIndexedISO = perSrc?.indexed_at ?? fallbackTimestamp ?? null;
    const indexedRevision = perSrc?.revision ?? null;

    const currentEntry = sourceState[url];
    const currentRevision = currentEntry?.revision ?? null;

    // Per-source unknown: no current state available for this URL.
    if (!currentEntry) {
      reasons.push(`No current state for source ${url}; marked unknown`);
      projectBadge = maxBadge(projectBadge, BADGE_UNKNOWN);
      return {
        source_url: url,
        last_indexed: lastIndexedISO,
        current_revision: null,
        drift_seconds: 0,
        badge: BADGE_UNKNOWN,
      };
    }

    // If we cannot determine when this source was last indexed, treat as unknown.
    if (!lastIndexedISO) {
      reasons.push(`No last-indexed timestamp for source ${url}; marked unknown`);
      projectBadge = maxBadge(projectBadge, BADGE_UNKNOWN);
      return {
        source_url: url,
        last_indexed: null,
        current_revision: currentRevision,
        drift_seconds: 0,
        badge: BADGE_UNKNOWN,
      };
    }

    // Compute drift = now - last_indexed (clamped at >= 0).
    const lastIndexedMs = Date.parse(lastIndexedISO);
    let driftSeconds = 0;
    if (Number.isFinite(lastIndexedMs)) {
      driftSeconds = Math.max(0, Math.floor((now.getTime() - lastIndexedMs) / 1000));
    }

    // Track project-level max drift for staleness_seconds reporting.
    if (driftSeconds > maxDriftSeconds) {
      maxDriftSeconds = driftSeconds;
    }

    // Determine badge: revision mismatch OR drift >= threshold => stale.
    let badge = BADGE_FRESH;
    const revisionMismatch =
      indexedRevision !== null &&
      currentRevision !== null &&
      indexedRevision !== currentRevision;

    if (revisionMismatch) {
      badge = BADGE_STALE;
      reasons.push(
        `Revision mismatch on ${sourceType} source ${url}: indexed=${indexedRevision} current=${currentRevision}`,
      );
    } else if (driftSeconds >= staleSeconds) {
      badge = BADGE_STALE;
      reasons.push(
        `Source ${url} exceeded staleness threshold: drift=${driftSeconds}s >= ${staleSeconds}s`,
      );
    }

    projectBadge = maxBadge(projectBadge, badge);

    return {
      source_url: url,
      last_indexed: lastIndexedISO,
      current_revision: currentRevision,
      drift_seconds: driftSeconds,
      badge,
    };
  });

  return {
    project_id: projectConfig.id,
    badge: projectBadge,
    reasons,
    staleness_seconds: maxDriftSeconds,
    per_source,
  };
}

export default computeProjectStaleness;
