import {
  windowCovers, activeWindows, applySchedule, windowIsValid, localPosition,
  type ScheduleWindow,
} from './schedule';
import type { EffectivePolicy } from './policy';

/**
 * Recurring windows.
 *
 * The awkward cases are the point: a window that crosses midnight, two windows
 * that overlap, an hour that does not exist because the clocks went forward, and
 * an hour that happens twice because they went back. Evaluation is pure and
 * stateless, so a restart or a clock moved backwards cannot corrupt anything —
 * there is no "already fired" to lose.
 */
const w = (over: Partial<ScheduleWindow>): ScheduleWindow => ({
  id: 'w1', name: 'n', enabled: true,
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  startMinute: 60, endMinute: 120,
  timeZone: 'UTC', priority: 0,
  ...over,
});

// 2026-08-04 is a Tuesday (weekday 2).
const at = (iso: string) => new Date(iso);

describe('a window covering an instant', () => {
  it('covers the middle and excludes the end', () => {
    // Half-open: [start, end). Two adjacent windows must not both be active on
    // the boundary minute.
    const win = w({ startMinute: 60, endMinute: 120 });
    expect(windowCovers(win, at('2026-08-04T01:00:00Z'))).toBe(true);
    expect(windowCovers(win, at('2026-08-04T01:59:00Z'))).toBe(true);
    expect(windowCovers(win, at('2026-08-04T02:00:00Z'))).toBe(false);
    expect(windowCovers(win, at('2026-08-04T00:59:00Z'))).toBe(false);
  });

  it('only covers the days it names', () => {
    const tuesdayOnly = w({ daysOfWeek: [2] });
    expect(windowCovers(tuesdayOnly, at('2026-08-04T01:30:00Z'))).toBe(true);   // Tue
    expect(windowCovers(tuesdayOnly, at('2026-08-05T01:30:00Z'))).toBe(false);  // Wed
  });

  it('is inert when disabled', () => {
    expect(windowCovers(w({ enabled: false }), at('2026-08-04T01:30:00Z'))).toBe(false);
  });
});

describe('a window that crosses midnight', () => {
  // "Tuesday 22:00–02:00" runs into Wednesday morning without Wednesday being
  // ticked — which is what an operator means when they choose Tuesday.
  const overnight = w({ daysOfWeek: [2], startMinute: 22 * 60, endMinute: 2 * 60 });

  it('covers the evening of the day it names', () => {
    expect(windowCovers(overnight, at('2026-08-04T22:30:00Z'))).toBe(true);
  });

  it('covers the small hours of the FOLLOWING day', () => {
    expect(windowCovers(overnight, at('2026-08-05T01:30:00Z'))).toBe(true);
  });

  it('does not cover the small hours of the day it names', () => {
    // Tuesday 01:30 belongs to Monday night's window, and Monday was not ticked.
    expect(windowCovers(overnight, at('2026-08-04T01:30:00Z'))).toBe(false);
  });

  it('does not cover the evening of the following day', () => {
    expect(windowCovers(overnight, at('2026-08-05T22:30:00Z'))).toBe(false);
  });
});

describe('timezones and daylight saving', () => {
  it('reads the operator\'s wall clock, not UTC', () => {
    // 06:30 UTC is 02:30 in New York during summer. A window written as
    // 02:00–03:00 local means their night, not ours.
    const night = w({ timeZone: 'America/New_York', startMinute: 120, endMinute: 180 });
    expect(windowCovers(night, at('2026-08-04T06:30:00Z'))).toBe(true);
    expect(windowCovers(night, at('2026-08-04T02:30:00Z'))).toBe(false);
  });

  it('never opens a window inside the hour that does not exist', () => {
    /*
     * US clocks jump 02:00 → 03:00 on 2026-03-08. A window of 02:00–02:59 local
     * simply never occurs that day, which is the correct reading of what was
     * written rather than an error to report.
     */
    const skipped = w({ timeZone: 'America/New_York', startMinute: 120, endMinute: 179 });
    // 07:00 UTC is the instant the local clock reads 03:00.
    expect(windowCovers(skipped, at('2026-03-08T07:00:00Z'))).toBe(false);
    expect(windowCovers(skipped, at('2026-03-08T06:59:00Z'))).toBe(false); // 01:59 local
  });

  it('opens twice inside the hour that happens twice', () => {
    // Clocks go back 02:00 → 01:00 on 2026-11-01, so 01:30 local occurs at both
    // 05:30 and 06:30 UTC. A window covering it is active for both.
    const repeated = w({ timeZone: 'America/New_York', startMinute: 60, endMinute: 120 });
    expect(windowCovers(repeated, at('2026-11-01T05:30:00Z'))).toBe(true);
    expect(windowCovers(repeated, at('2026-11-01T06:30:00Z'))).toBe(true);
  });

  it('treats an unrecognised timezone as inert rather than throwing', () => {
    // A bad zone must not take the whole sweep down.
    const bad = w({ timeZone: 'Mars/Olympus_Mons' });
    expect(() => windowCovers(bad, at('2026-08-04T01:30:00Z'))).not.toThrow();
    expect(windowCovers(bad, at('2026-08-04T01:30:00Z'))).toBe(false);
    expect(localPosition(at('2026-08-04T01:30:00Z'), 'Mars/Olympus_Mons')).toBeNull();
  });
});

describe('invalid definitions', () => {
  it('rejects a zero-length window', () => {
    // Treating it as "always" or "never" would both be guesses about intent.
    expect(windowIsValid(w({ startMinute: 60, endMinute: 60 }))).toBe(false);
  });

  it('rejects out-of-range minutes and weekdays', () => {
    expect(windowIsValid(w({ startMinute: -1 }))).toBe(false);
    expect(windowIsValid(w({ endMinute: 1440 }))).toBe(false);
    expect(windowIsValid(w({ daysOfWeek: [7] }))).toBe(false);
  });

  it('rejects a window that names no days', () => {
    expect(windowIsValid(w({ daysOfWeek: [] }))).toBe(false);
  });
});

describe('overlapping windows', () => {
  const base: EffectivePolicy = {
    maxConcurrentDownloads: 10, maxConcurrentSeeds: 10, maxTotalActive: 20,
    maxDownloadRateKbps: null, maxUploadRateKbps: null,
    reserveDownloadBandwidthPercent: null, reserveSeedBandwidthPercent: null,
    seedPolicy: null, activeScheduleId: null, sources: {},
  };
  const now = at('2026-08-04T01:30:00Z');

  it('lets the higher priority win the fields it sets', () => {
    const broad = w({ id: 'broad', priority: 0, maxConcurrentDownloads: 5, maxUploadRateKbps: 1000 });
    const narrow = w({ id: 'narrow', priority: 10, maxConcurrentDownloads: 1 });

    const out = applySchedule(base, [broad, narrow], now);
    expect(out.maxConcurrentDownloads).toBe(1);       // narrow wins
    expect(out.maxUploadRateKbps).toBe(1000);         // only broad set it
    expect(out.sources.maxConcurrentDownloads).toBe('schedule:narrow');
  });

  it('resolves an equal-priority overlap the same way every time', () => {
    // A tie that resolved differently between sweeps would make the schedule flap.
    const a = w({ id: 'aaa', priority: 5, maxTotalActive: 1 });
    const b = w({ id: 'bbb', priority: 5, maxTotalActive: 2 });
    expect(applySchedule(base, [a, b], now).maxTotalActive)
      .toBe(applySchedule(base, [b, a], now).maxTotalActive);
    expect(activeWindows([b, a], now)[0].id).toBe('aaa');
  });

  it('leaves the policy untouched when nothing is open', () => {
    const closed = w({ startMinute: 600, endMinute: 660 });
    const out = applySchedule(base, [closed], now);
    expect(out.maxConcurrentDownloads).toBe(10);
    expect(out.activeWindowIds).toEqual([]);
  });

  it('carries "no new downloads" as a flag, NOT as a ceiling of zero', () => {
    /*
     * They are different promises. A ceiling of zero would put every download
     * already in flight over the limit and pause it; what the operator asked for
     * is that nothing new starts. The existing limit is left exactly as the
     * policy set it.
     */
    const quiet = w({ id: 'quiet', allowNewDownloads: false });
    const out = applySchedule(base, [quiet], now);
    expect(out.allowNewDownloads).toBe(false);
    expect(out.maxConcurrentDownloads).toBe(10);
  });

  it('records which windows shaped the result', () => {
    const one = w({ id: 'one', priority: 1, maxTotalActive: 3 });
    const two = w({ id: 'two', priority: 2, maxConcurrentSeeds: 4 });
    expect(applySchedule(base, [one, two], now).activeWindowIds).toEqual(['two', 'one']);
  });
});

describe('statelessness', () => {
  it('gives the same answer for the same instant, whenever it is asked', () => {
    // Why a restart, or a clock moved backwards, cannot corrupt a schedule:
    // nothing is remembered between evaluations.
    const win = w({ startMinute: 60, endMinute: 120 });
    const instant = at('2026-08-04T01:30:00Z');
    expect(windowCovers(win, instant)).toBe(windowCovers(win, instant));
    // And an earlier instant simply reads as earlier, not as "already done".
    expect(windowCovers(win, at('2026-08-04T00:30:00Z'))).toBe(false);
  });
});
