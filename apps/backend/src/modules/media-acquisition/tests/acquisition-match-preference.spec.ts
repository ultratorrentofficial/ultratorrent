import { AcquisitionMatchPreferenceService } from '../acquisition-match-preference.service';
import type { MatchCandidateInput } from '../../rss/match-engine';
import type { IndexerCandidate } from '../../indexers/torznab-client';

const svc = new AcquisitionMatchPreferenceService(null as any);

const cand = (over: Partial<IndexerCandidate>): IndexerCandidate => ({
  indexerId: 'ix',
  indexerName: 'ix',
  title: 'The Show S01E01 1080p WEB-DL x265-GRP',
  downloadUrl: 'magnet:?xt=urn:btih:aaa',
  infoHash: null,
  sizeBytes: null,
  seeders: null,
  categories: [],
  ...over,
});

const pref = (over: Partial<MatchCandidateInput>): MatchCandidateInput => ({
  id: 'p',
  name: 'p',
  priorityOrder: 0,
  enabled: true,
  matchType: 'smart_episode_match',
  pattern: null,
  requiredTerms: [],
  excludedTerms: [],
  qualityRules: {},
  sizeRules: {},
  ...over,
});

const GB = 1024 * 1024 * 1024;

/**
 * Show-identity regression.
 *
 * `select()` used to gate the show with a bidirectional SUBSTRING test
 * (`t.includes(show) || show.includes(t)`), so it accepted any release whose title
 * merely contained the monitored show's name — or was contained by it. Nothing
 * downstream re-checked: profile/default preference candidates carry `pattern: null`,
 * a deliberate pass-through, so quality+size were the only remaining filters.
 *
 * Every WRONG case below is a real mis-grab taken from a live library, where this bug
 * mis-grabbed 132 of 714 episodes (18.5%) across 15 monitored shows.
 */
describe('AcquisitionMatchPreferenceService.select — show identity', () => {
  // The seeded default: pass-through pattern, so ONLY the identity gate can reject.
  const passthrough = [pref({ name: 'default', qualityRules: {}, sizeRules: {} })];

  /**
   * Ask select() for the episode the release ACTUALLY carries, so the SxxEyy filter
   * always passes and the only thing under test is the show-identity gate. (Hardcoding
   * S01E01 here would let a release be rejected on its episode number instead, and the
   * wrong-show assertions would pass without exercising the fix at all.)
   */
  const grabbed = (show: string, release: string, s?: number, e?: number) => {
    const m = /s(\d{1,2})e(\d{1,3})/i.exec(release);
    const season = s ?? (m ? parseInt(m[1], 10) : 1);
    const episode = e ?? (m ? parseInt(m[2], 10) : 1);
    return svc.select([cand({ title: release })], passthrough, show, season, episode) !== null;
  };

  it.each([
    // [monitored show, release that was actually grabbed for it]
    ['Rise', 'The Pendragon Cycle Rise of the Merlin S01E02 The Vision 1080p HEVC x265-MeGusta'],
    ['Rise', 'Rise Of The Raven S01E01 SUBBED 1080p HEVC x265-MeGusta'],
    ['Rise', 'The Fall and Rise of Reggie Dinkins S01E06 1080p HEVC x265-MeGusta'],
    ['90 Day Fiance', '90 Day Fiance Before the 90 Days S01E11 Back to Square One 720p HEVC x265-MeGusta'],
    ['90 Day Fiance', '90 Day Fiance The Other Way S01E10 1080p HEVC x265-MeGusta'],
    ['Riverdale', 'Riverdale US S01E14 1080p HEVC x265-MeGusta'],
    ['The Bad Batch', 'Star Wars The Bad Batch S01E15 720p HEVC x265-MeGusta'],
    ['Rogue', 'SAS Rogue Heroes S01E04 1080p HEVC x265-MeGusta'],
    ['ted', 'Ted Lasso S01E01 720p HEVC x265-MeGusta'],
    ['House', 'House of the Dragon S01E03 1080p HEVC x265-MeGusta'],
    ['Elite', 'Classroom of the Elite S01E06 1080p HEVC x265-MeGusta'],
    ['Kung Fu', 'Kung Fu Panda The Dragon Knight S01E08 1080p HEVC x265-MeGusta'],
    ['All American', 'All American Homecoming S01E02 1080p HEVC x265-MeGusta'],
  ])('does NOT grab %s from a different show: %s', (show, release) => {
    expect(grabbed(show, release)).toBe(false);
  });

  it.each([
    // The real shows must still be grabbed — the fix must not silence them.
    ['Rise', 'Rise 2017 S01E01 1080p HEVC x265-MeGusta'],
    ['Rise', 'Rise.S01E01.1080p.HEVC.x265-MeGusta'],
    ['90 Day Fiance', '90 Day Fiance S01E11 1080p HEVC x265-MeGusta'],
    ['The Bad Batch', 'The.Bad.Batch.S01E15.720p.HEVC.x265-MeGusta'],
    ['House', 'House.S01E03.1080p.HEVC.x265-MeGusta'],
    ['Riverdale', 'Riverdale.S01E14.1080p.HEVC.x265-MeGusta'],
  ])('still grabs the real %s: %s', (show, release) => {
    expect(grabbed(show, release)).toBe(true);
  });

  it('tolerates a year on the monitored title (Sugar 2024 → pure title "sugar")', () => {
    // showTitleMatch bounds the release title at a non-leading year, so leaving the
    // year on the pattern would match nothing and silence the show entirely.
    expect(grabbed('Sugar 2024', 'Sugar 2024 S01E04 1080p HEVC x265-MeGusta')).toBe(true);
    expect(grabbed('Rise (2017)', 'Rise 2017 S01E01 1080p HEVC x265-MeGusta')).toBe(true);
  });

  it('ignores a leading article difference', () => {
    expect(grabbed('The Equalizer', 'Equalizer.S01E01.1080p.HEVC.x265-MeGusta')).toBe(true);
    expect(grabbed('Equalizer', 'The.Equalizer.2021.S01E01.1080p.HEVC.x265-MeGusta')).toBe(true);
  });

  it('does not bleed across a word boundary (Rise ⊄ Sunrise)', () => {
    expect(grabbed('Rise', 'Sunrise.S01E01.1080p.HEVC.x265-MeGusta')).toBe(false);
  });

  it('still requires the exact episode', () => {
    expect(grabbed('Rise', 'Rise.S01E02.1080p.HEVC.x265-MeGusta', 1, 1)).toBe(false);
  });

  describe('titleAliases', () => {
    const grabbedAs = (show: string, aliases: string[], release: string) => {
      const m = /s(\d{1,2})e(\d{1,3})/i.exec(release)!;
      return (
        svc.select(
          [cand({ title: release })],
          passthrough,
          show,
          parseInt(m[1], 10),
          parseInt(m[2], 10),
          aliases,
        ) !== null
      );
    };

    it('accepts the release title a show is actually published under', () => {
      // Both are the RIGHT show; strict token equality alone would reject them and
      // silence the show, since neither is reachable from the monitored title.
      expect(grabbedAs('Riverdale', ['Riverdale US'], 'Riverdale US S06E14 1080p HEVC x265-MeGusta')).toBe(true);
      expect(
        grabbedAs('The Bad Batch', ['Star Wars The Bad Batch'], 'Star Wars The Bad Batch S02E07 1080p HEVC x265-MeGusta'),
      ).toBe(true);
    });

    it('still accepts the primary title when an alias is set', () => {
      expect(grabbedAs('Riverdale', ['Riverdale US'], 'Riverdale.S06E14.1080p.HEVC.x265-MeGusta')).toBe(true);
    });

    it('an alias does NOT loosen matching — it only adds a title', () => {
      // The alias is anchored by the same token-equality rule, so it cannot become a
      // new substring bleed: an alias for "Rise" must not readmit Pendragon.
      expect(grabbedAs('Rise', ['Rise 2017'], 'The Pendragon Cycle Rise of the Merlin S01E02 1080p HEVC x265-MeGusta')).toBe(false);
      expect(grabbedAs('Riverdale', ['Riverdale US'], 'Riverdale Chronicles S01E01 1080p HEVC x265-MeGusta')).toBe(false);
    });

    it('no aliases behaves exactly as before', () => {
      expect(grabbedAs('Riverdale', [], 'Riverdale US S06E14 1080p HEVC x265-MeGusta')).toBe(false);
      expect(grabbedAs('Riverdale', [], 'Riverdale.S06E14.1080p.HEVC.x265-MeGusta')).toBe(true);
    });
  });
});

describe('AcquisitionMatchPreferenceService.select', () => {
  const prefs1080 = [pref({ name: '1080p x265 ≤1GB', qualityRules: { resolution: '1080p', codec: 'x265' }, sizeRules: { maxBytes: GB } })];

  it('rejects a release over the size cap, keeps one under it', () => {
    const big = cand({ downloadUrl: 'magnet:big', sizeBytes: 2 * GB });
    const small = cand({ downloadUrl: 'magnet:small', sizeBytes: 700 * 1024 * 1024 });
    const res = svc.select([big, small], prefs1080, 'The Show', 1, 1);
    expect(res).not.toBeNull();
    expect(res!.candidate.downloadUrl).toBe('magnet:small'); // the big one is over the 1GB cap
  });

  it('returns null when every release is over the cap', () => {
    const big = cand({ sizeBytes: 3 * GB });
    expect(svc.select([big], prefs1080, 'The Show', 1, 1)).toBeNull();
  });

  it('prefers the higher-priority candidate (1080p over 720p)', () => {
    const prefs = [
      pref({ id: 'a', priorityOrder: 0, name: '1080p x265', qualityRules: { resolution: '1080p', codec: 'x265' } }),
      pref({ id: 'b', priorityOrder: 1, name: '720p x265', qualityRules: { resolution: '720p', codec: 'x265' } }),
    ];
    const p720 = cand({ downloadUrl: 'magnet:720', title: 'The Show S01E01 720p WEB-DL x265-GRP', sizeBytes: 300 * 1024 * 1024 });
    const p1080 = cand({ downloadUrl: 'magnet:1080', title: 'The Show S01E01 1080p WEB-DL x265-GRP', sizeBytes: 800 * 1024 * 1024 });
    const res = svc.select([p720, p1080], prefs, 'The Show', 1, 1);
    expect(res!.candidate.downloadUrl).toBe('magnet:1080');
  });

  it('rejects a non-preferred codec (x264 when x265 required)', () => {
    const x264 = cand({ title: 'The Show S01E01 1080p WEB-DL x264-GRP', sizeBytes: 500 * 1024 * 1024 });
    expect(svc.select([x264], prefs1080, 'The Show', 1, 1)).toBeNull();
  });

  it('filters to the exact SxxEyy of the wanted episode', () => {
    const wrongEp = cand({ title: 'The Show S01E02 1080p WEB-DL x265-GRP', sizeBytes: 500 * 1024 * 1024 });
    expect(svc.select([wrongEp], prefs1080, 'The Show', 1, 1)).toBeNull();
  });

  it('skips candidates without a download URL', () => {
    const noUrl = cand({ downloadUrl: null, sizeBytes: 500 * 1024 * 1024 });
    expect(svc.select([noUrl], prefs1080, 'The Show', 1, 1)).toBeNull();
  });

  it('accepts a release whose size is unknown (size rule skipped, not blocked)', () => {
    const unknownSize = cand({ sizeBytes: null });
    const res = svc.select([unknownSize], prefs1080, 'The Show', 1, 1);
    expect(res).not.toBeNull();
  });
});

describe('AcquisitionMatchPreferenceService.resolveCandidates', () => {
  const rssRow = { id: 'rc1', name: 'RSS pref', priorityOrder: 0, enabled: true, matchType: 'smart_episode_match', pattern: null, requiredTerms: [], excludedTerms: [], qualityRules: { resolution: '2160p' }, sizeRules: {} };
  const defaultRow = { id: 'dc1', name: 'default', priorityOrder: 0, enabled: true, matchType: 'smart_episode_match', pattern: null, requiredTerms: [], excludedTerms: [], qualityRules: { resolution: '1080p' }, sizeRules: {} };

  // The two auto-grab profiles the operator configures: 1080p preferred, 720p
  // fallback. 720p is created FIRST, so ordering must come from the resolution,
  // not from createdAt.
  const profile1080 = { id: 'pf1080', name: 'TV 1080p (auto-grab)', mediaType: 'tv', enabled: true, preferredResolution: '1080p', preferredCodec: 'x265', preferredSource: null, requiredTerms: ['x265-MeGusta'], excludedTerms: ['10bit'], qualityRules: null };
  const profile720 = { id: 'pf720', name: 'TV 720p (auto-grab)', mediaType: 'tv', enabled: true, preferredResolution: '720p', preferredCodec: 'x265', preferredSource: null, requiredTerms: ['x265-MeGusta'], excludedTerms: ['10bit'], qualityRules: null };

  function withPrisma(over: Record<string, any> = {}) {
    const prisma = {
      rssRuleMatchCandidate: { findMany: jest.fn(async () => [rssRow]) },
      rssRule: { findMany: jest.fn(async () => [] as any[]) },
      mediaAcquisitionProfile: { findMany: jest.fn(async () => [] as any[]) },
      acquisitionMatchCandidate: { findMany: jest.fn(async () => [defaultRow]) },
      ...over,
    };
    return { svc: new AcquisitionMatchPreferenceService(prisma as any), prisma };
  }

  const item = (over: Record<string, any> = {}) =>
    ({ type: 'series', title: 'The Show', rssRuleId: null, ...over }) as any;

  it('uses the linked RSS rule’s candidates when the show has an rssRuleId', async () => {
    const { svc, prisma } = withPrisma();
    const prefs = await svc.resolveCandidates(item({ rssRuleId: 'rule-1' }));
    expect(prisma.rssRuleMatchCandidate.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { rssRuleId: 'rule-1', enabled: true } }));
    expect(prefs).toHaveLength(1);
    expect(prefs[0].qualityRules?.resolution).toBe('2160p'); // came from the RSS rule
  });

  it('finds the RSS rule by name when the show is not explicitly linked', async () => {
    // The common case: a rule named after the show exists, but the watchlist item
    // was never wired to it. Its filters must still win over the profiles.
    const { svc } = withPrisma({
      rssRule: { findMany: jest.fn(async () => [{ id: 'rule-byname', name: 'the show' }]) },
      mediaAcquisitionProfile: { findMany: jest.fn(async () => [profile1080]) },
    });
    const prefs = await svc.resolveCandidates(item());
    expect(prefs).toHaveLength(1);
    expect(prefs[0].qualityRules?.resolution).toBe('2160p'); // the RSS rule, not the profile
  });

  it('falls back to the auto-download profiles, ranked 1080p before 720p', async () => {
    const { svc } = withPrisma({
      mediaAcquisitionProfile: { findMany: jest.fn(async () => [profile720, profile1080]) },
    });
    const prefs = await svc.resolveCandidates(item());
    expect(prefs.map((p) => p.qualityRules?.resolution)).toEqual(['1080p', '720p']);
    expect(prefs.map((p) => p.priorityOrder)).toEqual([0, 1]);
  });

  it('carries the profile’s required and excluded terms into the preference tier', async () => {
    // This is the regression: "10bit" was configured on the profile but consulted
    // by nothing, so a 10bit release could be grabbed anyway.
    const { svc } = withPrisma({
      mediaAcquisitionProfile: { findMany: jest.fn(async () => [profile1080]) },
    });
    const [tier] = await svc.resolveCandidates(item());
    expect(tier.excludedTerms).toEqual(['10bit']);
    expect(tier.requiredTerms).toEqual(['x265-MeGusta']);
    expect(tier.qualityRules?.codec).toBe('x265');
  });

  it('a profile tier actually rejects the 10bit release it excludes', async () => {
    const { svc } = withPrisma({
      mediaAcquisitionProfile: { findMany: jest.fn(async () => [profile1080]) },
    });
    const prefs = await svc.resolveCandidates(item({ title: 'House of the Dragon' }));
    const tenBit = cand({ title: 'House of the Dragon S01E04 1080p 10bit WEBRip 6CH x265 HEVC-PSA', sizeBytes: 900 * 1024 * 1024 });
    const clean = cand({ downloadUrl: 'magnet:clean', title: 'House of the Dragon S01E04 1080p HEVC x265-MeGusta', sizeBytes: 900 * 1024 * 1024 });
    expect(svc.select([tenBit], prefs, 'House of the Dragon', 1, 4)).toBeNull();
    expect(svc.select([tenBit, clean], prefs, 'House of the Dragon', 1, 4)!.candidate.downloadUrl).toBe('magnet:clean');
  });

  it('falls back to the global defaults when there is no rule and no profile', async () => {
    const { svc } = withPrisma();
    const prefs = await svc.resolveCandidates(item());
    expect(prefs[0].qualityRules?.resolution).toBe('1080p'); // the default
  });

  it('falls back past a linked rule that has no enabled candidates', async () => {
    const { svc } = withPrisma({
      rssRuleMatchCandidate: { findMany: jest.fn(async () => []) },
      mediaAcquisitionProfile: { findMany: jest.fn(async () => [profile1080]) },
    });
    const prefs = await svc.resolveCandidates(item({ rssRuleId: 'rule-empty' }));
    expect(prefs[0].name).toBe('TV 1080p (auto-grab)'); // the profile, not the rule
  });

  it('looks up movie profiles for a movie watchlist item', async () => {
    const findMany = jest.fn(async () => [] as any[]);
    const { svc } = withPrisma({ mediaAcquisitionProfile: { findMany } });
    await svc.resolveCandidates(item({ type: 'movie' }));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { enabled: true, mediaType: { in: ['movie', 'any'] } } }),
    );
  });
});
