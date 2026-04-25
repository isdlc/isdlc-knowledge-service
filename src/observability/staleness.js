// Observability — Staleness detection (per-project source revision comparison + badge)
// See: FR-015 AC-015-05, AC-015-06

/**
 * @typedef {"fresh"|"stale"|"unknown"} StalenessBadge
 */

/**
 * Compute staleness for a project by comparing last indexed revision vs current source state.
 * @param {string} projectId
 * @returns {Promise<{ badge: StalenessBadge, age_seconds: number, sources: object[] }>}
 */
export default async function computeStaleness(projectId) {
  throw new Error('Not implemented — see T030');
}
