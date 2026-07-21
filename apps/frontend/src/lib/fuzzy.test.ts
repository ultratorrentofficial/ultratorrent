import { describe, expect, it } from 'vitest';
import { fuzzyBest, fuzzyMatch, fuzzyScore } from './fuzzy';

describe('fuzzyScore', () => {
  it('matches an exact substring and an empty query', () => {
    expect(fuzzyScore('dup', 'Duplicates')).not.toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('MEDIA', 'media items')).not.toBeNull();
  });

  it('matches a scattered subsequence ("sub sync" → Subtitle Sync)', () => {
    expect(fuzzyScore('subsync', 'Subtitle Sync')).not.toBeNull();
    expect(fuzzyScore('rlsscr', 'Release Scoring')).not.toBeNull();
  });

  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyScore('xyz', 'Media Items')).toBeNull();
    expect(fuzzyScore('duplicatez', 'Duplicates')).toBeNull();
  });

  it('ranks a prefix above a mid-word substring', () => {
    const prefix = fuzzyScore('med', 'Media')!;
    const mid = fuzzyScore('med', 'Remedial')!;
    expect(prefix).toBeGreaterThan(mid);
  });

  it('ranks a contiguous substring above a scattered subsequence', () => {
    const contiguous = fuzzyScore('sub', 'Subtitles')!;
    const scattered = fuzzyScore('sub', 'Server Users Bar')!;
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it('prefers a word-boundary start', () => {
    const boundary = fuzzyScore('sync', 'Subtitle Sync')!;
    const embedded = fuzzyScore('sync', 'Resynchronize')!;
    expect(boundary).toBeGreaterThan(embedded);
  });
});

describe('fuzzyBest', () => {
  it('returns the best score across fields, skipping undefined', () => {
    const s = fuzzyBest('dup', 'Media', undefined, 'Duplicates');
    expect(s).not.toBeNull();
    // Best field (Duplicates) beats a no-match field (Media).
    expect(s).toBe(fuzzyScore('dup', 'Duplicates'));
  });

  it('is null when nothing matches', () => {
    expect(fuzzyBest('zzz', 'Media', 'Downloads')).toBeNull();
  });
});

describe('fuzzyMatch', () => {
  it('is a boolean view of fuzzyScore', () => {
    expect(fuzzyMatch('dup', 'Duplicates')).toBe(true);
    expect(fuzzyMatch('zzz', 'Duplicates')).toBe(false);
  });
});
