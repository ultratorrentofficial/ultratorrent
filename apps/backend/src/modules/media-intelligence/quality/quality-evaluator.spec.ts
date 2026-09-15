import type { NormalizedMediaQuality, NormalizedPreferenceLadder } from '@ultratorrent/shared';

import { aggregateQuality, evaluateQualityCompliance } from './quality-evaluator';
import { ladderAppliesTo } from './preference-ladder';

/**
 * The compliance core, tested as a pure function.
 *
 * As in Phase 1, most of these cases test that the evaluator REFUSES to draw a
 * conclusion. A library where the codec was never recorded, a rung that asks
 * for a release group, a file nobody probed — each must come back unknown, not
 * failed. An advisory layer that invents defects is worse than none.
 */

const measured = (over: Partial<NormalizedMediaQuality> = {}): NormalizedMediaQuality => ({
  provenance: 'measured',
  resolutionClass: '1080p',
  resolutionOrdinal: 4,
  width: 1920,
  height: 1080,
  videoCodec: 'x265',
  videoBitDepth: 8,
  hdr: false,
  hdrFormat: null,
  audioCodec: 'e-ac-3',
  audioChannels: 6,
  bitrateKbps: 4200,
  frameRate: 23.976,
  durationSec: 2700,
  container: 'mkv',
  sizeBytes: 900_000_000,
  ...over,
});

let nextId = 0;
const rung = (over: Partial<{
  name: string;
  resolution: string | null;
  codec: string | null;
  source: string | null;
  quality: string | null;
  requiredTerms: string[];
  excludedTerms: string[];
  maxBytes: number | null;
  minBytes: number | null;
}> = {}) => ({
  id: `c${nextId++}`,
  name: over.name ?? 'rung',
  rung: 0,
  resolution: over.resolution ?? null,
  codec: over.codec ?? null,
  source: over.source ?? null,
  quality: over.quality ?? null,
  requiredTerms: over.requiredTerms ?? [],
  excludedTerms: over.excludedTerms ?? [],
  maxBytes: over.maxBytes ?? null,
  minBytes: over.minBytes ?? null,
});

const ladderOf = (...rungs: ReturnType<typeof rung>[]): NormalizedPreferenceLadder => ({
  source: 'global_ladder',
  sourceLabel: 'Global Auto-Download Preferences',
  rungs: rungs.map((r, i) => ({ ...r, rung: i })),
});

describe('evaluateQualityCompliance — ladder matching', () => {
  it('reports PREFERRED when the top rung is satisfied', () => {
    const l = ladderOf(rung({ name: '2160p', resolution: '2160p' }), rung({ resolution: '1080p' }));
    const r = evaluateQualityCompliance(measured({ resolutionClass: '2160p', resolutionOrdinal: 6 }), l);
    expect(r.status).toBe('preferred');
    expect(r.matchedRung).toBe(0);
    expect(r.upgradePotential).toBe(false);
  });

  it('reports ACCEPTABLE, not a defect, when a fallback rung matches', () => {
    const l = ladderOf(rung({ name: '2160p', resolution: '2160p' }), rung({ name: '1080p', resolution: '1080p' }));
    const r = evaluateQualityCompliance(measured(), l);
    expect(r.status).toBe('acceptable');
    expect(r.matchedRung).toBe(1);
    expect(r.matchedRungName).toBe('1080p');
    expect(r.upgradePotential).toBe(true);
  });

  it('matches the final fallback rung', () => {
    const l = ladderOf(
      rung({ resolution: '2160p' }),
      rung({ resolution: '1440p' }),
      rung({ name: 'last', resolution: '1080p' }),
    );
    const r = evaluateQualityCompliance(measured(), l);
    expect(r.matchedRung).toBe(2);
    expect(r.status).toBe('acceptable');
  });

  it('reports BELOW_PREFERENCE when every rung is confidently failed', () => {
    const l = ladderOf(rung({ resolution: '2160p' }), rung({ resolution: '1440p' }));
    const r = evaluateQualityCompliance(measured({ resolutionClass: '720p', resolutionOrdinal: 3 }), l);
    expect(r.status).toBe('below_preference');
    expect(r.matchedRung).toBeNull();
    // Not an upgrade "potential" claim: it satisfies nothing at all.
    expect(r.upgradePotential).toBe(false);
  });

  it('gives no upgrade potential when the top rung is the match', () => {
    const l = ladderOf(rung({ resolution: '1080p' }), rung({ resolution: '720p' }));
    expect(evaluateQualityCompliance(measured(), l).upgradePotential).toBe(false);
  });
});

describe('evaluateQualityCompliance — unknown is never failure', () => {
  it('returns UNKNOWN when no acquisition preferences exist', () => {
    const r = evaluateQualityCompliance(measured(), { source: 'none', sourceLabel: null, rungs: [] });
    expect(r.status).toBe('unknown');
    expect(r.unknownReason).toBe('no_acquisition_preferences');
    // Explicitly NOT healthy/preferred: absence of policy is not approval.
    expect(r.matchedRung).toBeNull();
  });

  it('returns UNKNOWN when there is no owned quality at all', () => {
    const r = evaluateQualityCompliance(null, ladderOf(rung({ resolution: '1080p' })));
    expect(r.status).toBe('unknown');
    expect(r.unknownReason).toBe('no_measured_quality');
  });

  it('treats an unmeasured resolution as not evaluable, never as a fail', () => {
    const l = ladderOf(rung({ resolution: '1080p' }));
    const r = evaluateQualityCompliance(measured({ resolutionClass: null, resolutionOrdinal: null }), l);
    const res = r.dimensions.find((d) => d.dimension === 'resolution');
    expect(res?.result).toBe('not_evaluable');
    expect(res?.reason).toBe('not_measured');
    expect(r.status).not.toBe('below_preference');
  });

  it('treats an unmeasured codec as not evaluable — the common case in this library', () => {
    const l = ladderOf(rung({ codec: 'x264' }));
    const r = evaluateQualityCompliance(measured({ videoCodec: null }), l);
    const codec = r.dimensions.find((d) => d.dimension === 'codec');
    expect(codec?.result).toBe('not_evaluable');
    expect(r.status).not.toBe('below_preference');
  });

  it('treats unknown HDR as not evaluable rather than SDR', () => {
    const l = ladderOf(rung({ requiredTerms: ['HDR'] }));
    const r = evaluateQualityCompliance(measured({ hdr: null }), l);
    const term = r.dimensions.find((d) => d.dimension === 'terms');
    expect(term?.result).toBe('not_evaluable');
    expect(term?.reason).toBe('not_measured');
  });

  it('returns UNKNOWN when every rung asks only for things a file cannot answer', () => {
    const l = ladderOf(rung({ source: 'WEB-DL' }), rung({ requiredTerms: ['x265-MeGusta'] }));
    const r = evaluateQualityCompliance(measured(), l);
    expect(r.status).toBe('unknown');
    expect(r.unknownReason).toBe('not_evaluable_from_owned_media');
  });
});

describe('evaluateQualityCompliance — term semantics', () => {
  it('satisfies an HDR requirement from a measured HDR file', () => {
    const l = ladderOf(rung({ requiredTerms: ['HDR'] }));
    const r = evaluateQualityCompliance(measured({ hdr: true, hdrFormat: 'Dolby Vision' }), l);
    expect(r.status).toBe('preferred');
    expect(r.dimensions.find((d) => d.dimension === 'terms')?.result).toBe('pass');
  });

  it('fails an HDR requirement for a confidently measured SDR file', () => {
    const l = ladderOf(rung({ requiredTerms: ['HDR'] }));
    const r = evaluateQualityCompliance(measured({ hdr: false }), l);
    expect(r.dimensions.find((d) => d.dimension === 'terms')?.result).toBe('fail');
    expect(r.status).toBe('below_preference');
  });

  it('cannot evaluate a release-group term, and says so instead of failing', () => {
    const l = ladderOf(rung({ requiredTerms: ['x265-MeGusta'] }));
    const r = evaluateQualityCompliance(measured(), l);
    const term = r.dimensions.find((d) => d.dimension === 'terms');
    expect(term?.result).toBe('not_evaluable');
    expect(term?.reason).toBe('release_group');
  });

  it('cannot evaluate a source requirement — renaming destroys it', () => {
    const l = ladderOf(rung({ source: 'WEB-DL' }));
    const r = evaluateQualityCompliance(measured(), l);
    const src = r.dimensions.find((d) => d.dimension === 'source');
    expect(src?.result).toBe('not_evaluable');
    expect(src?.reason).toBe('release_name_only');
  });

  it('detects a confidently excluded term from measured bit depth', () => {
    const l = ladderOf(rung({ excludedTerms: ['10bit'] }));
    const pass = evaluateQualityCompliance(measured({ videoBitDepth: 8 }), l);
    expect(pass.dimensions.find((d) => d.dimension === 'terms')?.result).toBe('pass');

    const fail = evaluateQualityCompliance(measured({ videoBitDepth: 10 }), l);
    expect(fail.dimensions.find((d) => d.dimension === 'terms')?.result).toBe('fail');
    expect(fail.status).toBe('below_preference');
  });

  it('cannot evaluate an excluded term when the dimension was never measured', () => {
    const l = ladderOf(rung({ excludedTerms: ['10bit'] }));
    const r = evaluateQualityCompliance(measured({ videoBitDepth: null }), l);
    expect(r.dimensions.find((d) => d.dimension === 'terms')?.result).toBe('not_evaluable');
  });

  it('applies size limits from the real file size', () => {
    const l = ladderOf(rung({ resolution: '1080p', maxBytes: 1_073_741_824 }));
    expect(evaluateQualityCompliance(measured({ sizeBytes: 900_000_000 }), l).status).toBe('preferred');
    expect(evaluateQualityCompliance(measured({ sizeBytes: 2_000_000_000 }), l).status).toBe('below_preference');
  });

  it('keeps required/excluded terms attached to their own rung', () => {
    // Rung 0 demands 10bit; rung 1 excludes it. An 8-bit file must fall to 1.
    const l = ladderOf(
      rung({ name: 'ten', requiredTerms: ['10bit'] }),
      rung({ name: 'eight', excludedTerms: ['10bit'] }),
    );
    const r = evaluateQualityCompliance(measured({ videoBitDepth: 8 }), l);
    expect(r.matchedRungName).toBe('eight');
    expect(r.matchedRung).toBe(1);
  });

  it('carries the preference source through for explainability', () => {
    const l = ladderOf(rung({ resolution: '1080p' }));
    const r = evaluateQualityCompliance(measured(), l);
    expect(r.preferenceSource).toBe('global_ladder');
    expect(r.preferenceSourceLabel).toBe('Global Auto-Download Preferences');
  });
});

describe('aggregateQuality — a series is not one file', () => {
  const entry = (status: 'preferred' | 'acceptable' | 'below_preference' | 'unknown', cls: string | null, ord: number | null, upgrade = false) => ({
    compliance: {
      status, matchedRung: null, matchedRungName: null, preferredRung: 0, totalRungs: 2,
      upgradePotential: upgrade, dimensions: [], reasons: [], unknownReason: null,
      preferenceSource: 'global_ladder' as const, preferenceSourceLabel: null,
    },
    owned: cls ? measured({ resolutionClass: cls, resolutionOrdinal: ord }) : null,
  });

  it('counts every episode by status', () => {
    const a = aggregateQuality([
      entry('preferred', '1080p', 4),
      entry('preferred', '1080p', 4),
      entry('acceptable', '720p', 3, true),
      entry('unknown', null, null),
    ]);
    expect(a).toMatchObject({ evaluated: 4, preferred: 2, acceptable: 1, unknown: 1, upgradePotential: 1 });
  });

  it('keeps a single below-preference episode visible', () => {
    const a = aggregateQuality([
      ...Array.from({ length: 61 }, () => entry('preferred', '1080p', 4)),
      entry('below_preference', '720p', 3),
    ]);
    expect(a.belowPreference).toBe(1);
    // The outlier must survive the summary, not be averaged away.
    expect(a.worstResolution).toBe('720p');
    expect(a.mixed).toBe(true);
    expect(a.dominantResolution).toBe('1080p');
  });

  it('reports a uniform series as not mixed', () => {
    const a = aggregateQuality([entry('preferred', '1080p', 4), entry('preferred', '1080p', 4)]);
    expect(a.mixed).toBe(false);
    expect(a.worstResolution).toBe('1080p');
  });

  it('counts an unknown episode as unknown rather than pretending it is fine', () => {
    const a = aggregateQuality([entry('preferred', '1080p', 4), entry('unknown', null, null)]);
    expect(a.unknown).toBe(1);
    expect(a.preferred).toBe(1);
    expect(a.evaluated).toBe(2);
  });

  it('handles a series with nothing evaluated', () => {
    const a = aggregateQuality([]);
    expect(a).toMatchObject({ evaluated: 0, preferred: 0, unknown: 0, mixed: false, dominantResolution: null });
  });
});

describe('ladderAppliesTo — a TV ladder does not govern a film', () => {
  const episodeRung = { id: 'a', name: '1080p', priorityOrder: 0, enabled: true, matchType: 'smart_episode_match' as const };
  const movieRung = { id: 'b', name: '1080p', priorityOrder: 0, enabled: true, matchType: 'smart_movie_match' as const };

  it('lets an episode ladder govern TV', () => {
    expect(ladderAppliesTo([episodeRung], 'tv')).toBe(true);
  });

  it('refuses to judge a movie against an episode-only ladder', () => {
    /*
     * The defect this guards is not hypothetical: judging films against this
     * installation's TV ladder marked 3,026 of 3,351 movies below_preference
     * on SIZE alone, because a per-episode 1 GB cap cannot fit a feature.
     */
    expect(ladderAppliesTo([episodeRung], 'movie')).toBe(false);
  });

  it('governs a movie when a non-episode rung exists', () => {
    expect(ladderAppliesTo([episodeRung, movieRung], 'movie')).toBe(true);
  });

  it('treats an empty ladder as governing nothing', () => {
    expect(ladderAppliesTo([], 'tv')).toBe(false);
    expect(ladderAppliesTo([], 'movie')).toBe(false);
  });

  it('reports no_acquisition_preferences rather than a fabricated failure', () => {
    // What the movie path now produces: an empty ladder, so the verdict is
    // unknown-with-a-reason instead of a size failure nobody configured.
    const r = evaluateQualityCompliance(measured({ sizeBytes: 2_153_000_000 }), {
      source: 'none', sourceLabel: null, rungs: [],
    });
    expect(r.status).toBe('unknown');
    expect(r.unknownReason).toBe('no_acquisition_preferences');
  });
});
