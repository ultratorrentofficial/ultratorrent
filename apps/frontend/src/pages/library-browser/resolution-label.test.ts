import { describe, expect, it } from 'vitest';
import { resolutionLabel } from './resolution-label';

describe('resolutionLabel', () => {
  it('prefers a filename token when one survived', () => {
    expect(resolutionLabel('2160p', 1920, 1080)).toBe('2160p');
  });

  it('derives from measured dimensions when the token is gone', () => {
    // The common case: the renamer stripped the token, the probe measured the file.
    expect(resolutionLabel(null, 1920, 1080)).toBe('1080p');
    expect(resolutionLabel('', 3840, 2160)).toBe('2160p');
    expect(resolutionLabel(null, 1280, 720)).toBe('720p');
  });

  it('handles letterboxed heights by falling back to width', () => {
    // A 2.39:1 4K film is 3840×1600 — under a height-only rule it reads as 1440p.
    expect(resolutionLabel(null, 3840, 1600)).toBe('2160p');
  });

  it('returns null when nothing is known, rather than guessing', () => {
    // A dash would imply the data is missing; unmeasured is not the same claim.
    expect(resolutionLabel(null, null, null)).toBeNull();
    expect(resolutionLabel(null, 0, 0)).toBeNull();
  });

  it('labels genuinely small files as SD', () => {
    expect(resolutionLabel(null, 640, 360)).toBe('SD');
  });
});
