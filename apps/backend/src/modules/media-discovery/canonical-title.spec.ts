import { canonicalizeTitle, sameCanonicalTitle, splitTrailingYear } from '@ultratorrent/shared';

/**
 * Canonical title and year.
 *
 * Two failure modes matter here and they pull in opposite directions. Stripping
 * too little is the bug that shipped: "The Terminal List" and "The Terminal List
 * (2022)" became two monitored shows. Stripping too much is worse and quieter —
 * "Blade Runner 2049" and "2012" are titles whose numbers are the title, and
 * folding them into a year would merge unrelated works.
 */

describe('the duplicates that caused this', () => {
  it('resolves the four ways a provider writes The Terminal List', () => {
    const forms = [
      'The Terminal List',
      'The Terminal List (2022)',
      'THE TERMINAL LIST',
      'The.Terminal.List.2022',
    ];
    const canon = forms.map((f) => canonicalizeTitle(f));
    for (const c of canon) expect(c.normalizedTitle).toBe('the terminal list');
    // Every pair names the same work.
    for (const a of canon) for (const b of canon) expect(sameCanonicalTitle(a, b)).toBe(true);
  });

  it('resolves Tulsa King with and without its year', () => {
    const bare = canonicalizeTitle('Tulsa King');
    const dated = canonicalizeTitle('Tulsa King (2022)');
    expect(dated.year).toBe(2022);
    expect(bare.year).toBeNull();
    expect(sameCanonicalTitle(bare, dated)).toBe(true);
  });

  it('lifts the year out rather than leaving it in the comparison key', () => {
    expect(canonicalizeTitle('Tulsa King (2022)')).toEqual({
      title: 'Tulsa King',
      normalizedTitle: 'tulsa king',
      year: 2022,
    });
  });
});

describe('titles whose numbers are part of the name', () => {
  /*
   * The reason this is not a blanket "strip trailing digits". Each of these has
   * the shape of a year suffix and is not one.
   */
  it.each([
    ['Blade Runner 2049', 'blade runner 2049'],
    ['2012', '2012'],
    ['Fahrenheit 451', 'fahrenheit 451'],
    ['Apollo 13', 'apollo 13'],
    ['Space 1999', 'space 1999'],
    ['1923', '1923'],
    ['1883', '1883'],
  ])('keeps the number in %s', (raw, normalized) => {
    const c = canonicalizeTitle(raw);
    expect(c.normalizedTitle).toBe(normalized);
    expect(c.year).toBeNull();
  });

  /*
   * "1923" is a real Paramount+ series AND a plausible year. A provider giving
   * it a structured year must not have its title eaten.
   */
  it('does not devour a title that is itself a year, even with a known year', () => {
    const c = canonicalizeTitle('1923', 2022);
    expect(c.title).toBe('1923');
    expect(c.normalizedTitle).toBe('1923');
    expect(c.year).toBe(2022);
  });

  it('strips only the suffix from a title that also contains a number', () => {
    const c = canonicalizeTitle("Ocean's 11 (2001)");
    expect(c.normalizedTitle).toBe('ocean s 11');
    expect(c.year).toBe(2001);
  });

  it('does not treat a parenthesised year alone as a title', () => {
    // Nothing would remain, and every such title would collide with every other.
    expect(splitTrailingYear('(2012)')).toEqual({ title: '(2012)', year: null });
  });
});

describe('which evidence wins', () => {
  it("prefers the provider's structured year over one parsed from the title", () => {
    // A disagreement is the provider's to settle; the display string is weaker.
    expect(canonicalizeTitle('Some Show (2021)', 2022).year).toBe(2022);
  });

  it('fills a missing year from the title', () => {
    expect(canonicalizeTitle('Some Show (2021)').year).toBe(2021);
  });

  it('ignores an implausible year rather than trusting it', () => {
    const c = canonicalizeTitle('Room (1408)');
    expect(c.year).toBeNull();
    expect(c.normalizedTitle).toBe('room 1408');
  });
});

describe('release-name formatting', () => {
  it('reads a dotted release name', () => {
    expect(canonicalizeTitle('The.Terminal.List.2022')).toEqual({
      title: 'The.Terminal.List',
      normalizedTitle: 'the terminal list',
      year: 2022,
    });
  });

  /*
   * A plain space before a trailing number is NOT release formatting — that is
   * the exact shape of "Blade Runner 2049".
   */
  it('does not read a space-separated trailing number as a year', () => {
    expect(splitTrailingYear('Blade Runner 2049')).toEqual({ title: 'Blade Runner 2049', year: null });
  });
});

describe('comparing identities', () => {
  it('treats a missing year as missing information, not a mismatch', () => {
    expect(sameCanonicalTitle({ normalizedTitle: 'silo' }, { normalizedTitle: 'silo', year: 2023 })).toBe(true);
  });

  /*
   * Two different years ARE a contradiction. This is what keeps the three 2026
   * films called "The Odyssey" apart from a 1997 one.
   */
  it('treats two different years as different works', () => {
    expect(
      sameCanonicalTitle({ normalizedTitle: 'the odyssey', year: 1997 }, { normalizedTitle: 'the odyssey', year: 2026 }),
    ).toBe(false);
  });

  it('never matches on an empty normalized title', () => {
    expect(sameCanonicalTitle({ normalizedTitle: '' }, { normalizedTitle: '' })).toBe(false);
  });

  it('folds punctuation, case and diacritics', () => {
    expect(canonicalizeTitle('Amélie & Co.').normalizedTitle).toBe(
      canonicalizeTitle('amelie and co').normalizedTitle,
    );
  });
});
