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
    // Manual matches are operator-authoritative — excluded by default.
    expect(prisma.mediaItem.findMany).toHaveBeenCalledWith({
      where: { matchStatus: { not: 'manual' } },
    });
  });

  it('honours an explicit matchStatus + libraryId filter', async () => {
    const prisma = makePrisma([]);
    const service = new MediaIdentificationService(prisma as never);

    await service.identifyBulk({ libraryId: 'L1', matchStatus: 'unmatched' });

    expect(prisma.mediaItem.findMany).toHaveBeenCalledWith({
      where: { libraryId: 'L1', matchStatus: 'unmatched' },
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
