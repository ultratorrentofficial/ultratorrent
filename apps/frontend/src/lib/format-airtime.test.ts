import { afterEach, describe, expect, it } from 'vitest';
import { formatCalendarDate, setDisplayTimezone } from './format';

/**
 * A calendar date is not an instant.
 *
 * `2026-11-15` parsed as a Date is UTC midnight, and rendering that in any
 * negative-offset zone shows 14 November. Every viewer of this product is in
 * one — which is exactly how an air date silently slips a day.
 */
describe('formatCalendarDate', () => {
  const zones = ['America/Puerto_Rico', 'America/Los_Angeles', 'UTC', 'Asia/Tokyo'];

  it.each(zones)('shows the same calendar day in %s', (zone) => {
    setDisplayTimezone(zone);
    expect(formatCalendarDate('2026-11-15')).toContain('15');
    expect(formatCalendarDate('2026-11-15')).toContain('Nov');
  });

  /* The specific regression: UTC-4 must not roll back to the 14th. */
  it('does not roll a date backwards west of UTC', () => {
    setDisplayTimezone('America/Puerto_Rico');
    expect(formatCalendarDate('2026-01-01')).toContain('2026');
    expect(formatCalendarDate('2026-01-01')).not.toContain('31');
  });

  it('accepts a full timestamp by using only its date part', () => {
    setDisplayTimezone('UTC');
    expect(formatCalendarDate('2026-11-15T04:00:00.000Z')).toContain('15');
  });

  it.each([null, undefined, ''])('renders %s as a dash', (input) => {
    expect(formatCalendarDate(input as never)).toBe('—');
  });

  it('does not throw on malformed input', () => {
    expect(() => formatCalendarDate('not-a-date')).not.toThrow();
  });

  afterEach(() => setDisplayTimezone(null));
});
