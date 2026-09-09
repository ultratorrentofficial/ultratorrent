import { performance } from 'node:perf_hooks';
import { canonicalizeTitle } from '@ultratorrent/shared';
import { escapeRegex } from './escape-regex';
import { stripProviderIdTag } from '../modules/media/media-renamer';

/**
 * Regex injection and backtracking.
 *
 * Two classes, one theme: a string that is DATA being treated as a pattern, and
 * a pattern meeting input longer than anyone expected. Both arrive through
 * metadata providers and feeds, which are third parties regardless of how
 * reputable they are.
 *
 * The timing assertions use a deliberately loose budget. The failure they exist
 * to catch is quadratic or worse — hundreds of milliseconds to whole seconds —
 * so a threshold in the hundreds of milliseconds separates a real regression
 * from ordinary CI jitter without becoming flaky.
 */
const BUDGET_MS = 400;

function timed(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('escapeRegex makes a literal match itself', () => {
  it.each([
    ['S.W.A.T.', 'S.W.A.T.'],
    ['Marvel (2019)', 'Marvel (2019)'],
    ['A+B', 'A+B'],
    ['[REC]', '[REC]'],
    ['9-1-1: Lone Star', '9-1-1: Lone Star'],
    ['What If...?', 'What If...?'],
    ['C:\\Path', 'C:\\Path'],
    ['$100', '$100'],
    ['a|b', 'a|b'],
  ])('escapes %s so it matches only itself', (input, literal) => {
    const re = new RegExp(escapeRegex(input), 'i');
    expect(re.test(literal)).toBe(true);
  });

  /* The whole point: `.` must stop matching any character. */
  it('stops a dot from matching an arbitrary character', () => {
    expect(new RegExp(escapeRegex('S.W.A.T.'), 'i').test('SXWXAXTX')).toBe(false);
    expect(new RegExp('S.W.A.T.', 'i').test('SXWXAXTX')).toBe(true); // unescaped, for contrast
  });

  it('escapes in one pass rather than double-escaping a backslash', () => {
    expect(escapeRegex('a\\b')).toBe('a\\\\b');
    expect(new RegExp(escapeRegex('a\\b')).test('a\\b')).toBe(true);
  });

  /* A title crafted to backtrack becomes inert once escaped. */
  it('neutralises a title built to backtrack', () => {
    const hostile = '(a+)+$';
    const subject = `${'a'.repeat(5000)}b`;
    expect(timed(() => {
      new RegExp(escapeRegex(hostile), 'i').test(subject);
    })).toBeLessThan(BUDGET_MS);
  });

  it('handles a non-string without throwing', () => {
    expect(escapeRegex(undefined as never)).toBe('');
    expect(escapeRegex(null as never)).toBe('');
  });
});

describe('canonicalizeTitle stays linear on adversarial titles', () => {
  /*
   * These run on every provider title, every RSS rule name and every library
   * item, so a quadratic path here is reached constantly rather than rarely.
   */
  it.each([
    ['a long run of spaces', `Show${' '.repeat(50_000)}`],
    ['a long run of separators', `Show${'._-'.repeat(20_000)}`],
    ['separators then a bracketed year', `Show${' '.repeat(50_000)}(2022)`],
    ['separators then a bare year', `Show${'.'.repeat(50_000)}2022`],
    ['dots and spaces interleaved', `Show${'. '.repeat(25_000)}`],
    ['a very long plain title', 'A'.repeat(100_000)],
  ])('handles %s within budget', (_label, title) => {
    expect(timed(() => {
      canonicalizeTitle(title);
    })).toBeLessThan(BUDGET_MS);
  });

  /* Bounding the separator run must not change any real answer. */
  // `title` is the DISPLAY form and keeps its punctuation; `normalizedTitle` is
  // the token form. Only the year suffix is lifted out.
  it.each([
    ['The Terminal List (2022)', 'The Terminal List', 2022],
    ['The.Terminal.List.2022', 'The.Terminal.List', 2022],
    ['Blade Runner 2049', 'Blade Runner 2049', null],
    ['1923', '1923', null],
    ['2012', '2012', null],
    ['Tulsa King [2022]', 'Tulsa King', 2022],
    ['S.W.A.T. Exiles', 'S.W.A.T. Exiles', null],
  ])('still canonicalises %s correctly', (input, title, year) => {
    const out = canonicalizeTitle(input);
    expect(out.title).toBe(title);
    expect(out.year).toBe(year);
  });
});

describe('stripProviderIdTag stays linear on adversarial names', () => {
  it.each([
    ['a long run of open brackets', '{'.repeat(50_000)],
    ['bracket-and-space pairs', '{ '.repeat(25_000)],
    ['an unterminated tag', `{tmdbid-${'x'.repeat(50_000)}`],
    ['many partial tags', '{tmdbid-'.repeat(5_000)],
  ])('handles %s within budget', (_label, name) => {
    expect(timed(() => {
      stripProviderIdTag(name);
    })).toBeLessThan(BUDGET_MS);
  });

  /* The bound must not stop it removing a real tag. */
  it.each([
    ['Show {tmdb-1234}', 'Show'],
    ['Show {tmdbid-1234}', 'Show'],
    ['Show [tvdbid=99]', 'Show'],
    ['Show {imdb:tt123}', 'Show'],
  ])('still strips %s', (input, expected) => {
    expect(stripProviderIdTag(input)).toBe(expected);
  });

  it('leaves a name with no tag alone', () => {
    expect(stripProviderIdTag('The Terminal List (2022)')).toBe('The Terminal List (2022)');
  });
});
