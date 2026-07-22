import { titlesAreSequelVariants } from './imdb-match';

/**
 * A film and its same-year sequel differ by only a trailing number, which title
 * similarity + year cannot separate. Observed live: "Ultimate Avengers" (2006) and
 * "Ultimate Avengers 2" (2006) were matched to one id.
 */
describe('titlesAreSequelVariants', () => {
  it('flags a film against its "Part N" continuation', () => {
    // Both 2022 — the year gate cannot separate them, so the sequel gate must.
    expect(
      titlesAreSequelVariants('South Park the Streaming Wars Part 2', 'South Park: The Streaming Wars'),
    ).toBe(true);
    expect(titlesAreSequelVariants('The Godfather Part II', 'The Godfather')).toBe(true);
    expect(titlesAreSequelVariants('Kill Bill Vol. 2', 'Kill Bill Vol. 1')).toBe(true);
    expect(titlesAreSequelVariants('John Wick Chapter 4', 'John Wick Chapter 2')).toBe(true);
  });

  it('does not flag a "Part N" title against itself', () => {
    expect(
      titlesAreSequelVariants('South Park the Streaming Wars Part 2', 'South Park: The Streaming Wars Part 2'),
    ).toBe(false);
    // The qualifier is dropped, so its two spellings still resolve equal.
    expect(titlesAreSequelVariants('The Godfather Part II', 'The Godfather Part 2')).toBe(false);
  });

  it('never strips the qualifier down to an empty base', () => {
    // An empty base would make every qualifier-only title collide with every other.
    expect(titlesAreSequelVariants('Part 2', 'Chapter 3')).toBe(false);
    expect(titlesAreSequelVariants('Volume 1', 'Part 2')).toBe(false);
  });

  it('flags a film against its numbered sequel', () => {
    expect(titlesAreSequelVariants('Ultimate Avengers', 'Ultimate Avengers 2')).toBe(true);
    expect(titlesAreSequelVariants('Ultimate Avengers 2', 'Ultimate Avengers')).toBe(true);
  });

  it('unifies arabic and roman numerals so the SAME film is not flagged', () => {
    // "Rocky 5" (folder) and "Rocky V" (canonical) are the same film.
    expect(titlesAreSequelVariants('Rocky 5', 'Rocky V')).toBe(false);
    // Different sequels stay flagged across notations.
    expect(titlesAreSequelVariants('Rocky V', 'Rocky II')).toBe(true);
    expect(titlesAreSequelVariants('Rocky', 'Rocky V')).toBe(true);
  });

  it('does not flag two spellings of the same numbered title', () => {
    expect(titlesAreSequelVariants('Ultimate Avengers 2', 'Ultimate Avengers 2')).toBe(false);
    expect(titlesAreSequelVariants('Spider-Man 2', 'Spider Man 2')).toBe(false);
  });

  it('does not flag two entirely different titles (no shared base)', () => {
    expect(titlesAreSequelVariants('Ultimate Avengers 2', 'The Dark Knight')).toBe(false);
    // A trailing number that is part of the title, on a different base, is not a
    // sequel conflict.
    expect(titlesAreSequelVariants("Ocean's 8", "Ocean's Eleven")).toBe(false);
  });

  it('treats a title-embedded year-like number as a distinct entry from the base', () => {
    // "Blade Runner 2049" and "Blade Runner" ARE different films — flagging them
    // keeps one from being matched to the other.
    expect(titlesAreSequelVariants('Blade Runner 2049', 'Blade Runner')).toBe(true);
    expect(titlesAreSequelVariants('Blade Runner 2049', 'Blade Runner 2049')).toBe(false);
  });

  it('returns false when neither title carries a trailing number', () => {
    expect(titlesAreSequelVariants('Inception', 'Interstellar')).toBe(false);
    expect(titlesAreSequelVariants('The Maze Runner', 'Maze Runner')).toBe(false);
  });
});
