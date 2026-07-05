import { compareQuality, scoreQuality } from '../quality-compare';

describe('quality comparison (upgrade intelligence)', () => {
  it('ranks a higher resolution as better', () => {
    const r = compareQuality(
      'The Show S01E02 2160p WEB-DL x265-GRP',
      'The Show S01E02 1080p WEB-DL x265-GRP',
    );
    expect(r.better).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/resolution/i);
  });

  it('prefers BluRay over WEBRip at the same resolution', () => {
    const r = compareQuality(
      'Movie 2026 1080p BluRay x265-GRP',
      'Movie 2026 1080p WEBRip x265-GRP',
    );
    expect(r.better).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/source/i);
  });

  it('prefers Dolby Vision over SDR at the same resolution/source', () => {
    const r = compareQuality(
      'Movie 2026 2160p BluRay DV HDR x265-GRP',
      'Movie 2026 2160p BluRay x265-GRP',
    );
    expect(r.better).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/hdr/i);
  });

  it('prefers Atmos audio when everything else is equal', () => {
    const r = compareQuality(
      'Movie 2026 2160p BluRay TrueHD Atmos 7.1 x265-GRP',
      'Movie 2026 2160p BluRay DTS 5.1 x265-GRP',
    );
    expect(r.better).toBe(true);
  });

  it('is not an upgrade when the candidate is equal quality', () => {
    const r = compareQuality(
      'Movie 2026 1080p BluRay x265-A',
      'Movie 2026 1080p BluRay x265-B',
    );
    expect(r.better).toBe(false);
    expect(r.reasons).toHaveLength(0);
  });

  it('is not an upgrade when the candidate is lower quality', () => {
    const r = compareQuality(
      'Movie 2026 720p WEBRip x264-GRP',
      'Movie 2026 2160p BluRay DV TrueHD Atmos x265-GRP',
    );
    expect(r.better).toBe(false);
  });

  it('scores a premium release above a basic one', () => {
    const premium = scoreQuality('Movie 2026 2160p BluRay DV TrueHD Atmos 7.1 x265-GRP');
    const basic = scoreQuality('Movie 2026 1080p WEBRip AAC x264-GRP');
    expect(premium.total).toBeGreaterThan(basic.total);
  });
});
