import {
  classifyResolution,
  compareResolution,
  isAtLeast,
  resolutionOrdinal,
  RESOLUTION_CLASSES,
} from './resolution-class';
import { resolutionFromHeight } from '../../media-probe.service';

describe('classifyResolution', () => {
  it('classifies textbook frames', () => {
    expect(classifyResolution(1920, 1080)).toBe('1080p');
    expect(classifyResolution(1280, 720)).toBe('720p');
    expect(classifyResolution(3840, 2160)).toBe('2160p');
    expect(classifyResolution(2560, 1440)).toBe('1440p');
    expect(classifyResolution(7680, 4320)).toBe('4320p');
    expect(classifyResolution(720, 576)).toBe('576p');
    expect(classifyResolution(720, 480)).toBe('480p');
    expect(classifyResolution(640, 352)).toBe('sd');
  });

  // The brief's headline case: a scope-framed 1080p master is 1920x800. Judging it
  // on height alone calls it 720p and makes it a deletion candidate under
  // "below 1080p" — the single most dangerous misclassification in the feature.
  it('keeps a 1920x800 scope encode in the 1080p class (width is load-bearing)', () => {
    expect(classifyResolution(1920, 800)).toBe('1080p');
    expect(classifyResolution(1920, 804)).toBe('1080p');
    expect(classifyResolution(1920, 816)).toBe('1080p');
    // …and it must NOT satisfy "below 1080p"
    expect(compareResolution(classifyResolution(1920, 800), '1080p')).toBe(0);
  });

  it('keeps a 4K scope encode at 2160p', () => {
    expect(classifyResolution(3840, 1600)).toBe('2160p');
  });

  it('returns unknown when nothing was measured', () => {
    expect(classifyResolution(undefined, undefined)).toBe('unknown');
    expect(classifyResolution(null, null)).toBe('unknown');
    expect(classifyResolution(0, 0)).toBe('unknown');
  });

  it('never contradicts the stored-label classifier on shared tiers', () => {
    const frames: Array<[number, number]> = [
      [1920, 1080], [1920, 800], [1280, 720], [3840, 2160], [720, 480], [640, 352],
    ];
    for (const [w, h] of frames) {
      const legacy = resolutionFromHeight(h, w); // what MediaFile.resolution stores
      const cls = classifyResolution(w, h);
      if (legacy && (RESOLUTION_CLASSES as readonly string[]).includes(legacy)) {
        expect(cls).toBe(legacy);
      }
    }
  });
});

describe('ordering', () => {
  it('orders the ladder', () => {
    expect(resolutionOrdinal('sd')).toBeLessThan(resolutionOrdinal('480p')!);
    expect(resolutionOrdinal('480p')).toBeLessThan(resolutionOrdinal('576p')!);
    expect(resolutionOrdinal('576p')).toBeLessThan(resolutionOrdinal('720p')!);
    expect(resolutionOrdinal('720p')).toBeLessThan(resolutionOrdinal('1080p')!);
    expect(resolutionOrdinal('1080p')).toBeLessThan(resolutionOrdinal('1440p')!);
    expect(resolutionOrdinal('1440p')).toBeLessThan(resolutionOrdinal('2160p')!);
    expect(resolutionOrdinal('2160p')).toBeLessThan(resolutionOrdinal('4320p')!);
  });

  it('"below 1080p" matches only genuinely lower tiers', () => {
    const below = (w: number, h: number) => {
      const c = compareResolution(classifyResolution(w, h), '1080p');
      return c != null && c < 0;
    };
    expect(below(1280, 720)).toBe(true);
    expect(below(720, 480)).toBe(true);
    expect(below(1920, 1080)).toBe(false);
    expect(below(1920, 800)).toBe(false); // scope 1080p
    expect(below(3840, 2160)).toBe(false);
  });

  // An unmeasured file must neither satisfy nor fail a comparison — it is excluded
  // upstream as `excluded_unmeasured`, never silently treated as low-resolution.
  it('unknown is not comparable in either direction', () => {
    expect(resolutionOrdinal('unknown')).toBeNull();
    expect(compareResolution('unknown', '1080p')).toBeNull();
    expect(compareResolution('1080p', 'unknown')).toBeNull();
    expect(isAtLeast('unknown', '720p')).toBe(false);
  });

  it('isAtLeast gates a replacement floor', () => {
    expect(isAtLeast('1080p', '1080p')).toBe(true);
    expect(isAtLeast('2160p', '1080p')).toBe(true);
    expect(isAtLeast('720p', '1080p')).toBe(false);
  });
});
