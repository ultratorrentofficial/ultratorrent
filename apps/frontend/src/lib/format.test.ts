import { describe, expect, it } from 'vitest';
import { formatCountdown } from './format';

/**
 * The Trash retention countdown. The point of this format is that it VISIBLY ticks,
 * so the seconds field must always be present and zero-padded — a value that reads
 * "2d" for two days tells an operator nothing about whether a file is about to go.
 */
describe('formatCountdown', () => {
  const sec = 1000;
  const min = 60 * sec;
  const hour = 60 * min;
  const day = 24 * hour;

  it('renders days alongside a zero-padded clock', () => {
    expect(formatCountdown(3 * day + 4 * hour + 5 * min + 6 * sec)).toBe('3d 04:05:06');
  });

  it('drops the day field under 24 hours', () => {
    expect(formatCountdown(4 * hour + 5 * min + 6 * sec)).toBe('04:05:06');
  });

  it('pads every field', () => {
    expect(formatCountdown(1 * sec)).toBe('00:00:01');
  });

  it('keeps a full day as a day rather than 24 hours', () => {
    expect(formatCountdown(day)).toBe('1d 00:00:00');
  });

  it('returns null at or past zero so callers must handle expiry explicitly', () => {
    expect(formatCountdown(0)).toBeNull();
    expect(formatCountdown(-5 * sec)).toBeNull();
  });

  it('returns null for absent or non-finite input', () => {
    expect(formatCountdown(null)).toBeNull();
    expect(formatCountdown(undefined)).toBeNull();
    expect(formatCountdown(Number.NaN)).toBeNull();
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
