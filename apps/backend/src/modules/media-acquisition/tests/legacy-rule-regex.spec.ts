import { AcquisitionMatchPreferenceService } from '../acquisition-match-preference.service';
import { evaluateCandidate, type MatchCandidateInput } from '../../rss/match-engine';

/**
 * Regression for the silently-dropped rule regex.
 *
 * An RSS rule filters one of two ways, and the feed path picks exactly one: its match
 * candidates if it has any, else its legacy `includeRegex`/`excludeRegex`. The
 * missing-episode path only ever read the candidates — so a regex-only rule contributed
 * NOTHING: `rssCandidates()` returned empty, resolution fell through to the profiles and
 * then the global defaults, and an operator's `excludeRegex` (an explicit "never grab
 * this") was discarded along with the rule meant to filter the show.
 */
describe('legacy include/exclude regex reaches the missing-episode path', () => {
  const rule = {
    id: 'r1',
    name: 'Foundation',
    includeRegex: 'Foundation.*1080p',
    excludeRegex: '(10bit|HDR)',
  };

  const makeSvc = (candidates: unknown[], ruleRow: unknown) =>
    new AcquisitionMatchPreferenceService({
      rssRuleMatchCandidate: { findMany: jest.fn().mockResolvedValue(candidates) },
      rssRule: {
        findUnique: jest.fn().mockResolvedValue(ruleRow),
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any);

  const item = { id: 'i', title: 'Foundation', rssRuleId: 'r1' } as any;
  const resolve = (svc: AcquisitionMatchPreferenceService) =>
    (svc as any).rssCandidates(item) as Promise<MatchCandidateInput[]>;

  it('synthesises a candidate from a rule that has ONLY regexes (was: dropped)', async () => {
    const prefs = await resolve(makeSvc([], rule));
    expect(prefs).toHaveLength(1);
    expect(prefs[0].matchType).toBe('regex');
    expect(prefs[0].pattern).toBe('Foundation.*1080p');
    expect(prefs[0].excludeRegex).toBe('(10bit|HDR)');
  });

  it("the rule's excludeRegex now actually rejects a release", async () => {
    const [pref] = await resolve(makeSvc([], rule));
    const run = (title: string) => evaluateCandidate(pref, { title }).result;

    expect(run('Foundation.S03E01.1080p.x265-GRP')).toBe('matched');
    expect(run('Foundation.S03E01.1080p.10bit.x265-GRP')).toBe('failed'); // excluded
    expect(run('Foundation.S03E01.1080p.HDR.x265-GRP')).toBe('failed'); // excluded
    expect(run('Foundation.S03E01.720p.x265-GRP')).toBe('failed'); // include regex misses
  });

  it('an exclude-only rule admits everything it does not exclude', async () => {
    const [pref] = await resolve(makeSvc([], { ...rule, includeRegex: null }));
    expect(pref.pattern).toBe('.*');
    expect(evaluateCandidate(pref, { title: 'Foundation.S03E01.720p.x265' }).result).toBe('matched');
    expect(evaluateCandidate(pref, { title: 'Foundation.S03E01.720p.10bit.x265' }).result).toBe('failed');
  });

  it('a rule with NEITHER candidates nor regex yields nothing (no match-everything)', async () => {
    const prefs = await resolve(makeSvc([], { ...rule, includeRegex: null, excludeRegex: null }));
    expect(prefs).toEqual([]);
  });

  it('real match candidates still win over the legacy regexes', async () => {
    const candidate = {
      id: 'c1',
      name: 'c',
      priorityOrder: 0,
      enabled: true,
      matchType: 'smart_episode_match',
      pattern: 'Foundation',
      requiredTerms: [],
      excludedTerms: [],
      qualityRules: {},
      sizeRules: {},
    };
    const prefs = await resolve(makeSvc([candidate], rule));
    expect(prefs).toHaveLength(1);
    expect(prefs[0].matchType).toBe('smart_episode_match');
  });

  it('an unparseable excludeRegex excludes nothing, rather than everything', () => {
    // A typo must not silently reject every release for the show.
    const pref: MatchCandidateInput = {
      id: 'x',
      name: 'x',
      priorityOrder: 0,
      enabled: true,
      matchType: 'regex',
      pattern: '.*',
      excludeRegex: '([unclosed',
      requiredTerms: [],
      excludedTerms: [],
      qualityRules: {},
      sizeRules: {},
    };
    expect(evaluateCandidate(pref, { title: 'Foundation.S03E01.1080p' }).result).toBe('matched');
  });
});
