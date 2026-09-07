import { describe, expect, it } from 'vitest';
import { cleanQuality, fromBytes, joinTerms, move, parseTerms, renumber, toBytes } from './ladder';

/**
 * The parts of the ladder editor that are easy to get quietly wrong.
 *
 * Unit conversion and reordering both fail silently when they fail: a size limit
 * off by a factor of 1024 rejects everything, and a reorder that drops a rung
 * loses a preference nobody notices until a download does not happen.
 */

describe('size limits', () => {
  it('round-trips a value somebody typed', () => {
    expect(fromBytes(toBytes('4'))).toBe('4');
    expect(fromBytes(toBytes('12.5'))).toBe('12.5');
  });

  it('converts gigabytes to bytes the API expects', () => {
    expect(toBytes('1')).toBe(1024 ** 3);
    expect(toBytes(8)).toBe(8 * 1024 ** 3);
  });

  /*
   * Empty means "no limit", not zero. A zero maximum would reject every release,
   * which is the opposite of leaving the box blank.
   */
  it.each(['', null, undefined, 'not a number', '0', '-3'])('treats %s as no limit', (input) => {
    expect(toBytes(input as never)).toBeUndefined();
  });

  it('renders an unset limit as an empty box, not a zero', () => {
    expect(fromBytes(undefined)).toBe('');
    expect(fromBytes(null)).toBe('');
    expect(fromBytes(0)).toBe('');
  });

  it('does not render floating-point noise for a round number', () => {
    expect(fromBytes(4 * 1024 ** 3)).toBe('4');
  });
});

describe('reordering the ladder', () => {
  const ladder = ['2160p', '1080p x265', '1080p x264'];

  it('moves a rung up', () => {
    expect(move(ladder, 1, 0)).toEqual(['1080p x265', '2160p', '1080p x264']);
  });

  it('moves a rung down', () => {
    expect(move(ladder, 0, 1)).toEqual(['1080p x265', '2160p', '1080p x264']);
  });

  it('never loses or duplicates a rung', () => {
    const moved = move(ladder, 2, 0);
    expect(moved).toHaveLength(ladder.length);
    expect([...moved].sort()).toEqual([...ladder].sort());
  });

  /* The end buttons are disabled; a slip through them must not throw. */
  it.each([
    [0, -1],
    [2, 3],
    [-1, 0],
    [5, 0],
  ])('is a no-op for an out-of-range move (%i → %i)', (from, to) => {
    expect(move(ladder, from, to)).toEqual(ladder);
  });

  it('does not mutate the array it was given', () => {
    const original = [...ladder];
    move(ladder, 0, 2);
    expect(ladder).toEqual(original);
  });

  /*
   * Position IS priority. Exposing a number as well would be two sources of
   * truth that can disagree.
   */
  it('renumbers from zero, closing gaps an older template left', () => {
    expect(renumber([{ priorityOrder: 5 }, { priorityOrder: 9 }, { priorityOrder: 40 }]))
      .toEqual([{ priorityOrder: 0 }, { priorityOrder: 1 }, { priorityOrder: 2 }]);
  });
});

describe('terms', () => {
  it('trims and drops empties', () => {
    expect(parseTerms(' DV , , Atmos ')).toEqual(['DV', 'Atmos']);
  });

  it('de-duplicates', () => {
    expect(parseTerms('CAM, CAM, TS')).toEqual(['CAM', 'TS']);
  });

  it('round-trips', () => {
    expect(parseTerms(joinTerms(['WEB-DL', 'DV']))).toEqual(['WEB-DL', 'DV']);
  });

  it('reads an empty box as no terms', () => {
    expect(parseTerms('')).toEqual([]);
    expect(parseTerms('   ,  ')).toEqual([]);
  });
});

describe('quality rules', () => {
  /*
   * `{ resolution: '' }` would be sent as a rule and matched against, so a
   * cleared select must disappear rather than becoming an empty constraint.
   */
  it('drops a cleared field rather than sending an empty rule', () => {
    expect(cleanQuality({ resolution: '2160p', source: '', codec: '   ' })).toEqual({ resolution: '2160p' });
  });

  it('sends nothing when every field is cleared', () => {
    expect(cleanQuality({ resolution: '', source: '' })).toEqual({});
  });
});
