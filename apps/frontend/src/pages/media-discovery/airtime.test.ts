import { afterEach, describe, expect, it } from 'vitest';
import { setDisplayTimezone } from '@/lib/format';
import { formatMonthYear } from '@/lib/format';
import { describeAir, groupByReleaseMonth, nextRelease, releaseMonthKey } from './airtime';

/**
 * Two kinds of date, and only one may be converted.
 *
 * `airsAt` is an instant the provider stated and localises correctly.
 * `date` is the network's local calendar date; treating it as an instant moves
 * it a day for every viewer west of UTC — quietly, so nobody notices the show
 * appears to air a day early.
 */

afterEach(() => setDisplayTimezone(null));

describe('choosing which release to show', () => {
  it('takes the soonest dated release', () => {
    const chosen = nextRelease([
      { releaseType: 'finale', date: '2026-12-20' },
      { releaseType: 'series_premiere', date: '2026-11-15' },
      { releaseType: 'episode_air', date: '2026-11-22' },
    ]);
    expect(chosen?.releaseType).toBe('series_premiere');
  });

  it('ignores releases with no date at all', () => {
    const chosen = nextRelease([
      { releaseType: 'unknown', date: null },
      { releaseType: 'episode_air', date: '2026-11-22' },
    ]);
    expect(chosen?.releaseType).toBe('episode_air');
  });

  it.each([[[]], [undefined]])('returns nothing for %s', (input) => {
    expect(nextRelease(input as never)).toBeNull();
  });

  it('prefers an exact instant over a bare date when ordering', () => {
    const chosen = nextRelease([
      { releaseType: 'episode_air', date: '2026-11-22', airsAt: '2026-11-22T02:00:00.000Z' },
      { releaseType: 'finale', date: '2026-11-21' },
    ]);
    expect(chosen?.releaseType).toBe('finale');
  });
});

describe('an instant is shown in local time', () => {
  /*
   * TVmaze publishes 9pm US Eastern as 01:00 the NEXT day in UTC. A viewer in
   * Puerto Rico must see the 15th at 9pm, not the 16th at 1am.
   */
  const primetime = { releaseType: 'episode_air', date: '2026-11-15', airsAt: '2026-11-16T01:00:00.000Z' };

  it('renders the viewer local day and clock time', () => {
    setDisplayTimezone('America/Puerto_Rico');
    const air = describeAir(primetime)!;
    expect(air.hasTime).toBe(true);
    expect(air.when).toContain('15');
    expect(air.when).toMatch(/9|21/);
  });

  it('moves with the viewer timezone, because it is a real instant', () => {
    setDisplayTimezone('Asia/Tokyo');
    const tokyo = describeAir(primetime)!.when;
    setDisplayTimezone('America/Los_Angeles');
    const la = describeAir(primetime)!.when;
    expect(tokyo).not.toBe(la);
  });

  it('carries a relative time', () => {
    setDisplayTimezone('UTC');
    expect(describeAir(primetime)!.relative).toBeTruthy();
  });
});

describe('a calendar date is shown as the day it says', () => {
  const dateOnly = { releaseType: 'series_premiere', date: '2026-11-15', airsAt: null };

  /* THE regression: no clock time may be invented from a date-only value. */
  it('shows no clock time', () => {
    setDisplayTimezone('America/Puerto_Rico');
    const air = describeAir(dateOnly)!;
    expect(air.hasTime).toBe(false);
    expect(air.when).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it.each(['America/Puerto_Rico', 'America/Los_Angeles', 'UTC', 'Asia/Tokyo'])(
    'shows the same day in %s, never sliding back one',
    (zone) => {
      setDisplayTimezone(zone);
      const when = describeAir(dateOnly)!.when;
      expect(when).toContain('15');
      expect(when).not.toContain('14');
    },
  );

  it('still offers a relative time, which is only precise to the day', () => {
    setDisplayTimezone('UTC');
    expect(describeAir(dateOnly)!.relative).toBeTruthy();
  });
});

describe('nothing to say', () => {
  it.each([null, undefined])('returns null for %s', (input) => {
    expect(describeAir(input as never)).toBeNull();
  });

  it('returns null when the release has neither a date nor an instant', () => {
    expect(describeAir({ releaseType: 'unknown', date: null })).toBeNull();
  });
});

describe('the month a release is filed under', () => {
  it('reads a calendar date straight off the date', () => {
    expect(releaseMonthKey({ releaseType: 'series_premiere', date: '2026-09-20' })).toBe('2026-09');
  });

  /*
   * Never converted. Midnight UTC on 1 October is 30 September in Puerto Rico,
   * and a date-only premiere must not slide into the previous month for it.
   */
  it('does not shift a calendar date across a month boundary for a viewer west of UTC', () => {
    setDisplayTimezone('America/Puerto_Rico');
    expect(releaseMonthKey({ releaseType: 'series_premiere', date: '2026-10-01' })).toBe('2026-10');
  });

  /*
   * 9pm Eastern on 31 October is stamped 01:00 UTC on 1 November. The card prints
   * the 31st, so the heading above it must say October.
   */
  it('places an instant in the viewer month, matching the date on the card', () => {
    const halloween = { releaseType: 'episode_air', date: '2026-10-31', airsAt: '2026-11-01T01:00:00.000Z' };
    setDisplayTimezone('America/Puerto_Rico');
    expect(releaseMonthKey(halloween)).toBe('2026-10');
    setDisplayTimezone('UTC');
    expect(releaseMonthKey(halloween)).toBe('2026-11');
  });

  it('has no month for a release with no date', () => {
    expect(releaseMonthKey({ releaseType: 'unknown', date: null })).toBeNull();
    expect(releaseMonthKey(null)).toBeNull();
  });

  /*
   * The key is already a calendar month. Formatting its first instant in the
   * viewer's zone would print August for September anywhere west of UTC.
   */
  it('names the month with its year, without sliding it back a month west of UTC', () => {
    setDisplayTimezone('America/Puerto_Rico');
    const label = formatMonthYear('2026-09');
    expect(label).toContain('2026');
    // "September" / "septiembre" — never August, which is what a converted instant prints here.
    expect(label).toMatch(/sep/i);
    expect(formatMonthYear('not-a-month')).toBe('not-a-month');
  });
});

describe('grouping titles by release month', () => {
  const show = (title: string, date: string | null, airsAt?: string) => ({
    title,
    release: date || airsAt ? { releaseType: 'series_premiere', date, airsAt } : null,
  });
  const group = (items: ReturnType<typeof show>[]) =>
    groupByReleaseMonth(items, (i) => i.release).map((g) => [g.key, g.items.map((i) => i.title)]);

  it('files each title under its month, keeping the order it arrived in', () => {
    expect(
      group([
        show('Neagley', '2026-09-16'),
        show('Youth', '2026-09-20'),
        show('War', '2026-10-01'),
        show('Dig', '2026-11-23'),
      ]),
    ).toEqual([
      ['2026-09', ['Neagley', 'Youth']],
      ['2026-10', ['War']],
      ['2026-11', ['Dig']],
    ]);
  });

  /*
   * The server orders by instant; the heading is a local month. A 9pm premiere on
   * 31 October sorts AFTER a date-only 1 November — and must still be shown
   * under one October heading placed before November, not as Nov / Oct / Nov.
   */
  it('keeps one heading per month, in calendar order, when instants and dates interleave', () => {
    setDisplayTimezone('America/Puerto_Rico');
    expect(
      group([
        show('Early November', '2026-11-01'),
        show('Halloween Night', '2026-10-31', '2026-11-01T01:00:00.000Z'),
        show('Mid November', '2026-11-12'),
      ]),
    ).toEqual([
      ['2026-10', ['Halloween Night']],
      ['2026-11', ['Early November', 'Mid November']],
    ]);
  });

  it('puts titles with no announced date last', () => {
    expect(group([show('Unannounced', null), show('Carrie', '2026-10-07')])).toEqual([
      ['2026-10', ['Carrie']],
      [null, ['Unannounced']],
    ]);
  });

  it('returns no groups for no titles', () => {
    expect(groupByReleaseMonth([], () => null)).toEqual([]);
  });
});
