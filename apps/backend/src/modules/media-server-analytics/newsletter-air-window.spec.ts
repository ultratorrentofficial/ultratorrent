import { airWindow } from './newsletter-schedule';

/**
 * The FORWARD window, which is a different question from every other window on
 * a newsletter: not "what was added since", but "what starts airing next".
 *
 * Both modes are tested against wall-clock boundaries rather than millisecond
 * arithmetic, because that is the whole difficulty — a week is seven *local
 * days*, which is not always 168 hours.
 */

/** The local wall-clock reading of an instant, for asserting a boundary. */
const local = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);

/** UTC-4 all year: no transition to confuse a boundary. */
const PR = 'America/Puerto_Rico';
/** Observes DST — the only way to prove the week is not 7×24h. */
const NY = 'America/New_York';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

// 2026-10-02 is a Friday. 13:00 in Puerto Rico is 17:00 UTC.
const FRIDAY_1PM = new Date('2026-10-02T17:00:00Z');

describe('airWindow — next_days (rolling)', () => {
  it('runs the configured number of days forward from the send moment', () => {
    const w = airWindow({ airWindowMode: 'next_days', airWindowDays: 7, timezone: PR }, FRIDAY_1PM);
    expect(w.from).toEqual(FRIDAY_1PM);
    expect(w.to.getTime() - w.from.getTime()).toBe(7 * DAY);
  });

  /*
   * The rolling window's defining property, and the reason it is offered beside
   * the calendar one: a premiere two days after a Friday send is inside it.
   */
  it('includes a premiere the following day', () => {
    const w = airWindow({ airWindowMode: 'next_days', airWindowDays: 7, timezone: PR }, FRIDAY_1PM);
    const saturday = new Date('2026-10-03T18:00:00Z');
    expect(saturday >= w.from && saturday < w.to).toBe(true);
  });

  it('is the default when no mode is stored', () => {
    const w = airWindow({ airWindowDays: 3, timezone: PR }, FRIDAY_1PM);
    expect(w.to.getTime() - w.from.getTime()).toBe(3 * DAY);
  });

  it('never produces an empty or backwards window', () => {
    for (const days of [0, -5, undefined]) {
      const w = airWindow({ airWindowMode: 'next_days', airWindowDays: days, timezone: PR }, FRIDAY_1PM);
      expect(w.to.getTime()).toBeGreaterThan(w.from.getTime());
    }
  });
});

describe('airWindow — next_calendar_week (Mon–Sun of the following week)', () => {
  it('starts on the next Monday at local midnight', () => {
    const w = airWindow({ airWindowMode: 'next_calendar_week', timezone: PR }, FRIDAY_1PM);
    expect(local(w.from, PR)).toContain('Mon');
    expect(local(w.from, PR)).toContain('10/05/2026');
    expect(local(w.from, PR)).toContain('00:00');
  });

  it('ends on the Monday after that, so Sunday is the last day covered', () => {
    const w = airWindow({ airWindowMode: 'next_calendar_week', timezone: PR }, FRIDAY_1PM);
    expect(local(w.to, PR)).toContain('Mon');
    expect(local(w.to, PR)).toContain('10/12/2026');
    // Exclusive: a premiere at the boundary belongs to the next issue.
    const sundayLate = new Date('2026-10-12T03:59:00Z'); // 23:59 Sun 11 Oct in PR
    expect(sundayLate < w.to).toBe(true);
  });

  /*
   * The boundary a rolling window would have caught and this one does not. It
   * is a real consequence of the mode rather than a bug, so it is pinned.
   */
  it('does NOT cover the gap between the send and that Monday', () => {
    const w = airWindow({ airWindowMode: 'next_calendar_week', timezone: PR }, FRIDAY_1PM);
    const saturday = new Date('2026-10-03T18:00:00Z');
    expect(saturday < w.from).toBe(true);
  });

  it('treats a Sunday send as one day from the week it announces', () => {
    const sunday = new Date('2026-10-04T17:00:00Z'); // Sun 4 Oct, 13:00 PR
    const w = airWindow({ airWindowMode: 'next_calendar_week', timezone: PR }, sunday);
    expect(local(w.from, PR)).toContain('10/05/2026');
  });

  /*
   * A Monday send announces NEXT Monday, not the week it is already inside —
   * otherwise the issue would describe days that have already happened.
   */
  it('does not announce the week a Monday send is already in', () => {
    const monday = new Date('2026-10-05T17:00:00Z'); // Mon 5 Oct, 13:00 PR
    const w = airWindow({ airWindowMode: 'next_calendar_week', timezone: PR }, monday);
    expect(local(w.from, PR)).toContain('10/12/2026');
  });

  it('is 168 hours in a zone with no transition', () => {
    const w = airWindow({ airWindowMode: 'next_calendar_week', timezone: PR }, FRIDAY_1PM);
    expect(w.to.getTime() - w.from.getTime()).toBe(168 * HOUR);
  });

  /*
   * THE case the day-arithmetic exists for. US DST ends Sunday 1 Nov 2026, so
   * the week of Mon 26 Oct contains the transition and is 169 real hours long.
   * Adding 168 hours to local midnight would land at 23:00 the previous day,
   * and reading that back as a date would truncate the week by a full day.
   */
  it('stays a whole week across a DST transition', () => {
    const friday = new Date('2026-10-23T17:00:00Z'); // Fri 23 Oct, 13:00 EDT
    const w = airWindow({ airWindowMode: 'next_calendar_week', timezone: NY }, friday);
    expect(local(w.from, NY)).toContain('10/26/2026');
    expect(local(w.from, NY)).toContain('00:00');
    expect(local(w.to, NY)).toContain('11/02/2026');
    expect(local(w.to, NY)).toContain('00:00');
    expect(w.to.getTime() - w.from.getTime()).toBe(169 * HOUR);
  });

  it('crosses a month end without special casing', () => {
    const friday = new Date('2026-10-30T17:00:00Z'); // Fri 30 Oct
    const w = airWindow({ airWindowMode: 'next_calendar_week', timezone: PR }, friday);
    expect(local(w.from, PR)).toContain('11/02/2026');
    expect(local(w.to, PR)).toContain('11/09/2026');
  });
});

describe('airWindow — a zone that cannot be resolved', () => {
  /*
   * An unknown zone must not stop a newsletter from ever sending, which is the
   * same rule `nextRunAt` already follows.
   */
  it('falls back instead of throwing', () => {
    expect(() =>
      airWindow({ airWindowMode: 'next_calendar_week', timezone: 'Mars/Olympus' }, FRIDAY_1PM),
    ).not.toThrow();
    const w = airWindow({ airWindowMode: 'next_calendar_week', timezone: null }, FRIDAY_1PM);
    expect(w.to.getTime()).toBeGreaterThan(w.from.getTime());
  });
});
