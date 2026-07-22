import {
  aggregatePlays,
  isNeverWatched,
  isNeverStarted,
  isTrustworthy,
  hasSubstantialProgress,
  DEFAULT_COMPLETION_THRESHOLD_PERCENT,
  type PlaybackHistoryRow,
} from './playback-aggregate';

const at = (iso: string) => new Date(iso);
const row = (over: Partial<PlaybackHistoryRow> = {}): PlaybackHistoryRow => ({
  userName: 'alice',
  startedAt: at('2026-01-01T00:00:00Z'),
  stoppedAt: at('2026-01-01T01:00:00Z'),
  watchedSeconds: 3600,
  percentComplete: 95,
  ...over,
});

describe('aggregatePlays', () => {
  it('defaults the completion threshold to 90 (stricter than Trakt\'s 80)', () => {
    expect(DEFAULT_COMPLETION_THRESHOLD_PERCENT).toBe(90);
  });

  it('counts a finished play as completed and a sample as merely started', () => {
    const f = aggregatePlays([
      row({ percentComplete: 96, startedAt: at('2026-01-01T00:00:00Z') }),
      row({ percentComplete: 3, startedAt: at('2026-01-02T00:00:00Z'), watchedSeconds: 30 }),
    ]);
    expect(f.startedPlayCount).toBe(2);
    expect(f.completedPlayCount).toBe(1);
    expect(f.maximumProgressPercent).toBe(96);
  });

  // The threshold is the whole point: a 30-second sample writes a history row
  // exactly like a full feature does, so counting rows would overcount plays.
  it('a play just below the threshold is NOT completed', () => {
    const f = aggregatePlays([row({ percentComplete: 89 })]);
    expect(f.completedPlayCount).toBe(0);
    expect(f.startedPlayCount).toBe(1);
  });

  it('honours a caller-supplied threshold', () => {
    const rows = [row({ percentComplete: 85 })];
    expect(aggregatePlays(rows, 90).completedPlayCount).toBe(0);
    expect(aggregatePlays(rows, 80).completedPlayCount).toBe(1);
  });

  it('counts unique viewers case-insensitively and ignores anonymous rows', () => {
    const f = aggregatePlays([
      row({ userName: 'Alice' }),
      row({ userName: 'alice', startedAt: at('2026-01-03T00:00:00Z') }),
      row({ userName: 'bob', startedAt: at('2026-01-04T00:00:00Z') }),
      row({ userName: null, startedAt: at('2026-01-05T00:00:00Z') }),
    ]);
    expect(f.uniqueViewerCount).toBe(2);
  });

  it('sums watch seconds and takes the latest play time', () => {
    const f = aggregatePlays([
      row({ watchedSeconds: 100, stoppedAt: at('2026-01-01T00:00:00Z') }),
      row({ watchedSeconds: 250, startedAt: at('2026-02-01T00:00:00Z'), stoppedAt: at('2026-02-01T00:10:00Z') }),
    ]);
    expect(f.totalPlaybackSeconds).toBe(350);
    expect(f.lastPlayedAt).toEqual(at('2026-02-01T00:10:00Z'));
  });

  // A repeated media-server heartbeat must not become a play. The poller updates one
  // live session row every 15s and writes history once; a re-import could still
  // resubmit the same session, so identical (viewer, start) rows collapse.
  it('collapses duplicate observations of the same session', () => {
    const f = aggregatePlays([
      row({ percentComplete: 40 }),
      row({ percentComplete: 95 }), // same viewer + same startedAt → same session
    ]);
    expect(f.startedPlayCount).toBe(1);
    expect(f.completedPlayCount).toBe(1); // keeps the most complete observation
    expect(f.maximumProgressPercent).toBe(95);
  });

  it('never counts a row without a progress reading as completed', () => {
    const f = aggregatePlays([row({ percentComplete: null })]);
    expect(f.startedPlayCount).toBe(1);
    expect(f.completedPlayCount).toBe(0);
    expect(f.measuredProgressRowCount).toBe(0);
  });

  it('averages only over rows that actually reported progress', () => {
    const f = aggregatePlays([
      row({ percentComplete: 100 }),
      row({ percentComplete: null, startedAt: at('2026-03-01T00:00:00Z') }),
      row({ percentComplete: 50, startedAt: at('2026-04-01T00:00:00Z') }),
    ]);
    expect(f.measuredProgressRowCount).toBe(2);
    expect(f.averageProgressPercent).toBe(75);
  });

  it('handles an empty history without inventing facts', () => {
    const f = aggregatePlays([]);
    expect(f).toMatchObject({
      startedPlayCount: 0, completedPlayCount: 0, uniqueViewerCount: 0,
      lastPlayedAt: null, maximumProgressPercent: 0, averageProgressPercent: 0,
      totalPlaybackSeconds: 0, sourceRowCount: 0,
    });
  });
});

describe('isNeverWatched', () => {
  it('is true only when nothing completed AND nothing got close', () => {
    expect(isNeverWatched(aggregatePlays([]))).toBe(true);
    expect(isNeverWatched(aggregatePlays([row({ percentComplete: 5 })]))).toBe(true);
  });

  // The specified formula's real consequence, asserted rather than assumed: an 85%
  // abandon has zero completions, so it IS "never watched" and would be eligible.
  // A cautious policy must use the separate substantial-progress exclusion.
  it('treats an 85% abandon as never watched (the specified semantics)', () => {
    const f = aggregatePlays([row({ percentComplete: 85 })]);
    expect(f.completedPlayCount).toBe(0);
    expect(isNeverWatched(f)).toBe(true);
    // …which is exactly why this opt-in guard exists.
    expect(hasSubstantialProgress(f, 75)).toBe(true);
    expect(hasSubstantialProgress(f, 95)).toBe(false);
  });

  it('the two clauses are equivalent under one threshold', () => {
    for (const pct of [0, 10, 50, 89, 90, 100]) {
      const f = aggregatePlays([row({ percentComplete: pct })]);
      expect(isNeverWatched(f)).toBe(
        f.completedPlayCount === 0 && f.maximumProgressPercent < f.completionThresholdPercent,
      );
    }
  });

  it('isNeverStarted is the looser opt-in reading', () => {
    const f = aggregatePlays([row({ percentComplete: 2 })]);
    expect(isNeverStarted(f)).toBe(false);
    expect(isNeverWatched(f)).toBe(true);
  });
});

describe('isTrustworthy — absence must never read as "never watched"', () => {
  it('rejects an empty aggregate the caller could not vouch for', () => {
    const f = aggregatePlays([]);
    expect(isTrustworthy(f, { zeroIsMeaningful: false })).toBe(false);
    expect(isTrustworthy(f, { zeroIsMeaningful: true })).toBe(true);
  });

  it('rejects an aggregate whose rows carried no progress at all', () => {
    const f = aggregatePlays([row({ percentComplete: null })]);
    expect(isTrustworthy(f, { zeroIsMeaningful: true })).toBe(false);
  });

  it('rejects a stale aggregate', () => {
    const f = aggregatePlays([row()]);
    const computedAt = at('2026-01-01T00:00:00Z');
    const now = at('2026-01-10T00:00:00Z');
    expect(isTrustworthy(f, { zeroIsMeaningful: true, computedAt, now, maxAgeMs: 24 * 3600_000 })).toBe(false);
    expect(isTrustworthy(f, { zeroIsMeaningful: true, computedAt, now, maxAgeMs: 30 * 24 * 3600_000 })).toBe(true);
  });
});
