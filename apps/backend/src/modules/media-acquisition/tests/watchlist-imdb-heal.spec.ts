import { AcquisitionWatchlistService } from '../watchlist.service';
import { ImdbSeriesResolver } from '../imdb-series-resolver.service';
import { Table } from './fake-prisma';

function build() {
  const prisma = {
    mediaItem: new Table('item'),
    mediaLibrary: new Table('lib'),
    mediaAcquisitionWatchlistItem: new Table('wl'),
    tvShowStatus: new Table('status'),
    iMDbTitle: new Table('title'),
    iMDbEpisode: new Table('ep'),
  } as any;
  prisma.mediaLibrary.rows.push({ path: '/tv' });
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const realtime = { broadcast: jest.fn() };
  const moduleRef = { get: () => { throw new Error('no TvShowStatusService in test'); } };
  const resolver = new ImdbSeriesResolver(prisma);
  const svc = new AcquisitionWatchlistService(prisma as any, audit as any, realtime as any, moduleRef as any, resolver);
  return { svc, prisma, audit };
}

/** One episode file of a show, under `/tv/<folder>/Season 01/`. */
function episode(prisma: any, id: string, folder: string, file: string, seriesImdbId: string | null = null) {
  prisma.mediaItem.rows.push({
    id,
    mediaType: 'tv',
    title: file,
    year: null,
    path: `/tv/${folder}/Season 01/${file}.mkv`,
    seriesImdbId,
    externalIds: [],
  });
}

function seedSeries(prisma: any, tconst: string, primaryTitle: string, startYear: number, episodes: number) {
  prisma.iMDbTitle.rows.push({ tconst, primaryTitle, startYear, titleType: 'tvSeries' });
  for (let i = 0; i < episodes; i++) {
    prisma.iMDbEpisode.rows.push({ episodeTitleId: `${tconst}-e${i}`, parentTitleId: tconst, seasonNumber: 1, episodeNumber: i + 1 });
  }
}

describe('AcquisitionWatchlistService.healLibraryImdbIds', () => {
  it('resolves a show with no IMDb id and writes the tconst onto every one of its items', async () => {
    const { svc, prisma } = build();
    episode(prisma, 'i1', 'Batwoman (2019)', 'Batwoman - S01E01');
    episode(prisma, 'i2', 'Batwoman (2019)', 'Batwoman - S01E02');
    seedSeries(prisma, 'ttBW', 'Batwoman', 2019, 51);

    const summary = await svc.healLibraryImdbIds();

    expect(summary).toMatchObject({ candidates: 1, attempted: 1, resolved: 1, unresolved: 0 });
    expect(prisma.mediaItem.rows.map((r: any) => r.seriesImdbId)).toEqual(['ttBW', 'ttBW']);
  });

  it('leaves a show that already has an IMDb id alone', async () => {
    const { svc, prisma } = build();
    episode(prisma, 'i1', 'Supergirl (2015)', 'Supergirl - S01E01', 'ttEXISTING');
    seedSeries(prisma, 'ttSG', 'Supergirl', 2015, 126);

    const summary = await svc.healLibraryImdbIds();

    expect(summary).toMatchObject({ candidates: 0, attempted: 0, resolved: 0 });
    expect(prisma.mediaItem.rows[0].seriesImdbId).toBe('ttEXISTING'); // not overwritten
  });

  it('counts a show the catalogue cannot match as unresolved, and writes nothing', async () => {
    const { svc, prisma } = build();
    episode(prisma, 'i1', 'Some Obscure Show (2019)', 'Some Obscure Show - S01E01');

    const summary = await svc.healLibraryImdbIds();

    expect(summary).toMatchObject({ candidates: 1, attempted: 1, resolved: 0, unresolved: 1 });
    expect(prisma.mediaItem.rows[0].seriesImdbId).toBeNull();
  });

  it('matches the folder title across accents/punctuation and its year', async () => {
    const { svc, prisma } = build();
    episode(prisma, 'i1', '90 Day Fiance (2014)', '90 Day Fiance - S01E01');
    seedSeries(prisma, 'tt90', '90 Day Fiancé', 2014, 174);

    const summary = await svc.healLibraryImdbIds();

    expect(summary.resolved).toBe(1);
    expect(prisma.mediaItem.rows[0].seriesImdbId).toBe('tt90');
  });

  it('resolves a folder that is still a raw scene-release name (never renamed)', async () => {
    const { svc, prisma } = build();
    episode(prisma, 'i1', 'Ahsoka.S01E03.WEB.x264-TORRENTGALAXY[TGx]', 'Ahsoka - S01E03');
    seedSeries(prisma, 'ttAH', 'Ahsoka', 2023, 8);

    const summary = await svc.healLibraryImdbIds();

    expect(summary).toMatchObject({ resolved: 1, unresolved: 0 });
    expect(prisma.mediaItem.rows[0].seriesImdbId).toBe('ttAH'); // parsed out of the release name
  });

  it('honours the batch limit, leaving the rest for a later pass', async () => {
    const { svc, prisma } = build();
    episode(prisma, 'i1', 'Show A (2020)', 'Show A - S01E01');
    episode(prisma, 'i2', 'Show B (2020)', 'Show B - S01E01');
    seedSeries(prisma, 'ttA', 'Show A', 2020, 5);
    seedSeries(prisma, 'ttB', 'Show B', 2020, 5);

    const summary = await svc.healLibraryImdbIds({ limit: 1 });

    expect(summary).toMatchObject({ candidates: 2, attempted: 1, resolved: 1 });
  });

  it('audits each heal', async () => {
    const { svc, prisma, audit } = build();
    episode(prisma, 'i1', 'Batwoman (2019)', 'Batwoman - S01E01');
    seedSeries(prisma, 'ttBW', 'Batwoman', 2019, 51);

    await svc.healLibraryImdbIds({ userId: 'u1' });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        action: 'media_acquisition.library.imdb_resolved',
        metadata: expect.objectContaining({ imdbId: 'ttBW', title: 'Batwoman' }),
      }),
    );
  });

  it('does not run two sweeps concurrently, and says so rather than reporting a false zero', async () => {
    const { svc, prisma } = build();
    episode(prisma, 'i1', 'Batwoman (2019)', 'Batwoman - S01E01');
    seedSeries(prisma, 'ttBW', 'Batwoman', 2019, 51);

    const [first, second] = await Promise.all([svc.healLibraryImdbIds(), svc.healLibraryImdbIds()]);

    // Whichever lost the race bailed out immediately rather than double-resolving —
    // and is flagged `skipped`, so the caller can't read it as "nothing to heal".
    const [ran, bailed] = first.skipped ? [second, first] : [first, second];
    expect(ran).toMatchObject({ attempted: 1, resolved: 1, skipped: false });
    expect(bailed).toMatchObject({ candidates: 0, attempted: 0, skipped: true });
  });
});
