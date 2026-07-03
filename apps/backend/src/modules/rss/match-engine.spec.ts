import {
  evaluateCandidate,
  evaluatePreferenceList,
  MatchCandidateInput,
  normalize,
  parseRelease,
  toRegexPattern,
} from './match-engine';

const cand = (over: Partial<MatchCandidateInput>): MatchCandidateInput => ({
  id: over.id ?? 'c',
  name: over.name ?? 'candidate',
  priorityOrder: over.priorityOrder ?? 1,
  enabled: over.enabled ?? true,
  matchType: over.matchType ?? 'contains_text',
  pattern: over.pattern ?? '',
  requiredTerms: over.requiredTerms,
  excludedTerms: over.excludedTerms,
  qualityRules: over.qualityRules,
  sizeRules: over.sizeRules,
  feedScope: over.feedScope,
});

describe('normalize', () => {
  it('folds separators and casing', () => {
    expect(normalize('Show.Name_S02-E05')).toBe('show name s02 e05');
  });
});

describe('parseRelease', () => {
  it('detects S02E05', () => {
    const p = parseRelease('Show.Name.S02E05.1080p.WEB-DL.x265');
    expect(p.season).toBe(2);
    expect(p.episode).toBe(5);
    expect(p.resolution).toBe('1080p');
    expect(p.source).toBe('webdl');
    expect(p.codec).toBe('x265');
  });
  it('detects 2x05 format', () => {
    const p = parseRelease('Show Name - 2x05 - 1080p');
    expect(p.season).toBe(2);
    expect(p.episode).toBe(5);
  });
  it('detects "Season 2 Episode 5"', () => {
    const p = parseRelease('Show Name Season 2 Episode 5 HDTV');
    expect(p.season).toBe(2);
    expect(p.episode).toBe(5);
    expect(p.source).toBe('hdtv');
  });
  it('maps 4k/uhd to 2160p and flags bad quality', () => {
    const p = parseRelease('Movie.2026.4K.CAM.x264');
    expect(p.resolution).toBe('2160p');
    expect(p.year).toBe(2026);
    expect(p.badQuality).toContain('cam');
  });
  it('flags repack/proper', () => {
    const p = parseRelease('Show.S01E01.REPACK.PROPER.1080p');
    expect(p.repack).toBe(true);
    expect(p.proper).toBe(true);
  });
});

describe('match types', () => {
  const title = 'The.Example.Show.S02E05.1080p.WEB-DL.x265';

  it('regex', () => {
    expect(evaluateCandidate(cand({ matchType: 'regex', pattern: 'The\\.Example\\.Show\\.S02E05\\.1080p.*' }), { title }).result).toBe('matched');
    expect(evaluateCandidate(cand({ matchType: 'regex', pattern: 'Nope.*' }), { title }).result).toBe('failed');
  });
  it('invalid regex fails gracefully', () => {
    const r = evaluateCandidate(cand({ matchType: 'regex', pattern: '([' }), { title });
    expect(r.result).toBe('failed');
    expect(r.reason).toMatch(/invalid/i);
  });
  it('contains_text (separator-insensitive)', () => {
    expect(evaluateCandidate(cand({ matchType: 'contains_text', pattern: 'the example show' }), { title }).result).toBe('matched');
  });
  it('contains_text is token-AND: all words present, order/gaps ignored', () => {
    // Every word appears (with an episode token in between) → match.
    const c = cand({ matchType: 'contains_text', pattern: 'Agent Kim Reactivated XviD-AFG' });
    expect(evaluateCandidate(c, { title: 'Agent Kim Reactivated S01E03 XviD-AFG' }).result).toBe('matched');
    // A word that is absent from the title → no match, and it is named.
    const miss = cand({ matchType: 'contains_text', pattern: 'Agent Kim Reactivated 1080p' });
    const r = evaluateCandidate(miss, { title: 'Agent Kim Reactivated S01E03 XviD-AFG' });
    expect(r.result).toBe('failed');
    expect(r.reason).toMatch(/1080p/);
  });
  it('wildcard', () => {
    expect(evaluateCandidate(cand({ matchType: 'wildcard', pattern: 'The.Example.Show*1080p*' }), { title }).result).toBe('matched');
  });
  it('smart_episode_match', () => {
    const c = cand({ matchType: 'smart_episode_match', pattern: 'The Example Show', qualityRules: { season: 2, episode: 5, resolution: '1080p' } });
    expect(evaluateCandidate(c, { title }).result).toBe('matched');
    const wrong = cand({ matchType: 'smart_episode_match', pattern: 'The Example Show', qualityRules: { season: 2, episode: 6 } });
    expect(evaluateCandidate(wrong, { title }).result).toBe('failed');
  });
  it('smart_movie_match with year', () => {
    const c = cand({ matchType: 'smart_movie_match', pattern: 'The Example Movie', qualityRules: { year: 2026 } });
    expect(evaluateCandidate(c, { title: 'The.Example.Movie.2026.1080p.BluRay.x264' }).result).toBe('matched');
  });
  it('fuzzy_match', () => {
    const c = cand({ matchType: 'fuzzy_match', pattern: 'The Example Show season 2 episode 5' });
    expect(evaluateCandidate(c, { title }).result).toBe('matched');
    const c2 = cand({ matchType: 'fuzzy_match', pattern: 'Completely Different Title Here' });
    expect(evaluateCandidate(c2, { title }).result).toBe('failed');
  });
});

describe('term and quality constraints', () => {
  const title = 'The.Example.Show.S02E05.720p.WEBRip';
  it('fails on missing required term', () => {
    const r = evaluateCandidate(cand({ matchType: 'contains_text', pattern: 'example show', requiredTerms: ['1080p'] }), { title });
    expect(r.result).toBe('failed');
    expect(r.reason).toMatch(/1080p/);
  });
  it('fails on excluded term', () => {
    const r = evaluateCandidate(cand({ matchType: 'contains_text', pattern: 'example show', excludedTerms: ['WEBRip'] }), { title });
    expect(r.result).toBe('failed');
    expect(r.reason).toMatch(/excluded/i);
  });
  it('enforces resolution quality rule', () => {
    const r = evaluateCandidate(cand({ matchType: 'contains_text', pattern: 'example show', qualityRules: { resolution: '1080p' } }), { title });
    expect(r.result).toBe('failed');
  });
  it('enforces size rules when size known', () => {
    const c = cand({ matchType: 'contains_text', pattern: 'example show', sizeRules: { minBytes: 1_000_000 } });
    expect(evaluateCandidate(c, { title, sizeBytes: 500_000 }).result).toBe('failed');
    expect(evaluateCandidate(c, { title, sizeBytes: 2_000_000 }).result).toBe('matched');
    // unknown size: rule is skipped, candidate still matches
    expect(evaluateCandidate(c, { title, sizeBytes: null }).result).toBe('matched');
  });
});

describe('feed scope', () => {
  it('skips candidate when feed not in scope', () => {
    const c = cand({ matchType: 'contains_text', pattern: 'show', feedScope: { feedIds: ['feed-a'] } });
    expect(evaluateCandidate(c, { title: 'a show', feedId: 'feed-b' }).result).toBe('skipped');
    expect(evaluateCandidate(c, { title: 'a show', feedId: 'feed-a' }).result).toBe('matched');
  });
});

describe('evaluatePreferenceList', () => {
  const candidates: MatchCandidateInput[] = [
    cand({ id: '1', priorityOrder: 1, matchType: 'regex', pattern: 'The\\.Example\\.Show\\.S02E05\\.1080p.*' }),
    cand({ id: '2', priorityOrder: 2, matchType: 'regex', pattern: 'The Example Show - 2x05 - 1080p.*' }),
    cand({ id: '3', priorityOrder: 3, matchType: 'contains_text', pattern: 'The Example Show S02E05' }),
    cand({ id: '4', priorityOrder: 4, matchType: 'smart_episode_match', pattern: 'The Example Show', qualityRules: { season: 2, episode: 5 } }),
    cand({ id: '5', priorityOrder: 5, matchType: 'fuzzy_match', pattern: 'The Example Show season 2 episode 5' }),
  ];

  it('stops at first match and skips the rest', () => {
    const evalres = evaluatePreferenceList(candidates, { title: 'The.Example.Show.S02E05.1080p.WEB-DL' });
    expect(evalres.matched).toBe(true);
    expect(evalres.matchedCandidateId).toBe('1');
    expect(evalres.action).toBe('download');
    expect(evalres.candidates.slice(1).every((c) => c.result === 'skipped')).toBe(true);
  });

  it('falls through to a lower-priority candidate', () => {
    const evalres = evaluatePreferenceList(candidates, { title: 'The Example Show - 2x05 - 1080p HDTV' });
    expect(evalres.matchedCandidateId).toBe('2');
    expect(evalres.candidates[0].result).toBe('failed');
    expect(evalres.candidates[2].result).toBe('skipped');
  });

  it('smart/fuzzy fallback catches odd formats', () => {
    const evalres = evaluatePreferenceList(candidates, { title: 'The Example Show 2026 Season 2 Episode 5 HD' });
    expect(evalres.matched).toBe(true);
    // candidates 1-3 fail, smart episode (4) matches
    expect(evalres.matchedCandidateId).toBe('4');
  });

  it('reports no match when nothing fits', () => {
    const evalres = evaluatePreferenceList(candidates, { title: 'Some Other Show S01E01 720p' });
    expect(evalres.matched).toBe(false);
    expect(evalres.action).toBe('none');
  });

  it('disabled candidates are not evaluated as matches', () => {
    const list = [cand({ id: 'd', priorityOrder: 1, enabled: false, matchType: 'contains_text', pattern: 'show' })];
    const evalres = evaluatePreferenceList(list, { title: 'a show' });
    expect(evalres.matched).toBe(false);
    expect(evalres.candidates[0].result).toBe('disabled');
  });
});

describe('toRegexPattern', () => {
  it('converts text into a separator-tolerant regex', () => {
    const rx = toRegexPattern('The Example Show');
    expect(new RegExp(rx, 'i').test('The.Example.Show.1080p')).toBe(true);
  });
});
