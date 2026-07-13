import {
  evaluateCandidate,
  evaluatePreferenceList,
  MatchCandidateInput,
  normalize,
  parseRelease,
  showTitleMatch,
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

  it('elides apostrophes rather than treating them as separators', () => {
    // Release names drop the apostrophe entirely, so it must fold to the same
    // token: "grey s anatomy" would never match the "greys anatomy" on the wire.
    expect(normalize("Grey's Anatomy")).toBe('greys anatomy');
    expect(normalize('Greys.Anatomy')).toBe('greys anatomy');
    expect(normalize("Happy's Place")).toBe('happys place');
    expect(normalize('NCIS Hawai’i')).toBe('ncis hawaii'); // typographic apostrophe
  });
});

/**
 * The apostrophe cost 20 monitored shows every single grab: the indexer query
 * "Grey's Anatomy" returned nothing, and on the rare release that did come back,
 * showTitleMatch rejected it because "grey s anatomy" ≠ "greys anatomy".
 */
describe('showTitleMatch — apostrophes', () => {
  it('matches an apostrophe title against the apostrophe-less release', () => {
    expect(showTitleMatch("Grey's Anatomy", 'Greys.Anatomy.S21E07.1080p.x265-MeGusta')).toBe(true);
    expect(showTitleMatch("Happy's Place", 'Happys.Place.S02E09.1080p.HEVC.x265-MeGusta')).toBe(true);
    expect(showTitleMatch("Schitt's Creek", 'Schitts.Creek.S06E01.1080p.x265')).toBe(true);
  });

  it('still refuses a different show', () => {
    expect(showTitleMatch("Grey's Anatomy", 'Happys.Place.S02E09.1080p.x265')).toBe(false);
    expect(showTitleMatch("Happy's Place", 'Happy.Days.S02E09.1080p.x265')).toBe(false);
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

  it('contains_text: numeric words match whole title tokens, not substrings (9-1-1 over-match)', () => {
    // "9-1-1" normalizes to the words "9","1","1". These must match whole title
    // tokens — NOT appear as digits buried inside S09E07 / 1080p / etc.
    const c = cand({
      matchType: 'contains_text',
      pattern: '9-1-1 x265-MeGusta',
      qualityRules: { codec: 'x265' },
    });
    // Unrelated shows that merely contain the digits 9 and 1 somewhere → reject.
    expect(evaluateCandidate(c, { title: 'Rick and Morty S09E07 1080p HEVC x265-MeGusta' }).result).toBe('failed');
    expect(evaluateCandidate(c, { title: 'Law and Order S01E09 1080p HEVC x265-MeGusta' }).result).toBe('failed');
    // The real show, whose title tokenizes to standalone 9/1/1 → match.
    expect(evaluateCandidate(c, { title: '9-1-1 S08E05 1080p HEVC x265-MeGusta' }).result).toBe('matched');
  });

  it('contains_text: single-letter words match whole title tokens, not substrings (M.I.A over-match)', () => {
    // "M.I.A" normalizes to the words "m","i","a" — each present as a substring
    // in almost every release ("megusta" alone gives "m"+"a"). They must match
    // whole title tokens instead.
    const c = cand({
      matchType: 'contains_text',
      pattern: 'M.I.A x265-MeGusta',
      qualityRules: { codec: 'x265' },
    });
    expect(evaluateCandidate(c, { title: 'Law and Order S02E07 In Memory Of 1080p HEVC x265-MeGusta' }).result).toBe('failed');
    expect(evaluateCandidate(c, { title: 'MasterChef Australia S18E46 1080p HEVC x265-MeGusta' }).result).toBe('failed');
    // The real show, whose title tokenizes to standalone m/i/a → match.
    expect(evaluateCandidate(c, { title: 'M.I.A. S01E05 1080p HEVC x265-MeGusta' }).result).toBe('matched');
  });
  it('contains_text: multi-char title words match whole tokens, not substrings (boys ⊄ cowboys)', () => {
    const c = cand({ matchType: 'contains_text', pattern: 'The Boys 1080p x265-MeGusta', qualityRules: { codec: 'x265' } });
    // "boys" is a substring of "cowboys" but not a whole token → reject.
    expect(evaluateCandidate(c, { title: 'The McBee Dynasty Real American Cowboys S03E04 1080p HEVC x265-MeGusta' }).result).toBe('failed');
    // Real release → match.
    expect(evaluateCandidate(c, { title: 'The Boys S04E01 1080p HEVC x265-MeGusta' }).result).toBe('matched');
  });

  it('contains_text: title anchored to the show region, not the episode title (Severance collision)', () => {
    const c = cand({ matchType: 'contains_text', pattern: 'Severance 1080p x265-MeGusta', qualityRules: { codec: 'x265' } });
    // A Law & Order episode *titled* "Severance" — the word is after SxxEyy → reject.
    expect(evaluateCandidate(c, { title: 'Law and Order S02E13 Severance 1080p HEVC x265-MeGusta' }).result).toBe('failed');
    // The real show → match.
    expect(evaluateCandidate(c, { title: 'Severance S02E01 1080p HEVC x265-MeGusta' }).result).toBe('matched');
  });

  it('smart_episode_match anchors on the show title, not the episode title', () => {
    const c = cand({ matchType: 'smart_episode_match', pattern: 'Severance', qualityRules: { season: 2, episode: 13 } });
    // L&O S02E13 titled "Severance" has matching S/E but wrong show → reject.
    expect(evaluateCandidate(c, { title: 'Law and Order S02E13 Severance 1080p x265-MeGusta' }).result).toBe('failed');
    expect(evaluateCandidate(c, { title: 'Severance S02E13 1080p x265-MeGusta' }).result).toBe('matched');
  });

  it('smart_episode_match anchors to the START of the title, not a mid-title word (Rise over-match)', () => {
    // Show rule "Rise" must NOT grab a release whose title merely contains "rise".
    const c = cand({ matchType: 'smart_episode_match', pattern: 'Rise', qualityRules: { season: 1, episode: 4 } });
    expect(
      evaluateCandidate(c, { title: 'The.Pendragon.Cycle.Rise.of.the.Merlin.S01E04.1080p.HEVC.x265-MeGusta' }).result,
    ).toBe('failed');
    // The real show "Rise" (leading token) still matches.
    expect(evaluateCandidate(c, { title: 'Rise.2017.S01E04.1080p.HEVC.x265-MeGusta' }).result).toBe('matched');
  });

  it('smart_episode_match rejects a spinoff that only shares the title prefix (9-1-1 vs Lone Star)', () => {
    // "9-1-1" IS a prefix of "9-1-1 Lone Star", but the extra "Lone Star" tokens
    // mean it's a different show — must not grab it.
    const c = cand({ matchType: 'smart_episode_match', pattern: '9-1-1', qualityRules: { season: 1, episode: 2 } });
    expect(evaluateCandidate(c, { title: '9-1-1.Lone.Star.S01E02.Yee-Haw.1080p.HEVC.x265-MeGusta' }).result).toBe('failed');
    // The real 9-1-1 (bare, or with its year) still matches.
    expect(evaluateCandidate(c, { title: '9-1-1.S01E02.1080p.HEVC.x265-MeGusta' }).result).toBe('matched');
    expect(evaluateCandidate(c, { title: '9-1-1.2018.S01E02.1080p.x265-MeGusta' }).result).toBe('matched');
    // ...and the Lone Star rule matches only Lone Star.
    const ls = cand({ matchType: 'smart_episode_match', pattern: '9-1-1 Lone Star', qualityRules: { season: 1, episode: 2 } });
    expect(evaluateCandidate(ls, { title: '9-1-1.Lone.Star.S01E02.Yee-Haw.1080p.x265-MeGusta' }).result).toBe('matched');
    expect(evaluateCandidate(ls, { title: '9-1-1.S01E02.1080p.x265-MeGusta' }).result).toBe('failed');
  });

  it('smart_episode_match is leading-article insensitive and allows a trailing year', () => {
    const c = cand({ matchType: 'smart_episode_match', pattern: 'The Equalizer', qualityRules: { season: 5, episode: 5 } });
    expect(evaluateCandidate(c, { title: 'The.Equalizer.2021.S05E05.720p.x265-MeGusta' }).result).toBe('matched');
    expect(evaluateCandidate(c, { title: 'Equalizer.S05E05.720p.x265-MeGusta' }).result).toBe('matched');
  });

  it('smart_movie_match anchors to the leading title tokens, not a mid-name word', () => {
    const c = cand({ matchType: 'smart_movie_match', pattern: 'Rise', qualityRules: { year: 2017 } });
    expect(evaluateCandidate(c, { title: 'The.Pendragon.Cycle.Rise.of.the.Merlin.2017.1080p.x265' }).result).toBe('failed');
    expect(evaluateCandidate(c, { title: 'Rise.2017.1080p.x265' }).result).toBe('matched');
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
