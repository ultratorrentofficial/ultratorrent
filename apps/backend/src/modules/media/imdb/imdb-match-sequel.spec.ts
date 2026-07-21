import { titlesAreSequelVariants } from './imdb-match';

/**
 * A film and its same-year sequel differ by only a trailing number, which title
 * similarity + year cannot separate. Observed live: "Ultimate Avengers" (2006) and
 * "Ultimate Avengers 2" (2006) were matched to one id.
 */
describe('titlesAreSequelVariants', () => {
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
