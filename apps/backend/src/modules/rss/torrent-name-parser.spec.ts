import { parseTorrentName, buildSmartCandidates, releaseIdentity } from './torrent-name-parser';
import { evaluateCandidate, MatchCandidateInput } from './match-engine';

describe('releaseIdentity', () => {
  it('is quality-independent for a movie (same title+year across releases)', () => {
    const bluray = releaseIdentity('Michael 2024 1080p BluRay x264-GRP');
    const webrip = releaseIdentity('Michael.2024.1080p.WEBRip.x265-OTHER');
    expect(bluray).toBe('movie:michael:2024');
    expect(webrip).toBe(bluray);
  });

  it('keys an episode by show + season + episode', () => {
    expect(releaseIdentity('The.Example.Show.S02E05.1080p.WEB-DL.x265-GROUP')).toBe(
      'ep:the example show:2:5',
    );
  });

  it('returns null when the release shape is unidentifiable', () => {
    expect(releaseIdentity('random blob of text')).toBeNull();
  });
});

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

  it('strips a parenthesized (Year) from an episode title (9-1-1)', () => {
    // The "(2018)" release year must end the title even though S01E01 follows,
    // otherwise the title folds it in as "9-1-1 2018" and splits the show.
    const m = parseTorrentName('9-1-1 (2018) - S01E01 - Pilot.mkv');
    expect(m.title).toBe('9-1-1');
    expect(m.year).toBe(2018);
    expect(m.season).toBe(1);
    expect(m.episode).toBe(1);
    expect(m.contentType).toBe('tv_episode');
  });

  it('strips a bare year that sits right before the episode marker (Hijack)', () => {
    // "Hijack.2023.S02E03" — the bare 2023 is the series year, not part of the
    // title. Left in, it forks the show into "Hijack 2023" and misses the
    // provider lookup (no episode titles). Adjacency to S02E03 is what marks it.
    const m = parseTorrentName('Hijack.2023.S02E03.1080p.HEVC.x265-MeGusta');
    expect(m.title).toBe('Hijack');
    expect(m.year).toBe(2023);
    expect(m.season).toBe(2);
    expect(m.episode).toBe(3);
    expect(m.contentType).toBe('tv_episode');
  });

  it('keeps a leading numeric/year title before an episode marker (1883-style)', () => {
    // A year at position 0 is the title, never a boundary.
    const m = parseTorrentName('2020.S01E01.1080p.WEB.h264-GRP');
    expect(m.title).toBe('2020');
    expect(m.season).toBe(1);
    expect(m.episode).toBe(1);
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

  it('keeps a numeric title when it collides with a parenthesized year', () => {
    // "1917" is a valid year, but here it is the title; the real year is (2019).
    const m = parseTorrentName('1917 (2019) [1080p].mp4');
    expect(m.title).toBe('1917');
    expect(m.year).toBe(2019);
    expect(m.contentType).toBe('movie');
    expect(m.resolution).toBe('1080p');
  });

  it('prefers the parenthesized release year over a leading numeric title', () => {
    const m = parseTorrentName('1992 (2024) 1080p AAC.mp4');
    expect(m.title).toBe('1992');
    expect(m.year).toBe(2024);
    expect(m.contentType).toBe('movie');
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

describe('parseTorrentName — dotted acronyms in titles', () => {
  it("keeps an acronym's dots instead of shattering it into letters", () => {
    // The '.'/'_' → space pass exists for scene releases; it must not destroy a
    // title whose dots are part of an acronym.
    expect(parseTorrentName("L.A.'s Finest - S02E10 - Deliver Us From Evil.avi").title).toBe(
      "L.A.'s Finest",
    ); // was "L A 's Finest"
    expect(parseTorrentName('Chicago P.D. - S01E01 - Stepping Stone.mkv').title).toBe(
      'Chicago P.D.',
    ); // was "Chicago P D"
  });

  it('handles a dot-separated scene release whose title is an acronym', () => {
    const p = parseTorrentName('S.W.A.T.2017.S01E01.1080p.WEB.x264-GRP.mkv');
    expect(p.title).toBe('S.W.A.T.');
    expect(p.year).toBe(2017);
    expect(p.season).toBe(1);
    expect(p.episode).toBe(1);
  });

  it('still collapses ordinary scene-release dot separators to spaces', () => {
    expect(parseTorrentName('Show.Name.S01E01.1080p.WEB-DL.x264-GRP.mkv').title).toBe('Show Name');
    expect(parseTorrentName('Person.of.Interest.S01E01.720p.HDTV.x264-CTU.mkv').title).toBe(
      'Person of Interest',
    );
  });

  it('does not mistake a leading single-letter word for an acronym', () => {
    // "A." is one letter+dot — an acronym needs at least two, so this stays a word.
    const p = parseTorrentName('A.Quiet.Place.2018.1080p.BluRay.x264-GRP.mkv');
    expect(p.title).toBe('A Quiet Place');
    expect(p.year).toBe(2018);
  });

  describe('multi-episode files (one file, several episodes)', () => {
    // A two-part premiere ships as ONE long file. Recording only the first episode
    // leaves the rest looking missing forever, and the hunt for that phantom episode is
    // what grabbed a wrong-show release on a live library.
    it.each([
      // The real filename from the library that caused it — an 88-minute two-parter.
      ['The Librarians - S01E01 S01E02 - And the Crown of King Arthur.mkv', 1, 1, 2],
      ['Show.S01E01-E02.1080p.WEB.x264-GRP.mkv', 1, 1, 2],
      ['Show.S01E01E02.1080p.mkv', 1, 1, 2],
      ['Show.S02E05-06.720p.HDTV.mkv', 2, 5, 6],
      ['Show S03E09 E10 1080p.mkv', 3, 9, 10],
    ])('%s → S%sE%s–E%s', (name, season, episode, end) => {
      const p = parseTorrentName(name);
      expect(p.season).toBe(season);
      expect(p.episode).toBe(episode);
      expect(p.episodeEnd).toBe(end);
    });

    it.each([
      // An ordinary single episode claims no span.
      ['Show.S01E01.1080p.WEB.x264-GRP.mkv'],
      // The "02" here is a resolution/codec artefact, not an episode.
      ['Show.S01E01.1080p.x264.mkv'],
      // A backwards range is a misread — claim nothing rather than invent coverage.
      ['Show.S01E05-E02.1080p.mkv'],
      // A different season's marker is not a span.
      ['Show.S01E01.S02E01.1080p.mkv'],
    ])('%s → no span', (name) => {
      expect(parseTorrentName(name).episodeEnd).toBeNull();
    });

    it('never invents coverage the library does not have', () => {
      // An absurd span would silently mark a dozen episodes owned. Refuse it.
      expect(parseTorrentName('Show.S01E01-E99.1080p.mkv').episodeEnd).toBeNull();
    });
  });

  describe('"Part N" in a film title', () => {
    // Cutting the title at "Part N" renamed the sequel to the first film, which then
    // matched the first film on TMDB and inherited its ids — the two rows came back
    // as one "duplicate" on a live library.
    it.each([
      ['South Park the Streaming Wars Part 2 (2022) 1080p AAC.mp4', 'South Park the Streaming Wars Part 2', 2],
      ['Harry.Potter.and.the.Deathly.Hallows.Part.1.2010.1080p.BluRay.x264-GRP', 'Harry Potter and the Deathly Hallows Part 1', 1],
      ['Kill.Bill.Vol.2.2004.1080p.BluRay.x264-GRP', 'Kill Bill Vol 2', null],
    ])('%s → %s', (name, title, part) => {
      const p = parseTorrentName(name);
      expect(p.title).toBe(title);
      expect(p.part).toBe(part);
    });

    it('still ends the title at "Part N" for an episodic release', () => {
      // Here "Part 2" numbers a multi-part episode, not the show.
      const p = parseTorrentName('Show.Name.S01E01.Part.2.1080p.WEB.x264-GRP');
      expect(p.title).toBe('Show Name');
      expect(p.part).toBe(2);
      expect(p.season).toBe(1);
    });

    it('keeps treating a spelled-out part as title text', () => {
      expect(parseTorrentName('Dune.Part.Two.2024.2160p.BluRay-GRP').title).toBe('Dune Part Two');
    });
  });
});
