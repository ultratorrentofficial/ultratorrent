/**
 * Playback aggregation — the pure core.
 *
 * Cleanup policies ask "never watched" and "completed plays < 100". Nothing in the
 * platform could answer either: there is no per-item play counter anywhere, and
 * `MediaUserWatch` cannot ever supply one because `@@unique([userId, key])`
 * collapses a rewatch into a single row. The only per-play store is
 * `MediaServerWatchHistory`, one row written when a session ends.
 *
 * Two semantics are load-bearing, and both are safety decisions:
 *
 * 1. **A play is not a watch.** A history row is written for a 30-second sample
 *    exactly as for a full feature, so counting rows overcounts. A play counts as
 *    COMPLETED only at or above the completion threshold (default 90 — deliberately
 *    stricter than Trakt's 80, because "Trakt thinks you watched it" and "it is safe
 *    to delete this" are different questions).
 *
 * 2. **Absence is not evidence.** An item with no resolved history is NOT "never
 *    watched" — it is unmeasured. This module reports what it actually saw
 *    (`sourceRowCount` vs `resolvedSourceRowCount`) and the caller excludes an
 *    untrustworthy aggregate rather than reading zero as permission to delete.
 *    This is the single most dangerous failure mode in the feature.
 *
 * Heartbeats cannot inflate a count: the poller UPDATES one live session row every
 * 15s and writes history only once, at session end. We additionally collapse rows
 * that describe the same session (same viewer + same start) so a re-import cannot
 * double-count either.
 */

export const DEFAULT_COMPLETION_THRESHOLD_PERCENT = 90;

/** One completed-playback row, narrowed to what aggregation needs. */
export interface PlaybackHistoryRow {
  /** Media-server username; the viewer namespace. Null when the server withheld it. */
  userName?: string | null;
  startedAt: Date;
  stoppedAt?: Date | null;
  watchedSeconds?: number | null;
  /** 0–100. Null when the source (e.g. a Tautulli row) did not report it. */
  percentComplete?: number | null;
}

export interface PlaybackAggregateFacts {
  startedPlayCount: number;
  completedPlayCount: number;
  uniqueViewerCount: number;
  lastPlayedAt: Date | null;
  maximumProgressPercent: number;
  averageProgressPercent: number;
  totalPlaybackSeconds: number;
  /** Rows considered (post-dedup). */
  sourceRowCount: number;
  /** Rows that carried a usable progress reading. */
  measuredProgressRowCount: number;
  completionThresholdPercent: number;
}

/** Collapse rows describing the same session so a re-import cannot double-count. */
function dedupe(rows: PlaybackHistoryRow[]): PlaybackHistoryRow[] {
  const seen = new Map<string, PlaybackHistoryRow>();
  for (const r of rows) {
    const key = `${r.userName ?? '∅'}|${r.startedAt instanceof Date ? r.startedAt.getTime() : r.startedAt}`;
    const prev = seen.get(key);
    // Keep the most complete observation of the same session.
    if (!prev || (r.percentComplete ?? -1) > (prev.percentComplete ?? -1)) seen.set(key, r);
  }
  return [...seen.values()];
}

export function aggregatePlays(
  rows: PlaybackHistoryRow[],
  completionThresholdPercent: number = DEFAULT_COMPLETION_THRESHOLD_PERCENT,
): PlaybackAggregateFacts {
  const deduped = dedupe(rows);

  let completed = 0;
  let maxProgress = 0;
  let totalSeconds = 0;
  let progressSum = 0;
  let measuredProgressRows = 0;
  let lastPlayedAt: Date | null = null;
  const viewers = new Set<string>();

  for (const r of deduped) {
    if (r.userName) viewers.add(r.userName.toLowerCase());

    const pct = typeof r.percentComplete === 'number' ? r.percentComplete : null;
    if (pct != null) {
      measuredProgressRows += 1;
      progressSum += pct;
      if (pct > maxProgress) maxProgress = pct;
      // A play with NO progress reading is never counted as completed — an unknown
      // is not a completion.
      if (pct >= completionThresholdPercent) completed += 1;
    }

    if (typeof r.watchedSeconds === 'number' && r.watchedSeconds > 0) {
      totalSeconds += r.watchedSeconds;
    }

    const at = r.stoppedAt ?? r.startedAt;
    if (at && (!lastPlayedAt || at > lastPlayedAt)) lastPlayedAt = at;
  }

  return {
    startedPlayCount: deduped.length,
    completedPlayCount: completed,
    uniqueViewerCount: viewers.size,
    lastPlayedAt,
    maximumProgressPercent: Math.round(maxProgress),
    averageProgressPercent: measuredProgressRows
      ? Math.round((progressSum / measuredProgressRows) * 100) / 100
      : 0,
    totalPlaybackSeconds: totalSeconds,
    sourceRowCount: deduped.length,
    measuredProgressRowCount: measuredProgressRows,
    completionThresholdPercent,
  };
}

/**
 * The specified default: `completedPlayCount = 0 AND maximumProgressPercent <
 * completionThreshold`.
 *
 * Note the two clauses are logically EQUIVALENT under a single threshold — a play
 * counts as completed exactly when its progress reaches the threshold, so zero
 * completions already implies max progress is below it. The redundancy is kept
 * because it states the intent explicitly.
 *
 * The consequence is worth being clear about: a file someone watched to 85% and
 * abandoned has zero completions, so it IS "never watched" by this definition and
 * would be eligible. Policies that consider that too aggressive should add the
 * separate {@link hasSubstantialProgress} exclusion rather than redefining the
 * term — see `excludeIfProgressAbovePercent` in the policy document.
 */
export function isNeverWatched(facts: PlaybackAggregateFacts): boolean {
  return (
    facts.completedPlayCount === 0 &&
    facts.maximumProgressPercent < facts.completionThresholdPercent
  );
}

/**
 * Opt-in safety valve: someone got meaningfully far into this file even though they
 * never finished it. Exposed separately so "never watched" keeps its specified
 * meaning while a cautious policy can still refuse to delete a near-finish.
 */
export function hasSubstantialProgress(
  facts: PlaybackAggregateFacts,
  floorPercent: number,
): boolean {
  return facts.maximumProgressPercent >= floorPercent;
}

/** The looser reading a policy may opt into: any start at all counts as watched. */
export function isNeverStarted(facts: PlaybackAggregateFacts): boolean {
  return facts.startedPlayCount === 0;
}

/**
 * Is this aggregate safe to make a destructive decision on?
 *
 * `zeroIsMeaningful` is the caller's assertion that it genuinely enumerated the
 * history for this item and found none — as opposed to having failed to resolve
 * the item's history at all. An aggregate built from unresolved rows reports
 * "0 plays" identically to one for a truly untouched file, and only the caller
 * knows which it is looking at.
 */
export function isTrustworthy(
  facts: PlaybackAggregateFacts,
  opts: { zeroIsMeaningful: boolean; maxAgeMs?: number; computedAt?: Date; now?: Date },
): boolean {
  if (facts.sourceRowCount === 0 && !opts.zeroIsMeaningful) return false;
  // Rows that carried no progress reading cannot support a completion decision.
  if (facts.sourceRowCount > 0 && facts.measuredProgressRowCount === 0) return false;
  if (opts.maxAgeMs != null && opts.computedAt) {
    const now = opts.now ?? new Date();
    if (now.getTime() - opts.computedAt.getTime() > opts.maxAgeMs) return false;
  }
  return true;
}
