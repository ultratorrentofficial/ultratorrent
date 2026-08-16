import { nextRunAt, fromZonedTime } from './newsletter-schedule';

/**
 * The schedule these replace was `lastSend + 7 days`, stamped at completion.
 * Nothing named a weekday or a time, so a live pair of newsletters had settled
 * on "Friday 16:04 UTC" — the echo of someone pressing Send once — and drifted
 * later every week.
 *
 * `America/Puerto_Rico` is the hosts' zone (AST, UTC−4, no DST).
 * `America/New_York` is used for the DST cases because it has them.
 */
const AST = 'America/Puerto_Rico';
const NY = 'America/New_York';

const at = (iso: string) => new Date(iso);
const weekly = (over: Record<string, unknown> = {}) => ({
  frequency: 'weekly', sendWeekday: 0, sendHour: 9, sendMinute: 0, timezone: AST, ...over,
});

describe('nextRunAt', () => {
  it('lands on the chosen weekday at the chosen LOCAL time', () => {
    // Thursday 2026-08-13 12:00 UTC → Sunday 09:00 AST = 13:00 UTC.
    const next = nextRunAt(weekly(), at('2026-08-13T12:00:00Z'))!;
    expect(next.toISOString()).toBe('2026-08-16T13:00:00.000Z');
  });

  it('does not treat the container clock as local', () => {
    /*
     * The containers run UTC while the hosts are AST. An hour taken at face
     * value would schedule 09:00 UTC — 05:00 in the morning for the operator.
     */
    const utc = nextRunAt(weekly({ timezone: 'UTC' }), at('2026-08-13T12:00:00Z'))!;
    const ast = nextRunAt(weekly(), at('2026-08-13T12:00:00Z'))!;
    expect(utc.toISOString()).toBe('2026-08-16T09:00:00.000Z');
    expect(ast.getTime() - utc.getTime()).toBe(4 * 3600 * 1000);
  });

  it('skips to next week when today is the day but the time has passed', () => {
    // Sunday 2026-08-16 14:00 UTC = 10:00 AST, past the 09:00 slot.
    const next = nextRunAt(weekly(), at('2026-08-16T14:00:00Z'))!;
    expect(next.toISOString()).toBe('2026-08-23T13:00:00.000Z');
  });

  it('uses today when the slot is still ahead', () => {
    // Sunday 2026-08-16 11:00 UTC = 07:00 AST, before 09:00.
    const next = nextRunAt(weekly(), at('2026-08-16T11:00:00Z'))!;
    expect(next.toISOString()).toBe('2026-08-16T13:00:00.000Z');
  });

  it('does not drift: the slot is the same however late the previous run was', () => {
    // The old rule stamped "now + 7 days" at completion, so every slow send
    // pushed the next one later for good.
    const onTime = nextRunAt(weekly(), at('2026-08-16T13:00:01Z'))!;
    const late = nextRunAt(weekly(), at('2026-08-16T13:47:00Z'))!;
    expect(onTime.toISOString()).toBe(late.toISOString());
    expect(late.toISOString()).toBe('2026-08-23T13:00:00.000Z');
  });

  it('keeps the legacy cadence when no weekday is chosen', () => {
    // Existing rows migrate with a NULL weekday and must not silently move.
    const from = at('2026-08-13T16:04:00Z');
    const next = nextRunAt(weekly({ sendWeekday: null }), from)!;
    expect(next.getTime() - from.getTime()).toBe(7 * 24 * 3600 * 1000);
  });

  it('handles daily', () => {
    // 09:00Z is 05:00 AST — the 06:30 slot is still ahead today.
    expect(nextRunAt({ frequency: 'daily', sendHour: 6, sendMinute: 30, timezone: AST },
      at('2026-08-16T09:00:00Z'))!.toISOString()).toBe('2026-08-16T10:30:00.000Z');
    // 11:00Z is 07:00 AST — already past, so tomorrow.
    expect(nextRunAt({ frequency: 'daily', sendHour: 6, sendMinute: 30, timezone: AST },
      at('2026-08-16T11:00:00Z'))!.toISOString()).toBe('2026-08-17T10:30:00.000Z');
  });

  it('returns null for a manual newsletter', () => {
    expect(nextRunAt({ frequency: 'manual', sendWeekday: 0 }, at('2026-08-16T12:00:00Z'))).toBeNull();
  });

  it('keeps the local hour across a DST change', () => {
    // 09:00 in New York is 13:00 UTC in EDT and 14:00 UTC in EST. An operator
    // who asked for 9am means 9am in both.
    const summer = nextRunAt({ frequency: 'weekly', sendWeekday: 0, sendHour: 9, sendMinute: 0, timezone: NY },
      at('2026-07-01T00:00:00Z'))!;
    const winter = nextRunAt({ frequency: 'weekly', sendWeekday: 0, sendHour: 9, sendMinute: 0, timezone: NY },
      at('2026-12-01T00:00:00Z'))!;
    expect(summer.toISOString().slice(11, 16)).toBe('13:00');
    expect(winter.toISOString().slice(11, 16)).toBe('14:00');
  });

  it('falls back to UTC for an unknown zone rather than never sending', () => {
    const next = nextRunAt(weekly({ timezone: 'Mars/Olympus' }), at('2026-08-13T12:00:00Z'))!;
    expect(next.toISOString()).toBe('2026-08-16T09:00:00.000Z');
  });

  it('clamps nonsense hours instead of producing an invalid date', () => {
    const next = nextRunAt(weekly({ sendHour: 99, sendMinute: -5 }), at('2026-08-13T12:00:00Z'))!;
    expect(Number.isNaN(next.getTime())).toBe(false);
    expect(next.toISOString()).toBe('2026-08-17T03:00:00.000Z'); // 23:00 AST Sunday
  });
});

describe('fromZonedTime', () => {
  it('resolves a wall-clock time to the right instant', () => {
    expect(fromZonedTime(2026, 8, 16, 9, 0, AST).toISOString()).toBe('2026-08-16T13:00:00.000Z');
    expect(fromZonedTime(2026, 1, 15, 9, 0, NY).toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(fromZonedTime(2026, 7, 15, 9, 0, NY).toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });
});
