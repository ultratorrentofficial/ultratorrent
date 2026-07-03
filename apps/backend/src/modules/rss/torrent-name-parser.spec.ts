import { parseTorrentName, buildSmartCandidates } from './torrent-name-parser';
import { evaluateCandidate, MatchCandidateInput } from './match-engine';

describe('parseTorrentName', () => {
  it('parses the canonical TV example', () => {
    const m = parseTorrentName('The.Example.Show.S02E05.1080p.WEB-DL.x265-GROUP');
    expect(m.title).toBe('The Example Show');
    expect(m.season).toBe(2);
    expect(m.episode).toBe(5);
    expect(m.resolution).toBe('1080p');
    expect(m.source).toBe('WEB-DL');
    expect(m.codec).toBe('x265');
    expect(m.releaseGroup).toBe('GROUP');
    expect(m.contentType).toBe('tv_episode');
    expect(m.confidence).toBeGreaterThanOrEqual(95);
  });

  it('explains how each field was derived', () => {
    const m = parseTorrentName('The.Example.Show.S02E05.1080p.WEB-DL.x265-GROUP');
    const byField = Object.fromEntries(m.explanations.map((e) => [e.field, e.reason]));
    expect(byField['Title']).toMatch(/before S2E5|before the tokens|before/i);
    expect(byField['Season/Episode']).toMatch(/S02E05/);
    expect(byField['Resolution']).toMatch(/1080p/);
    expect(byField['Source']).toMatch(/WEB-DL/);
    expect(byField['Codec']).toMatch(/x265/);
    expect(byField['Release Group']).toMatch(/dash/i);
  });

  it('parses 2x05 format', () => {
    const m = parseTorrentName('The Example Show - 2x05 - 1080p');
    expect(m.season).toBe(2);
    expect(m.episode).toBe(5);
    expect(m.title).toBe('The Example Show');
  });

  it('parses a movie with year', () => {
    const m = parseTorrentName('Dune.Part.Two.2024.2160p.BluRay.x265.DTS-HD.HDR-RARBG');
    expect(m.contentType).toBe('movie');
    expect(m.year).toBe(2024);
    expect(m.resolution).toBe('2160p');
    expect(m.source).toBe('BluRay');
    expect(m.codec).toBe('x265');
    expect(m.audio).toContain('DTS-HD');
    expect(m.hdr).toContain('HDR');
    expect(m.releaseGroup).toBe('RARBG');
    expect(m.title).toBe('Dune Part Two');
  });

  it('parses an anime absolute-episode release with fansub tag', () => {
    const m = parseTorrentName('[SubsPlease] Some Anime - 05 (1080p) [ABCD1234].mkv');
    expect(m.absoluteEpisode).toBe(5);
    expect(m.resolution).toBe('1080p');
    expect(m.contentType).toBe('anime_episode');
    expect(m.title).toBe('Some Anime');
  });

  it('detects proper/repack and atmos/DV', () => {
    const m = parseTorrentName('Show.S01E01.REPACK.PROPER.2160p.WEB-DL.DDP.Atmos.DV.x265-NTb');
    expect(m.repack).toBe(true);
    expect(m.proper).toBe(true);
    expect(m.audio).toEqual(expect.arrayContaining(['Atmos', 'DDP']));
    expect(m.hdr).toContain('DV');
  });

  it('parses a daily show date', () => {
    const m = parseTorrentName('Some.Late.Show.2026.05.12.1080p.WEB.h264-XYZ');
    expect(m.airDate).toBe('2026-05-12');
    expect(m.contentType).toBe('daily');
    expect(m.title).toBe('Some Late Show');
  });

  it('warns on a thin name', () => {
    const m = parseTorrentName('randomfile');
    expect(m.warnings.length).toBeGreaterThan(0);
    expect(m.confidence).toBeLessThan(60);
  });
});

describe('buildSmartCandidates', () => {
  const meta = parseTorrentName('The.Example.Show.S02E05.1080p.WEB-DL.x265-GROUP');
  const candidates = buildSmartCandidates(meta);

  it('produces 4 ranked candidates (smart, regex, normalized, fuzzy)', () => {
    expect(candidates.map((c) => c.matchType)).toEqual([
      'smart_episode_match', 'regex', 'contains_text', 'fuzzy_match',
    ]);
    expect(candidates[0].confidence).toBe('high');
  });

  it('smart candidate carries season/episode + quality', () => {
    const q = candidates[0].qualityRules;
    expect(q.season).toBe(2);
    expect(q.episode).toBe(5);
    expect(q.resolution).toBe('1080p');
    expect(q.source).toBe('WEB-DL');
    expect(q.codec).toBe('x265');
  });

  it('every generated candidate actually matches the source release', () => {
    const title = 'The.Example.Show.S02E05.1080p.WEB-DL.x265-GROUP';
    candidates.forEach((c, i) => {
      const input: MatchCandidateInput = {
        id: String(i), name: c.name, priorityOrder: i + 1, enabled: true,
        matchType: c.matchType, pattern: c.pattern,
        requiredTerms: c.requiredTerms, excludedTerms: c.excludedTerms,
        qualityRules: c.qualityRules, sizeRules: {}, feedScope: {},
      };
      const r = evaluateCandidate(input, { title });
      expect(r.result).toBe('matched');
    });
  });

  it('builds smart_movie_match for movies', () => {
    const mv = buildSmartCandidates(parseTorrentName('Dune.2024.1080p.BluRay.x264-AMIABLE'));
    expect(mv[0].matchType).toBe('smart_movie_match');
    expect(mv[0].qualityRules.year).toBe(2024);
  });
});
