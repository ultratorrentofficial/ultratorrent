import { describe, expect, it } from 'vitest';
import { isInside, stagingSuggestionFor } from './staging-path';

/**
 * Switching a rule to managed intake turned a working rule into a rejected one:
 * the save path arrives holding the library folder — what every pre-intake rule
 * had — and the server refuses that pair, because intake would import the
 * library back into itself and duplicate every episode.
 *
 * The refusal is right. Making the operator derive the replacement by hand is
 * not, since the answer follows from the profile.
 */
const LIBS = ['/downloads/TV Shows', '/downloads/Movies'];
const suggest = (over: Partial<Parameters<typeof stagingSuggestionFor>[0]> = {}) =>
  stagingSuggestionFor({
    importMode: 'managed_intake',
    savePath: '/downloads/TV Shows/Lanterns (2026)',
    stagingRoot: '/downloads/Intake/TV Shows',
    libraryPaths: LIBS,
    ...over,
  });

describe('stagingSuggestionFor', () => {
  it('moves a library path under staging, keeping the show folder', () => {
    expect(suggest()).toBe('/downloads/Intake/TV Shows/Lanterns (2026)');
  });

  it('suggests nothing when the path is already staged', () => {
    expect(suggest({ savePath: '/downloads/Intake/TV Shows/Lanterns (2026)' })).toBeNull();
    // Trailing slashes are the same path, not a different one.
    expect(suggest({ savePath: '/downloads/Intake/TV Shows/' , stagingRoot: '/downloads/Intake/TV Shows' })).toBeNull();
  });

  it('leaves a path that is in no library alone', () => {
    // Somewhere else entirely is the operator's business; rewriting it would be
    // presumptuous rather than helpful.
    expect(suggest({ savePath: '/downloads/complete/Lanterns' })).toBeNull();
  });

  it('says nothing for a rule that is not managed', () => {
    expect(suggest({ importMode: 'legacy_direct' })).toBeNull();
  });

  it('says nothing when no profile is chosen yet', () => {
    expect(suggest({ stagingRoot: null })).toBeNull();
    expect(suggest({ stagingRoot: '' })).toBeNull();
  });

  it('says nothing when there is no path to move', () => {
    expect(suggest({ savePath: '' })).toBeNull();
  });
});

describe('isInside', () => {
  it('does not treat a sibling with a shared prefix as nested', () => {
    // "/downloads/TV Shows Archive" is not inside "/downloads/TV Shows".
    expect(isInside('/downloads/TV Shows Archive/X', '/downloads/TV Shows')).toBe(false);
    expect(isInside('/downloads/TV Shows/X', '/downloads/TV Shows')).toBe(true);
    expect(isInside('/downloads/TV Shows', '/downloads/TV Shows')).toBe(true);
  });
});
