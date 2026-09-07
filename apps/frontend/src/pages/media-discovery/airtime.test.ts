import { afterEach, describe, expect, it } from 'vitest';
import { setDisplayTimezone } from '@/lib/format';
import { describeAir, nextRelease } from './airtime';

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
