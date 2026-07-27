import {
  HEALTHY_AT, PROBLEM_BELOW, isUnorganisedPath, rollup, scoreItem, statusFor,
} from './media-health-score';

const perfect = {
  matched: true, hasMetadata: true, hasArtwork: true,
  hasSubtitles: true, isDuplicate: false, hasMeasuredTech: true, unorganised: false,
};

describe('scoreItem', () => {
  it('scores a complete item 100 with no reasons', () => {
    const r = scoreItem(perfect);
    expect(r.score).toBe(100);
    expect(r.status).toBe('healthy');
    // A healthy item must carry an empty reason list, not a list of passes.
    expect(r.reasons).toEqual([]);
  });

  it('scores an item with nothing at all as 0', () => {
    const r = scoreItem({
      matched: false, hasMetadata: false, hasArtwork: false,
      hasSubtitles: false, isDuplicate: false, hasMeasuredTech: false, unorganised: true,
    });
    expect(r.score).toBe(0);
    expect(r.status).toBe('problem');
  });

  it('drops an unmatched item out of the healthy band on its own', () => {
    /*
     * An unmatched item is not slightly unhealthy — it is one the platform
     * cannot reason about at all, since no metadata, artwork or correct name
     * can follow from it.
     */
    const r = scoreItem({ ...perfect, matched: false });
    expect(r.score).toBeLessThan(HEALTHY_AT);
    expect(r.reasons).toContain('unmatched');
  });

  it('keeps a subtitle-less item healthy', () => {
    // Plenty of libraries neither want nor need subtitles. Scoring them like
    // metadata would paint a good library amber and train operators to ignore
    // the colour entirely.
    const r = scoreItem({ ...perfect, hasSubtitles: false });
    expect(r.status).toBe('healthy');
    expect(r.reasons).toEqual(['missing_subtitles']);
  });

  it('treats a duplicate as an identity failure, not a separate deduction', () => {
    const r = scoreItem({ ...perfect, isDuplicate: true });
    expect(r.reasons).toContain('duplicate');
    expect(r.reasons).not.toContain('unmatched');
    expect(r.score).toBeLessThan(HEALTHY_AT);
  });

  it('names every failure it counted', () => {
    const r = scoreItem({
      ...perfect, hasMetadata: false, hasArtwork: false, hasMeasuredTech: false,
    });
    expect(r.reasons.sort()).toEqual(['missing_artwork', 'missing_metadata', 'not_analyzed']);
    // Reasons and failed checks must agree, or the badge and the tooltip lie.
    expect(r.checks.filter((c) => !c.passed)).toHaveLength(3);
  });

  it('is deterministic and bounded', () => {
    for (const facts of [perfect, { ...perfect, matched: false, hasArtwork: false }]) {
      const a = scoreItem(facts);
      const b = scoreItem(facts);
      expect(a.score).toBe(b.score);
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(100);
    }
  });
});

describe('statusFor', () => {
  it('bands on the published thresholds', () => {
    expect(statusFor(100)).toBe('healthy');
    expect(statusFor(HEALTHY_AT)).toBe('healthy');
    expect(statusFor(HEALTHY_AT - 1)).toBe('attention');
    expect(statusFor(PROBLEM_BELOW)).toBe('attention');
    expect(statusFor(PROBLEM_BELOW - 1)).toBe('problem');
    expect(statusFor(0)).toBe('problem');
  });
});

describe('rollup', () => {
  it('averages rather than reporting the worst member', () => {
    /*
     * A 49-episode show with one unmatched file is not in the same state as one
     * where every episode is unmatched. A worst-member rollup would paint
     * almost every real library red and make the number useless for deciding
     * where to spend effort.
     */
    const scores = [...Array(48).fill(100), 20];
    expect(rollup(scores).score).toBe(98);
    expect(rollup(scores).status).toBe('healthy');
  });

  it('reports unknown for an empty set, not a perfect score', () => {
    // A season with no episodes has passed nothing; scoring it 100 would hide
    // it from the operator looking for gaps.
    expect(rollup([])).toEqual({ score: 0, status: 'unknown' });
  });

  it('rounds to a whole number', () => {
    expect(rollup([100, 99]).score).toBe(100);
    expect(rollup([50, 51]).score).toBe(51);
  });
});

describe('isUnorganisedPath', () => {
  it('flags a scene release folder', () => {
    expect(isUnorganisedPath(
      '/tv/Show (2024)/A.Gentleman.in.Moscow.S01E05.1080p.HEVC.x265-MeGusta[TGx]/f.mkv',
    )).toBe(true);
  });

  it('accepts an organised season path', () => {
    expect(isUnorganisedPath('/tv/Show (2024)/Season 1/Show - S01E01 - Title.mkv')).toBe(false);
  });

  it('does not flag a show folder that merely has numbers', () => {
    expect(isUnorganisedPath('/tv/1080 (2019)/ep.mkv')).toBe(false);
  });
});
