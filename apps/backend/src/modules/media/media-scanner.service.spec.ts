import { isIgnoredScanDir, deriveFileTechInfo } from './media-scanner.service';
import { parseItemIdentity } from './media-identification.service';

describe('isIgnoredScanDir', () => {
  it('skips hidden/dot directories (trash + sidecar metadata)', () => {
    expect(isIgnoredScanDir('.deletedByTMM')).toBe(true);
    expect(isIgnoredScanDir('.actors')).toBe(true);
    expect(isIgnoredScanDir('.Trashes')).toBe(true);
  });

  it('skips Synology @eaDir thumbnail folders', () => {
    expect(isIgnoredScanDir('@eaDir')).toBe(true);
  });

  it('keeps normal library folders', () => {
    expect(isIgnoredScanDir('Breaking Bad')).toBe(false);
    expect(isIgnoredScanDir('Season 01')).toBe(false);
    expect(isIgnoredScanDir('HD Movies')).toBe(false);
  });
});

describe('deriveFileTechInfo', () => {
  it('derives container + quality from a release filename', () => {
    const info = deriveFileTechInfo('/x/Show.S01E01.1080p.WEB-DL.x264-GRP.mkv');
    expect(info.container).toBe('mkv');
    expect(info.resolution).toBe('1080p');
    expect(info.videoCodec).toBe('x264');
    expect(info.releaseGroup).toBe('GRP');
  });
});

// The identity the scanner now stores on a new item, instead of the raw filename.
describe('parseItemIdentity (what the scanner stores)', () => {
  const LIB = '/downloads/TV';

  it('stores the series + season/episode, not the filename (Blindspot regression)', () => {
    const id = parseItemIdentity(
      `${LIB}/TV_Shows/Blindspot (2015)/Season 1/Blindspot - S01E14 - Rules in Defiance.mp4`,
      LIB,
    );
    expect(id.title).toBe('Blindspot'); // was: "Blindspot - S01E14 - Rules in Defiance"
    expect(id.season).toBe(1);
    expect(id.episode).toBe(14);
  });

  it('takes the series from the show folder when the filename is only the episode name', () => {
    const id = parseItemIdentity(
      `${LIB}/9-1-1 (2018)/Season 9/Contraband Seized at the Border - S09E04.mkv`,
      LIB,
    );
    expect(id.title).toBe('9-1-1'); // folder wins; filename names the *episode*
    expect(id.season).toBe(9);
    expect(id.episode).toBe(4);
  });

  it('keeps the filename title for a loose scene release (folder is a junk/download dir)', () => {
    const id = parseItemIdentity(`${LIB}/completed/Show.Name.S02E05.1080p.WEB.x265-GRP.mkv`, LIB);
    expect(id.title).toBe('Show Name');
    expect(id.season).toBe(2);
    expect(id.episode).toBe(5);
  });

  it('leaves a movie without season/episode', () => {
    const id = parseItemIdentity(`${LIB}/../Movies/Dune Part Two (2024)/Dune Part Two (2024) [1080p].mkv`, LIB);
    expect(id.season).toBeNull();
    expect(id.episode).toBeNull();
  });
});

// ---------------------------------------------------------------------------

import { MediaScannerService } from './media-scanner.service';
import { showCanonicalKey } from './series-grouping';

/**
 * `media_shows` records the folder the scanner actually SAW, so the missing-episode
 * sweep can file a grab into a real path instead of rebuilding one from the show's
 * title — the bug that minted `TV Shows/Ghosts 2021 (2021)` and `TV Shows/Happys
 * Place` beside the genuine folders.
 */
describe('MediaScannerService.reconcileShows', () => {
  const LIB = { id: 'lib1', kind: 'tv', path: '/downloads/TV Shows', name: 'TV Shows' };

  function build(items: Array<{ path: string; seriesImdbId?: string | null; imdb?: string | null }>) {
    const upserts: any[] = [];
    const deletes: any[] = [];
    const prisma = {
      mediaItem: {
        findMany: jest.fn(async () =>
          items.map((i) => ({
            path: i.path,
            seriesImdbId: i.seriesImdbId ?? null,
            externalIds: i.imdb ? [{ externalId: i.imdb }] : [],
          })),
        ),
      },
      mediaShow: {
        upsert: jest.fn(async (args: any) => { upserts.push(args); return {}; }),
        deleteMany: jest.fn(async (args: any) => { deletes.push(args); return { count: 0 }; }),
      },
    };
    const svc = new MediaScannerService(prisma as any, {} as any, {} as any, {} as any, {} as any);
    return { svc, prisma, upserts, deletes };
  }
  const run = (svc: any, lib = LIB) => svc.reconcileShows(lib);

  it('records one row per show folder, climbing past Season NN', async () => {
    const { svc, upserts } = build([
      { path: `${LIB.path}/Ghosts US (2021)/Season 5/Ghosts.2021.S05E12.mkv` },
      { path: `${LIB.path}/Ghosts US (2021)/Season 5/Ghosts.2021.S05E13.mkv` },
      { path: `${LIB.path}/The Wire (2002)/Season 1/The Wire - S01E01.mkv` },
    ]);
    const count = await run(svc);

    expect(count).toBe(2);
    const paths = upserts.map((u) => u.create.path).sort();
    expect(paths).toEqual([`${LIB.path}/Ghosts US (2021)`, `${LIB.path}/The Wire (2002)`]);

    const ghosts = upserts.find((u) => u.create.path.includes('Ghosts'));
    expect(ghosts.create).toMatchObject({ title: 'Ghosts US', year: 2021, episodeCount: 2, mediaType: 'tv' });
    // The canonical key is what lets "Ghosts (US)" and "Ghosts US (2021)" agree.
    expect(ghosts.create.canonicalKey).toBe('ghosts us');
  });

  it('takes the IMDb id from whichever episode has one', async () => {
    const { svc, upserts } = build([
      { path: `${LIB.path}/Ghosts US (2021)/Season 5/a.mkv`, seriesImdbId: null },
      { path: `${LIB.path}/Ghosts US (2021)/Season 5/b.mkv`, seriesImdbId: 'tt11379026' },
    ]);
    await run(svc);
    // An unidentified episode must not shadow an identified one.
    expect(upserts[0].create.imdbId).toBe('tt11379026');
  });

  it('records NO row for a file sitting loose at the library root', async () => {
    // There is no show folder to record, and inventing one is the whole problem.
    const { svc, upserts } = build([{ path: `${LIB.path}/Loose.Show.S01E01.mkv` }]);
    expect(await run(svc)).toBe(0);
    expect(upserts).toHaveLength(0);
  });

  it('does NOT mistake a release subfolder for a show of its own', async () => {
    // The common real layout: a torrent's own folder sits INSIDE the show folder.
    // Climbing only past `Season NN` stops at the release dir and calls that the
    // show — which produced 15 bogus "duplicate show" families on a real library,
    // each pairing a show with a subdirectory of itself.
    const { svc, upserts } = build([
      { path: `${LIB.path}/Billions (2016)/Season 7/Billions.S07E01.mkv` },
      { path: `${LIB.path}/Billions (2016)/Billions.S07E02.WEB.x264-TGx/Billions.S07E02.mkv` },
      { path: `${LIB.path}/Billions (2016)/Billions.S07.COMPLETE/Season 7/Billions.S07E03.mkv` },
      { path: `${LIB.path}/Billions (2016)/Season 7/Extras/behind-the-scenes.mkv` },
    ]);

    expect(await run(svc)).toBe(1); // ONE show, not four
    expect(upserts).toHaveLength(1);
    expect(upserts[0].create.path).toBe(`${LIB.path}/Billions (2016)`);
    // Every file below the show folder counts toward it, however deeply nested.
    expect(upserts[0].create.episodeCount).toBe(4);
  });

  it('prunes shows whose folder no longer holds an item', async () => {
    const { svc, deletes } = build([{ path: `${LIB.path}/The Wire (2002)/Season 1/a.mkv` }]);
    await run(svc);
    expect(deletes[0].where).toMatchObject({
      libraryId: 'lib1',
      path: { notIn: [`${LIB.path}/The Wire (2002)`] },
    });
  });

  it('never prunes when the scan saw nothing (an unmounted root must not wipe the shows)', async () => {
    const { svc, prisma } = build([]);
    expect(await run(svc)).toBe(0);
    expect(prisma.mediaShow.deleteMany).not.toHaveBeenCalled();
  });

  it('skips a non-show library entirely', async () => {
    const { svc, prisma } = build([{ path: '/downloads/Movies/Ghost (1990)/Ghost.mkv' }]);
    expect(await run(svc, { ...LIB, kind: 'movie' })).toBe(0);
    expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
  });
});

describe('showCanonicalKey', () => {
  it('folds the variants that produced duplicate folders', () => {
    expect(showCanonicalKey('Ghosts US (2021)')).toBe('ghosts us');
    expect(showCanonicalKey('Ghosts (US)')).toBe('ghosts us');
    expect(showCanonicalKey("Happy's Place (2024)")).toBe('happys place');
    expect(showCanonicalKey('Happys Place')).toBe('happys place');
    expect(showCanonicalKey('Magnum P.I. (2018)')).toBe('magnum p i');
    expect(showCanonicalKey('Magnum P.I (2018)')).toBe('magnum p i');
  });

  it('keeps genuinely different shows apart', () => {
    expect(showCanonicalKey('Ghosts UK')).not.toBe(showCanonicalKey('Ghosts US'));
    expect(showCanonicalKey('Rise')).not.toBe(showCanonicalKey('Sunrise'));
  });

  it('keeps a leading year, which can be the whole title', () => {
    expect(showCanonicalKey('1883')).toBe('1883');
    expect(showCanonicalKey('1923 (2022)')).toBe('1923');
  });
});

import { showFolderOf } from './media-scanner.service';

/**
 * A show folder is defined by its POSITION — the direct child of the library root —
 * not by its name. Anything deeper (season containers, release/torrent dirs, Extras,
 * complete-season packs) is INSIDE a show, whatever it is called.
 */
describe('showFolderOf', () => {
  const LIB = '/downloads/TV Shows';

  it('resolves a file to the show folder however deeply it is nested', () => {
    expect(showFolderOf(LIB, `${LIB}/Billions (2016)/Season 7/ep.mkv`)).toBe(`${LIB}/Billions (2016)`);
    expect(showFolderOf(LIB, `${LIB}/Billions (2016)/Billions.S07E02.WEB-TGx/ep.mkv`)).toBe(`${LIB}/Billions (2016)`);
    expect(showFolderOf(LIB, `${LIB}/Billions (2016)/S07.COMPLETE/Season 7/ep.mkv`)).toBe(`${LIB}/Billions (2016)`);
    expect(showFolderOf(LIB, `${LIB}/Show/Season 3/Extras/x.mkv`)).toBe(`${LIB}/Show`);
  });

  it('returns null for a file loose at the library root — there is no show folder', () => {
    expect(showFolderOf(LIB, `${LIB}/Loose.Show.S01E01.mkv`)).toBeNull();
  });

  it('returns null for a path outside the library', () => {
    expect(showFolderOf(LIB, '/downloads/Movies/Ghost (1990)/Ghost.mkv')).toBeNull();
  });
});
