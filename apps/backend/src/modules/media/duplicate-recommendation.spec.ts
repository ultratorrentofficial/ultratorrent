import { recommend, type RecommendationCandidate } from './duplicate-recommendation';

const c = (id: string, over: Partial<RecommendationCandidate> = {}): RecommendationCandidate => ({
  id,
  title: 'Hotel Mumbai',
  year: 2019,
  season: null,
  episode: null,
  path: `/movies/Hotel Mumbai (2019)/${id}.mkv`,
  modifiedAt: new Date('2026-01-01'),
  externalIds: [],
  file: { size: 1_000_000_000, height: 1080, bitrateKbps: 4000, durationSec: 7000, audioChannels: 6 },
  ...over,
});

describe('recommend — ranking', () => {
  it('prefers the higher measured resolution over the larger file', () => {
    // The exact case "largest wins" gets wrong: a bloated 720p re-encode beside a
    // lean 1080p source.
    const r = recommend([
      c('big720', { file: { size: 9_000_000_000, height: 720, bitrateKbps: 2000, durationSec: 7000, audioChannels: 2 } }),
      c('lean1080', { file: { size: 2_000_000_000, height: 1080, bitrateKbps: 5000, durationSec: 7000, audioChannels: 6 } }),
    ]);
    expect(r.keepId).toBe('lean1080');
    expect(r.verdicts[0].reasons).toContain('highest_resolution');
  });

  it('uses bitrate when resolution ties', () => {
    const r = recommend([
      c('lowbr', { file: { size: 3_000_000_000, height: 1080, bitrateKbps: 2000, durationSec: 7000, audioChannels: 6 } }),
      c('highbr', { file: { size: 2_000_000_000, height: 1080, bitrateKbps: 8000, durationSec: 7000, audioChannels: 6 } }),
    ]);
    expect(r.keepId).toBe('highbr');
  });

  it('uses audio channels when resolution and bitrate tie', () => {
    const r = recommend([
      c('stereo', { file: { size: 2_000_000_000, height: 1080, bitrateKbps: 4000, durationSec: 7000, audioChannels: 2 } }),
      c('surround', { file: { size: 2_000_000_000, height: 1080, bitrateKbps: 4000, durationSec: 7000, audioChannels: 6 } }),
    ]);
    expect(r.keepId).toBe('surround');
  });

  it('falls back to size only when everything measurable ties', () => {
    const r = recommend([
      c('small', { file: { size: 1_000_000_000, height: 1080, bitrateKbps: 4000, durationSec: 7000, audioChannels: 6 } }),
      c('large', { file: { size: 4_000_000_000, height: 1080, bitrateKbps: 4000, durationSec: 7000, audioChannels: 6 } }),
    ]);
    expect(r.keepId).toBe('large');
    expect(r.verdicts[0].reasons).toContain('largest_file_tiebreak');
  });

  it('reads resolution from the filename when nothing was measured', () => {
    const r = recommend([
      c('a', { file: { size: 2_000_000_000, resolution: '720p' } }),
      c('b', { file: { size: 1_000_000_000, resolution: '1080p' } }),
    ]);
    expect(r.keepId).toBe('b');
  });

  it('is deterministic — same input, same winner, regardless of order', () => {
    const a = c('aaa', { file: { size: 2_000_000_000, height: 1080, bitrateKbps: 4000, durationSec: 7000, audioChannels: 6 } });
    const b = c('bbb', { file: { size: 2_000_000_000, height: 1080, bitrateKbps: 4000, durationSec: 7000, audioChannels: 6 } });
    expect(recommend([a, b]).verdicts.map((v) => v.id)).toEqual(recommend([b, a]).verdicts.map((v) => v.id));
  });

  it('explains every candidate, not just the winner', () => {
    const r = recommend([
      c('win', { file: { size: 2_000_000_000, height: 1080, bitrateKbps: 5000, durationSec: 7000, audioChannels: 6 } }),
      c('lose', { file: { size: 2_000_000_000, height: 720, bitrateKbps: 2000, durationSec: 7000, audioChannels: 2 } }),
    ]);
    expect(r.verdicts).toHaveLength(2);
    expect(r.verdicts[1].reasons).toContain('lower_resolution');
  });
});

describe('recommend — review is mandatory when identity is in doubt', () => {
  const expectReview = (r: ReturnType<typeof recommend>, why: string) => {
    expect(r.requiresReview).toBe(true);
    expect(r.warnings).toContain(why);
    // The critical property: no auto-keep, so a bulk action cannot sweep up exactly
    // the cases a human was meant to look at.
    expect(r.keepId).toBeNull();
  };

  it('refuses to choose between different years', () => {
    expectReview(recommend([c('a', { year: 1992 }), c('b', { year: 2019 })]), 'different_years');
  });

  it('refuses to choose between different episodes', () => {
    expectReview(
      recommend([c('a', { season: 1, episode: 1 }), c('b', { season: 1, episode: 2 })]),
      'different_episodes',
    );
  });

  it('refuses to choose between a theatrical and a directors cut', () => {
    expectReview(
      recommend([
        c('a', { path: '/movies/Dune (2021)/Dune theatrical.mkv' }),
        c('b', { path: '/movies/Dune (2021)/Dune directors cut.mkv' }),
      ]),
      'different_editions',
    );
  });

  it('refuses when a provider id disagrees across candidates', () => {
    expectReview(
      recommend([
        c('a', { externalIds: [{ provider: 'imdb', externalId: 'tt111' }] }),
        c('b', { externalIds: [{ provider: 'imdb', externalId: 'tt222' }] }),
      ]),
      'conflicting_external_ids',
    );
  });

  it('refuses when runtimes differ enough to be a different cut', () => {
    expectReview(
      recommend([
        c('a', { file: { size: 2e9, height: 1080, bitrateKbps: 4000, durationSec: 7000, audioChannels: 6 } }),
        c('b', { file: { size: 2e9, height: 1080, bitrateKbps: 4000, durationSec: 9000, audioChannels: 6 } }),
      ]),
      'runtime_mismatch',
    );
  });

  it('tolerates a small runtime difference (re-encode, not a different cut)', () => {
    const r = recommend([
      c('a', { file: { size: 2e9, height: 1080, bitrateKbps: 4000, durationSec: 7000, audioChannels: 6 } }),
      c('b', { file: { size: 2e9, height: 1080, bitrateKbps: 4000, durationSec: 7100, audioChannels: 6 } }),
    ]);
    expect(r.warnings).not.toContain('runtime_mismatch');
  });

  it('requires review when nothing was measured — a coin toss is not a decision', () => {
    const r = recommend([
      c('a', { file: { size: 2_000_000_000 } }),
      c('b', { file: { size: 1_000_000_000 } }),
    ]);
    expect(r.confidence).toBeLessThan(50);
    expect(r.requiresReview).toBe(true);
    expect(r.keepId).toBeNull();
  });

  it('does not require review for a clean, fully measured comparison', () => {
    const r = recommend([
      c('win', { file: { size: 2e9, height: 1080, bitrateKbps: 5000, durationSec: 7000, audioChannels: 6 } }),
      c('lose', { file: { size: 2e9, height: 720, bitrateKbps: 2000, durationSec: 7000, audioChannels: 2 } }),
    ]);
    expect(r.requiresReview).toBe(false);
    expect(r.keepId).toBe('win');
    expect(r.confidence).toBeGreaterThanOrEqual(90);
  });
});

describe('recommend — savings', () => {
  it('counts everything except the kept copy', () => {
    const r = recommend([
      c('win', { file: { size: 3e9, height: 1080, bitrateKbps: 5000, durationSec: 7000, audioChannels: 6 } }),
      c('a', { file: { size: 2e9, height: 720, bitrateKbps: 2000, durationSec: 7000, audioChannels: 2 } }),
      c('b', { file: { size: 1e9, height: 480, bitrateKbps: 1000, durationSec: 7000, audioChannels: 2 } }),
    ]);
    expect(r.potentialSavingsBytes).toBe(3e9);
  });

  it('never reports negative savings', () => {
    const r = recommend([c('a'), c('b')]);
    expect(r.potentialSavingsBytes).toBeGreaterThanOrEqual(0);
  });

  it('treats a lone candidate as not a group at all', () => {
    const r = recommend([c('only')]);
    expect(r.keepId).toBeNull();
    expect(r.requiresReview).toBe(true);
    expect(r.potentialSavingsBytes).toBe(0);
  });
});
