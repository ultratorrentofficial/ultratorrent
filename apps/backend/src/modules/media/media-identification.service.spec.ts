import { MediaIdentificationService } from './media-identification.service';

/**
 * These tests pin the two fixes that stopped cleanly-organised TV libraries
 * from scanning entirely as "unmatched":
 *   1. folder-context parsing — recover the series title from the parent folder
 *      when the filename alone omits it (`Show/Season 01/S01E01.mkv`);
 *   2. identity-weighted confidence — a title plus an episodic marker (or a
 *      movie year) clears the match threshold without needing scene tokens.
 */
describe('MediaIdentificationService.identify', () => {
  // update() echoes the persisted `data` back so we can assert on it directly.
  const makePrisma = () => ({
    mediaItem: {
      update: jest.fn().mockImplementation(({ data }: { data: unknown }) => data),
      findUnique: jest.fn(),
    },
    mediaLibrary: { findUnique: jest.fn().mockResolvedValue(null) },
    mediaExternalId: { findUnique: jest.fn().mockResolvedValue(null) },
    iMDbEpisode: { findUnique: jest.fn().mockResolvedValue(null) },
    iMDbTitle: { findUnique: jest.fn().mockResolvedValue(null) },
  });

  // `libraryKind` (when set) is passed straight through, so classification tests
  // don't need to mock the library lookup.
  const identify = (path: string, mediaType = 'tv', libraryKind?: string) => {
    const prisma = makePrisma();
    const service = new MediaIdentificationService(prisma as never);
    return service.identify(
      { id: 'I1', libraryId: 'L1', path, title: '', mediaType } as never,
      libraryKind,
    );
  };

  it('recovers the series title from the folder for a title-less episode file', async () => {
    const res: any = await identify('/media/TV Shows/Breaking Bad/Season 01/S01E01.mkv');
    expect(res.title).toBe('Breaking Bad');
    expect(res.season).toBe(1);
    expect(res.episode).toBe(1);
    expect(res.matchStatus).toBe('matched');
    expect(res.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('skips generic "Specials" containers when climbing for the title', async () => {
    const res: any = await identify('/media/TV/Doctor Who/Specials/S00E01.mkv');
    expect(res.title).toBe('Doctor Who');
    expect(res.matchStatus).toBe('matched');
  });

  it('matches a cleanly-named episode with the title in the filename', async () => {
    const res: any = await identify('/media/TV/The Office/Season 01/The Office - S01E01.mkv');
    expect(res.title).toBe('The Office');
    expect(res.season).toBe(1);
    expect(res.episode).toBe(1);
    expect(res.matchStatus).toBe('matched');
    // title (0.4) + season/episode (0.4) with no scene tokens.
    expect(res.confidence).toBe(0.8);
  });

  it('matches a movie on title + year alone', async () => {
    const res: any = await identify('/media/Movies/The Matrix (1999)/The Matrix (1999).mkv', 'movie');
    expect(res.title).toBe('The Matrix');
    expect(res.year).toBe(1999);
    expect(res.matchStatus).toBe('matched');
  });

  it('still matches a full scene release (no regression)', async () => {
    const res: any = await identify('/dl/Show.Name.S02E05.1080p.WEB-DL.x264-GRP.mkv');
    expect(res.matchStatus).toBe('matched');
    expect(res.confidence).toBe(1);
  });

  it('leaves an unidentifiable file unmatched', async () => {
    const res: any = await identify('/media/TV/misc/random.mkv');
    expect(res.matchStatus).toBe('unmatched');
    expect(res.confidence).toBeLessThan(0.5);
  });

  // A TV library holds shows: a name carrying a year but no episode marker
  // (e.g. the show folder "9-1-1 (2018)") must not be inferred as a movie.
  it("classifies a year-only name in a TV library as tv, not movie (9-1-1)", async () => {
    const res: any = await identify(
      '/media/TV/9-1-1 (2018)/9-1-1 (2018).mkv',
      'movie', // stale ingest guess — the library kind must win
      'tv',
    );
    expect(res.mediaType).toBe('tv');
    expect(res.title).toBe('9-1-1');
    expect(res.year).toBe(2018);
  });

  // The parenthesized release year must be stripped from the title even when an
  // episode marker follows — otherwise the title becomes "9-1-1 2018" and splits
  // the show / breaks the metadata lookup.
  it('keeps the title clean for "Show (Year) - SxxEyy" episodes (9-1-1)', async () => {
    const res: any = await identify(
      '/media/TV/9-1-1 (2018)/Season 01/9-1-1 (2018) - S01E01 - Pilot.mkv',
      'tv',
      'tv',
    );
    expect(res.mediaType).toBe('tv');
    expect(res.title).toBe('9-1-1');
    expect(res.season).toBe(1);
    expect(res.episode).toBe(1);
  });

  it('respects a movie library even for an episode-shaped name', async () => {
    const res: any = await identify('/media/Movies/Some.Film.S01E01.mkv', 'movie', 'movie');
    expect(res.mediaType).toBe('movie');
  });

  // The 9-1-1 (2018) case: episode files named by *episode* title (no show name)
  // in a "Show/Season N/" layout must adopt the show-folder title, not fragment.
  it('adopts the show-folder title when the filename leads with the episode name (9-1-1)', async () => {
    const res: any = await identify(
      "/downloads/TV Shows/9-1-1 (2018)/Season 9/Contraband Seized at the Border - S09E04 - The Meth Doesn't Add Up.mkv",
      'tv',
      'tv',
    );
    expect(res.title).toBe('9-1-1');
    expect(res.season).toBe(9);
    expect(res.episode).toBe(4);
    expect(res.mediaType).toBe('tv');
  });

  // Guard: a loose scene release NOT inside a Season container keeps its filename
  // title — the parent is a junk/download dir, not the show folder.
  it('keeps the filename title for a loose scene release (no Season container)', async () => {
    const res: any = await identify('/downloads/Show.Name.S02E05.1080p.WEB-DL.x264-GRP.mkv');
    expect(res.title).toBe('Show Name');
    expect(res.season).toBe(2);
    expect(res.episode).toBe(5);
  });

  it('records the episode span of a two-part premiere in one file', async () => {
    const res: any = await identify(
      '/media/TV Shows/The Librarians/Season 1/The Librarians - S01E01 S01E02 - And the Crown of King Arthur.mkv',
    );
    expect(res.season).toBe(1);
    expect(res.episode).toBe(1);
    expect(res.episodeEnd).toBe(2); // else E02 reads as missing forever
  });

  describe('inherited series id that cannot contain the episode', () => {
    // The id on an episode is only as good as the NFO the library inherited, and that
    // can simply be WRONG: a library filed as "The Librarians (2007)" (an Australian
    // comedy, 3 seasons) actually held TNT's "The Librarians" (2014). Its S04 episodes
    // were matched to the 2007 series anyway — a series with three seasons cannot have
    // a fourth. Once that bad id is on the item it poisons the missing-episode diff,
    // which then grabs releases of a different show.
    const prismaWith = (catalogued: { season: number; count: number }[], anyEpisodes: number) => ({
      mediaItem: { update: jest.fn().mockImplementation(({ data }: any) => data), findUnique: jest.fn() },
      mediaLibrary: { findUnique: jest.fn().mockResolvedValue(null) },
      mediaExternalId: {
        findUnique: jest.fn().mockResolvedValue({ externalId: 'tt0934744', provider: 'imdb' }),
      },
      iMDbEpisode: {
        findUnique: jest.fn().mockResolvedValue(null), // the id is a SERIES, not an episode
        count: jest.fn().mockImplementation(({ where }: any) =>
          where.seasonNumber == null
            ? anyEpisodes
            : (catalogued.find((c) => c.season === where.seasonNumber)?.count ?? 0),
        ),
      },
      iMDbTitle: {
        findUnique: jest.fn().mockResolvedValue({ tconst: 'tt0934744', titleType: 'tvSeries' }),
      },
    });

    const identifyWith = (prisma: any, path: string) =>
      new MediaIdentificationService(prisma as never).identify(
        { id: 'I1', libraryId: 'L1', path, title: '', mediaType: 'tv' } as never,
        'tv',
      );

    it('refuses the id when the series has no such season at all', async () => {
      // Catalogue knows seasons 1-3. The file claims S04 — the claim refutes itself.
      const prisma = prismaWith([{ season: 1, count: 6 }, { season: 2, count: 6 }, { season: 3, count: 8 }], 20);
      const res: any = await identifyWith(
        prisma,
        '/media/TV Shows/The Librarians (2007)/Season 4/The Librarians - S04E11 - And the Trial of the One.mkv',
      );
      expect(res.season).toBe(4);
      expect(res.seriesImdbId).toBeNull(); // poisoned id rejected, not persisted
    });

    it('still accepts an episode the series genuinely has', async () => {
      const prisma = prismaWith([{ season: 1, count: 6 }], 20);
      const res: any = await identifyWith(
        prisma,
        '/media/TV Shows/The Librarians (2007)/Season 1/The Librarians - S01E03 - 4 Kilos to Book Week.mkv',
      );
      expect(res.seriesImdbId).toBe('tt0934744');
    });

    it('does not distrust an id merely because the catalogue is empty', async () => {
      // An uncatalogued series tells us nothing. Rejecting on no evidence would unmatch
      // half a library — a brand-new episode is routinely not in the dataset yet.
      const prisma = prismaWith([], 0);
      const res: any = await identifyWith(
        prisma,
        '/media/TV Shows/Some Show/Season 9/Some Show - S09E01 - Pilot.mkv',
      );
      expect(res.seriesImdbId).toBe('tt0934744');
    });
  });
});

describe('MediaIdentificationService.identifyBulk', () => {
  const item = (id: string, path: string, mediaType = 'tv') => ({
    id,
    path,
    title: '',
    mediaType,
  });

  const makePrisma = (items: unknown[]) => ({
    mediaItem: {
      findMany: jest.fn().mockResolvedValue(items),
      update: jest.fn().mockImplementation(({ data }: { data: unknown }) => data),
      findUnique: jest.fn(),
    },
    mediaLibrary: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null) },
    mediaExternalId: { findUnique: jest.fn().mockResolvedValue(null) },
    iMDbEpisode: { findUnique: jest.fn().mockResolvedValue(null) },
    iMDbTitle: { findUnique: jest.fn().mockResolvedValue(null) },
  });

  it('re-identifies every non-manual item and tallies the outcomes', async () => {
    const prisma = makePrisma([
      item('A', '/tv/Breaking Bad/Season 01/S01E01.mkv'), // matched (folder title)
      item('B', '/tv/misc/random.mkv'), // unmatched
    ]);
    const service = new MediaIdentificationService(prisma as never);

    const summary = await service.identifyBulk();

    expect(summary).toEqual({ total: 2, matched: 1, unmatched: 1, failed: 0 });
    // Manual matches are operator-authoritative — excluded by default; locked
    // items are excluded unconditionally.
    expect(prisma.mediaItem.findMany).toHaveBeenCalledWith({
      where: { locked: false, matchStatus: { not: 'manual' } },
    });
  });

  it('honours an explicit matchStatus + libraryId filter', async () => {
    const prisma = makePrisma([]);
    const service = new MediaIdentificationService(prisma as never);

    await service.identifyBulk({ libraryId: 'L1', matchStatus: 'unmatched' });

    expect(prisma.mediaItem.findMany).toHaveBeenCalledWith({
      where: { locked: false, libraryId: 'L1', matchStatus: 'unmatched' },
    });
  });

  it('isolates per-item failures and reports progress', async () => {
    const prisma = makePrisma([
      item('A', '/tv/Breaking Bad/Season 01/S01E01.mkv'),
      item('B', '/tv/The Office/Season 01/The Office - S01E01.mkv'),
    ]);
    // First identify() throws, second succeeds.
    prisma.mediaItem.update
      .mockImplementationOnce(() => {
        throw new Error('db down');
      })
      .mockImplementation(({ data }: { data: unknown }) => data);
    const service = new MediaIdentificationService(prisma as never);
    const report = jest.fn().mockResolvedValue(undefined);

    const summary = await service.identifyBulk({}, report);

    expect(summary).toEqual({ total: 2, matched: 1, unmatched: 0, failed: 1 });
    expect(report).toHaveBeenLastCalledWith(100, 'Identified 2/2');
  });
});
