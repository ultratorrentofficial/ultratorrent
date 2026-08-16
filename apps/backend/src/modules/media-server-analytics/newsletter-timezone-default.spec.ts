import { nextRunAt } from './newsletter-schedule';

/**
 * A schedule with no zone must be read in the OPERATOR's time, not the
 * container's.
 *
 * The containers run UTC while the hosts are AST, so a newsletter set to
 * "Friday 12:00" with the old UTC default was scheduled for 08:00 local — and
 * the setting looked correct on screen. Two live newsletters were sending four
 * hours early for exactly this reason.
 *
 * `timezone` is now nullable: NULL means "no explicit choice" and the service
 * resolves it to `app.timezone` before scheduling. These pin the arithmetic
 * that makes the difference visible.
 */
const AST = 'America/Puerto_Rico';
const from = new Date('2026-08-16T12:00:00Z');
const weekly = (timezone: string) => ({ frequency: 'weekly', sendWeekday: 5, sendHour: 12, sendMinute: 0, timezone });

describe('the zone a schedule is read in', () => {
  it('noon local is four hours later than noon UTC here', () => {
    const utc = nextRunAt(weekly('UTC'), from)!;
    const local = nextRunAt(weekly(AST), from)!;

    expect(utc.toISOString()).toBe('2026-08-21T12:00:00.000Z');   // 08:00 local — the bug
    expect(local.toISOString()).toBe('2026-08-21T16:00:00.000Z'); // 12:00 local — intended
    expect(local.getTime() - utc.getTime()).toBe(4 * 3600 * 1000);
  });

  it('reads noon in the resolved zone whatever the process clock is', () => {
    // The container's TZ is UTC; that must not decide an operator's schedule.
    const resolved = nextRunAt(weekly(AST), from)!;
    const hourInAst = new Intl.DateTimeFormat('en-US', {
      timeZone: AST, hour: '2-digit', hour12: false,
    }).format(resolved);
    expect(Number(hourInAst)).toBe(12);
  });

  it('still lands on the chosen weekday in that zone', () => {
    const resolved = nextRunAt(weekly(AST), from)!;
    const day = new Intl.DateTimeFormat('en-US', { timeZone: AST, weekday: 'short' }).format(resolved);
    expect(day).toBe('Fri');
  });
});
