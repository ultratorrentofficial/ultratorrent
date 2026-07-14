import { BadRequestException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSubtitleFilename } from './media-subtitle.service';
import {
  MediaArtworkService,
  validateArtworkUpload,
  sniffImageMime,
  MAX_ARTWORK_BYTES,
} from './media-artwork.service';
import {
  mapTmdbImages,
  pickBestArtwork,
  isAllowedArtworkHost,
} from './artwork-provider';
import { buildNfoXml, nfoFilenameFor } from './media-nfo.service';
import {
  detectDuplicateGroups,
  duplicateKeys,
  normalizeTitle,
  qualityScore,
  DuplicateItemLike,
} from './media-duplicate.service';
import { deriveFileTechInfo } from './media-scanner.service';
import { parseNfoXml } from './media-metadata.service';

// --- subtitle filename parsing ------------------------------------------
describe('parseSubtitleFilename', () => {
  it('parses a simple ISO-639-1 language', () => {
    expect(parseSubtitleFilename('Movie.en.srt')).toEqual({
      language: 'en',
      forced: false,
      sdh: false,
    });
  });
  it('maps a 3-letter code and detects forced', () => {
    expect(parseSubtitleFilename('Movie.eng.forced.srt')).toEqual({
      language: 'en',
      forced: true,
      sdh: false,
    });
  });
  it('detects sdh/hi flags', () => {
    expect(parseSubtitleFilename('Show.S01E01.spa.sdh.ass').sdh).toBe(true);
    expect(parseSubtitleFilename('Show.fr.hi.vtt')).toEqual({
      language: 'fr',
      forced: false,
      sdh: true,
    });
  });
  it('returns und for an unknown language', () => {
    expect(parseSubtitleFilename('Movie.srt').language).toBe('und');
  });
});

// --- artwork validation --------------------------------------------------
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'),
]);

describe('sniffImageMime', () => {
  it('recognises png/jpeg/webp magic bytes', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPG)).toBe('image/jpeg');
    expect(sniffImageMime(WEBP)).toBe('image/webp');
  });
  it('returns null for non-images', () => {
    expect(sniffImageMime(Buffer.from('not an image'))).toBeNull();
  });
});

describe('validateArtworkUpload', () => {
  it('accepts a valid png data URL', () => {
    const v = validateArtworkUpload({
      type: 'poster',
      dataBase64: `data:image/png;base64,${PNG.toString('base64')}`,
    });
    expect(v.mime).toBe('image/png');
    expect(v.ext).toBe('png');
  });
  it('rejects an unsupported artwork type', () => {
    expect(() =>
      validateArtworkUpload({ type: 'bogus', dataBase64: PNG.toString('base64') }),
    ).toThrow(BadRequestException);
  });
  it('rejects non-image bytes', () => {
    expect(() =>
      validateArtworkUpload({
        type: 'poster',
        dataBase64: Buffer.from('hello').toString('base64'),
      }),
    ).toThrow(BadRequestException);
  });
  it('rejects a declared mime that disagrees with content', () => {
    expect(() =>
      validateArtworkUpload({
        type: 'poster',
        mime: 'image/jpeg',
        dataBase64: PNG.toString('base64'),
      }),
    ).toThrow(BadRequestException);
  });
  it('rejects oversized images', () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_ARTWORK_BYTES + 1)]);
    expect(() =>
      validateArtworkUpload({ type: 'poster', dataBase64: big.toString('base64') }),
    ).toThrow(BadRequestException);
  });
});

// --- TMDB artwork provider ----------------------------------------------
const IMG = 'https://image.tmdb.org/t/p/original';

describe('mapTmdbImages', () => {
  it('maps posters/backdrops/logos to our artwork types with absolute urls', () => {
    const cands = mapTmdbImages(
      {
        posters: [{ file_path: '/p.jpg', width: 1000, vote_average: 5 }],
        backdrops: [{ file_path: '/b.jpg', width: 1920, iso_639_1: null }],
        logos: [{ file_path: '/l.png' }],
      },
      IMG,
    );
    expect(cands).toEqual([
      { type: 'poster', url: `${IMG}/p.jpg`, width: 1000, height: undefined, lang: null, score: 5 },
      { type: 'fanart', url: `${IMG}/b.jpg`, width: 1920, height: undefined, lang: null, score: 0 },
      { type: 'logo', url: `${IMG}/l.png`, width: undefined, height: undefined, lang: null, score: 0 },
    ]);
  });
  it('drops entries without a file_path and tolerates null input', () => {
    expect(mapTmdbImages(null, IMG)).toEqual([]);
    expect(mapTmdbImages({ posters: [{ width: 10 }] }, IMG)).toEqual([]);
  });
});

describe('pickBestArtwork', () => {
  const cands = mapTmdbImages(
    {
      posters: [
        { file_path: '/lo.jpg', width: 500, vote_average: 2 },
        { file_path: '/hi.jpg', width: 2000, vote_average: 8 },
      ],
    },
    IMG,
  );
  it('picks the highest-scored candidate of a type', () => {
    expect(pickBestArtwork(cands, 'poster')?.url).toBe(`${IMG}/hi.jpg`);
  });
  it('returns undefined when no candidate of that type exists', () => {
    expect(pickBestArtwork(cands, 'fanart')).toBeUndefined();
  });
});

describe('isAllowedArtworkHost', () => {
  it('allows the TMDB image cdn only', () => {
    expect(isAllowedArtworkHost(`${IMG}/x.jpg`)).toBe(true);
    expect(isAllowedArtworkHost('https://evil.example.com/x.jpg')).toBe(false);
    expect(isAllowedArtworkHost('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isAllowedArtworkHost('not a url')).toBe(false);
  });
});

// --- NFO generation ------------------------------------------------------
describe('buildNfoXml', () => {
  it('builds a movie NFO with escaped content and unique ids', () => {
    const xml = buildNfoXml('movie', {
      title: 'Fight & Club',
      year: 1999,
      overview: 'A <secret> plot',
      genres: ['Drama'],
      cast: [{ name: 'Ed', role: 'Narrator' }],
      externalIds: { tmdb: '550', imdb: 'tt0137523' },
    });
    expect(xml).toContain('<movie>');
    expect(xml).toContain('<title>Fight &amp; Club</title>');
    expect(xml).toContain('<plot>A &lt;secret&gt; plot</plot>');
    expect(xml).toContain('<year>1999</year>');
    expect(xml).toContain('<genre>Drama</genre>');
    expect(xml).toContain('<uniqueid type="tmdb" default="true">550</uniqueid>');
    expect(xml).toContain('<name>Ed</name>');
  });
  it('uses episodedetails root and season/episode for episodes', () => {
    const xml = buildNfoXml('episode', { title: 'Pilot', season: 1, episode: 2 });
    expect(xml).toContain('<episodedetails>');
    expect(xml).toContain('<season>1</season>');
    expect(xml).toContain('<episode>2</episode>');
  });
});

describe('nfoFilenameFor', () => {
  it('places movie/episode NFO next to the video', () => {
    expect(nfoFilenameFor('movie', '/media/Movie (1999).mkv')).toBe(
      '/media/Movie (1999).nfo',
    );
  });
  it('names tvshow/season NFOs in the directory', () => {
    expect(nfoFilenameFor('tvshow', '/media/Show/S01/ep.mkv')).toBe(
      '/media/Show/S01/tvshow.nfo',
    );
  });
});

// --- duplicate detection -------------------------------------------------
function item(over: Partial<DuplicateItemLike>): DuplicateItemLike {
  return {
    id: over.id ?? 'x',
    mediaType: over.mediaType ?? 'movie',
    title: over.title ?? 'Title',
    year: over.year ?? null,
    season: over.season ?? null,
    episode: over.episode ?? null,
    externalIds: over.externalIds,
    files: over.files,
  };
}

describe('normalizeTitle', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeTitle("The Matrix: Reloaded!")).toBe('the matrix reloaded');
  });
});

describe('duplicateKeys', () => {
  it('emits a title_year key for a movie', () => {
    const keys = duplicateKeys(item({ title: 'The Matrix', year: 1999 }));
    expect(keys.some((k) => k.reason === 'title_year' && k.key.includes('1999'))).toBe(
      true,
    );
  });
  it('emits a show_season_episode key for an episode', () => {
    const keys = duplicateKeys(item({ title: 'Show', season: 1, episode: 2 }));
    expect(keys.some((k) => k.reason === 'show_season_episode')).toBe(true);
  });
});

describe('detectDuplicateGroups', () => {
  it('groups two copies of the same movie by title+year', () => {
    const groups = detectDuplicateGroups([
      item({ id: 'a', title: 'The Matrix', year: 1999 }),
      item({ id: 'b', title: 'the.matrix', year: 1999 }),
      item({ id: 'c', title: 'Other', year: 2000 }),
    ]);
    const g = groups.find((x) => x.itemIds.includes('a'));
    expect(g).toBeDefined();
    expect(g!.itemIds.sort()).toEqual(['a', 'b']);
    expect(g!.reason).toBe('title_year');
  });
  it('prefers external_id over weaker signals and assigns each item once', () => {
    const groups = detectDuplicateGroups([
      item({ id: 'a', title: 'The Matrix', year: 1999, externalIds: [{ provider: 'tmdb', externalId: '603' }] }),
      item({ id: 'b', title: 'The Matrix', year: 1999, externalIds: [{ provider: 'tmdb', externalId: '603' }] }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe('external_id');
    expect(groups[0].itemIds.sort()).toEqual(['a', 'b']);
  });
  it('does not group unique items', () => {
    const groups = detectDuplicateGroups([
      item({ id: 'a', title: 'Alpha', year: 2001 }),
      item({ id: 'b', title: 'Beta', year: 2002 }),
    ]);
    expect(groups).toHaveLength(0);
  });
});

describe('qualityScore', () => {
  it('ranks 2160p x265 above 720p x264', () => {
    const hi = qualityScore(item({ files: [{ resolution: '2160p', videoCodec: 'x265', size: 1 }] }));
    const lo = qualityScore(item({ files: [{ resolution: '720p', videoCodec: 'x264', size: 1 }] }));
    expect(hi).toBeGreaterThan(lo);
  });
});

// --- scanner tech-info derivation ---------------------------------------
describe('deriveFileTechInfo', () => {
  it('extracts codec/resolution/hdr/group/quality from a release name', () => {
    const t = deriveFileTechInfo(
      '/media/The.Show.S01E01.1080p.WEB-DL.x265.HDR.DDP5.1-GROUP.mkv',
    );
    expect(t.container).toBe('mkv');
    expect(t.resolution).toBe('1080p');
    expect(t.videoCodec).toBe('x265');
    expect(t.hdr).toContain('HDR');
    expect(t.releaseGroup).toBe('GROUP');
    expect(t.quality).toContain('1080p');
  });
});

// --- local NFO parsing ---------------------------------------------------
describe('parseNfoXml', () => {
  it('extracts title, plot, year and genres', () => {
    const parsed = parseNfoXml(
      '<movie><title>Heat</title><plot>Cops & robbers</plot><year>1995</year><genre>Crime</genre><genre>Drama</genre></movie>',
    );
    expect(parsed.title).toBe('Heat');
    expect(parsed.overview).toBe('Cops & robbers');
    expect(parsed.year).toBe(1995);
    expect(parsed.genres).toEqual(['Crime', 'Drama']);
  });

  it('extracts external ids from <imdbid>/<tmdbid> and <uniqueid>', () => {
    const a = parseNfoXml('<movie><imdbid>tt0113277</imdbid><tmdbid>949</tmdbid></movie>');
    expect(a.externalIds).toEqual({ imdb: 'tt0113277', tmdb: '949' });
    const b = parseNfoXml(
      '<movie><uniqueid type="imdb">tt0113277</uniqueid><uniqueid type="tmdb">949</uniqueid></movie>',
    );
    expect(b.externalIds).toEqual({ imdb: 'tt0113277', tmdb: '949' });
  });

  it('extracts original title, directors, writers and cast', () => {
    const parsed = parseNfoXml(
      '<movie><originaltitle>Heat</originaltitle><director>Michael Mann</director>' +
        '<credits>Michael Mann</credits>' +
        '<actor><name>Al Pacino</name><role>Vincent Hanna</role></actor>' +
        '<actor><name>Robert De Niro</name></actor></movie>',
    );
    expect(parsed.originalTitle).toBe('Heat');
    expect(parsed.directors).toEqual(['Michael Mann']);
    expect(parsed.writers).toEqual(['Michael Mann']);
    expect(parsed.cast).toEqual([
      { name: 'Al Pacino', role: 'Vincent Hanna' },
      { name: 'Robert De Niro' },
    ]);
  });
});

describe('MediaArtworkService.importLocal — sidecar artwork detection', () => {
  async function fixture(knownRelPaths: string[] = []) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ut-sidecar-'));
    const dir = path.join(root, 'Heat (1995)');
    await fs.mkdir(dir, { recursive: true });
    const video = path.join(dir, 'Heat (1995).mkv');
    for (const name of [
      'Heat (1995).mkv',
      'poster.jpg', // → poster
      'fanart.jpg', // → fanart
      'Heat (1995)-banner.png', // → banner (basename-suffixed)
      'notes.jpg', // unrecognised name → ignored
      'info.txt', // non-image → ignored
    ]) {
      await fs.writeFile(path.join(dir, name), 'x');
    }
    // Pre-existing artwork rows, keyed by localPath (type/selected drive dedup).
    const existingArtwork = knownRelPaths.map((rel) => ({
      type: 'poster',
      localPath: path.join(dir, rel),
      selected: true,
    }));
    const created: any[] = [];
    const prisma = {
      mediaItem: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'item1',
          files: [{ path: video }],
          artwork: existingArtwork,
        }),
      },
      mediaArtwork: {
        create: jest.fn(async ({ data }: any) => {
          created.push(data);
          return data;
        }),
      },
    } as any;
    const filePath = { assertWithinHardRoots: (p: string) => p, hardRoots: [root] } as any;
    const svc = new MediaArtworkService(prisma, filePath, {} as any, {} as any);
    return { svc, created, dir, root };
  }

  it('imports poster/fanart/basename-suffixed art in place, one selected per type', async () => {
    const { svc, created, dir, root } = await fixture();
    const count = await svc.importLocal('item1');
    expect(count).toBe(3);
    const byType = Object.fromEntries(created.map((c) => [c.type, c]));
    expect(Object.keys(byType).sort()).toEqual(['banner', 'fanart', 'poster']);
    expect(created.every((c) => c.source === 'local' && c.selected === true)).toBe(true);
    expect(byType.poster.localPath).toBe(path.join(dir, 'poster.jpg'));
    await fs.rm(root, { recursive: true, force: true });
  });

  it('skips artwork whose localPath is already recorded (idempotent)', async () => {
    const { svc, created, root } = await fixture(['poster.jpg']);
    const count = await svc.importLocal('item1');
    expect(count).toBe(2); // poster already known → only fanart + banner
    expect(created.map((c) => c.type).sort()).toEqual(['banner', 'fanart']);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('imports show/season-level art from parent dirs for a TV episode', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ut-tv-'));
    const libRoot = path.join(root, 'TV Shows');
    const showDir = path.join(libRoot, '3 Body Problem (2024)');
    const seasonDir = path.join(showDir, 'Season 1');
    await fs.mkdir(seasonDir, { recursive: true });
    const video = path.join(seasonDir, '3 Body Problem - S01E01 - Countdown.mkv');
    await fs.writeFile(video, 'x');
    // Per-episode thumbnail lives next to the episode…
    await fs.writeFile(
      path.join(seasonDir, '3 Body Problem - S01E01 - Countdown-thumb.jpg'),
      'x',
    );
    // …while show/season-level art sits in the show root, one level up.
    for (const n of ['poster.jpg', 'fanart.jpg', 'banner.jpg', 'season01-poster.jpg']) {
      await fs.writeFile(path.join(showDir, n), 'x');
    }

    const created: any[] = [];
    const prisma = {
      mediaItem: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ep1',
          files: [{ path: video }],
          artwork: [],
          library: { path: libRoot },
        }),
      },
      mediaArtwork: {
        create: jest.fn(async ({ data }: any) => {
          created.push(data);
          return data;
        }),
      },
    } as any;
    const filePath = { assertWithinHardRoots: (p: string) => p, hardRoots: [root] } as any;
    const svc = new MediaArtworkService(prisma, filePath, {} as any, {} as any);

    const count = await svc.importLocal('ep1');
    const byType = Object.fromEntries(created.map((c) => [c.type, c]));
    expect(Object.keys(byType).sort()).toEqual([
      'banner',
      'fanart',
      'poster',
      'season_poster',
      'thumbnail',
    ]);
    // Show poster comes from the show root; the thumbnail from the episode sidecar.
    expect(byType.poster.localPath).toBe(path.join(showDir, 'poster.jpg'));
    expect(byType.thumbnail.localPath).toBe(
      path.join(seasonDir, '3 Body Problem - S01E01 - Countdown-thumb.jpg'),
    );
    expect(byType.season_poster.seasonNumber).toBe(1);
    expect(count).toBe(5);
    await fs.rm(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------

import { MediaMetadataService } from './media-metadata.service';

/**
 * A `.nfo` is written by whatever media manager last touched the library, and it can
 * be confidently, systematically wrong. On a real library, eighteen unrelated Apple
 * TV+ shows each carried `<uniqueid type="imdb">tt13701758</uniqueid>` in their S01E01
 * sidecar — a tconst that is *Acapulco* S01E01.
 *
 * An episode belongs to exactly ONE series, so an id filed under two different show
 * folders is provably wrong. That collision is the signal; the catalogue's series
 * TITLE is not — see the false-positive tests below.
 */
describe('MediaMetadataService — an IMDb episode id claimed by two shows', () => {
  const LIB = { id: 'lib1', path: '/downloads/TV/TV_Shows' };
  const item = (folder: string, mediaType = 'tv') => ({
    id: 'mine',
    libraryId: LIB.id,
    mediaType,
    path: `${LIB.path}/${folder}/Season 1/ep.mkv`,
  });

  function build(otherFolders: string[] = []) {
    const deleted: any[] = [];
    const prisma = {
      mediaLibrary: { findUnique: jest.fn(async () => LIB) },
      mediaExternalId: {
        findMany: jest.fn(async () =>
          otherFolders.map((f, i) => ({
            id: `other${i}`,
            item: { path: `${LIB.path}/${f}/Season 1/ep.mkv` },
          })),
        ),
        deleteMany: jest.fn(async (args: any) => { deleted.push(args); return { count: otherFolders.length }; }),
      },
    };
    const svc = new MediaMetadataService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { svc, prisma, deleted };
  }
  const check = (svc: any, it: any, id = 'tt13701758') => svc.isForeignEpisodeId(it, 'imdb', id);

  it('rejects an id already filed under a DIFFERENT show, and strips it from that one too', async () => {
    const { svc, deleted } = build(['Servant (2019)', 'Hawkeye (2021)']);

    expect(await check(svc, item('Ted Lasso (2020)'))).toBe(true);
    // Neither show may keep it — we cannot tell which is right, and both cannot be.
    expect(deleted[0].where.id.in).toEqual(['other0', 'other1']);
  });

  it('accepts an id that only this show claims', async () => {
    const { svc, prisma } = build([]);
    expect(await check(svc, item('Ted Lasso (2020)'))).toBe(false);
    expect(prisma.mediaExternalId.deleteMany).not.toHaveBeenCalled();
  });

  it('accepts a second copy of the same episode inside the SAME show folder', async () => {
    // A duplicate episode file is a duplicate FILE, not a wrong id.
    const { svc } = build(['Ted Lasso (2020)']);
    expect(await check(svc, item('Ted Lasso (2020)'))).toBe(false);
  });

  it('does NOT flag a show the library files under a longer name (Star Wars Andor)', async () => {
    // IMDb calls it "Andor"; the library calls it "Star Wars Andor". A title-comparison
    // guard flagged 18 perfectly good ids here — the collision check does not, because
    // no other folder claims them.
    const { svc } = build([]);
    expect(await check(svc, item('Star Wars Andor (2022)'), 'tt11660988')).toBe(false);
  });

  it('does NOT flag a show IMDb renamed mid-run (Interview with the Vampire)', async () => {
    // AMC renamed it "The Vampire Lestat" for S3; the folder kept the old name.
    const { svc } = build([]);
    expect(await check(svc, item('Interview with the Vampire (2022)'), 'tt13314588')).toBe(false);
  });

  it('leaves movies and UNGUARDED providers alone', async () => {
    // This used to assert that `tmdb` was skipped — and that gap is exactly why the
    // same library carried 0 colliding imdb ids but 871 colliding tvdb ones. tmdb and
    // tvdb are now guarded too; only a provider we do not check (and movies, where the
    // one-episode-one-series rule does not apply) is passed through.
    const { svc, prisma } = build(['Other Show (2020)']);
    expect(await check(svc, item('Ghost (1990)', 'movie'))).toBe(false);
    expect(await (svc as any).isForeignEpisodeId(item('Ted Lasso (2020)'), 'anilist', '123')).toBe(false);
    expect(prisma.mediaExternalId.findMany).not.toHaveBeenCalled();
  });
});

/**
 * The collision guard originally covered `imdb` only — and the other two providers
 * show exactly what that cost. On a real library `imdb` had **0** ids shared across
 * shows, while `tvdb` had **871** across 3,278 items: Dickinson's entire second season
 * was stamped with one Game of Thrones episode id, and the correct id from its own
 * (perfectly good) sidecar appeared nowhere in the database.
 *
 * It sticks because `importLocalNfo` upserts with `update: {}` — a bad id imported once
 * is permanent, and re-importing the corrected sidecar cannot displace it.
 */
describe('MediaMetadataService — the collision guard covers every provider, not just IMDb', () => {
  const LIB = { id: 'lib1', path: '/downloads/TV/TV_Shows' };
  const item = (folder: string, mediaType = 'tv') => ({
    id: 'mine',
    libraryId: LIB.id,
    mediaType,
    path: `${LIB.path}/${folder}/Season 1/ep.mkv`,
  });

  function build(otherFolders: string[] = []) {
    const deleted: any[] = [];
    const prisma = {
      mediaLibrary: { findUnique: jest.fn(async () => LIB) },
      mediaExternalId: {
        findMany: jest.fn(async () =>
          otherFolders.map((f, i) => ({
            id: `other${i}`,
            item: { path: `${LIB.path}/${f}/Season 1/ep.mkv` },
          })),
        ),
        deleteMany: jest.fn(async (args: any) => { deleted.push(args); return { count: otherFolders.length }; }),
      },
    };
    const svc = new MediaMetadataService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { svc, prisma, deleted };
  }

  it('rejects a TVDB id claimed by another show (the Dickinson / Game of Thrones case)', async () => {
    const { svc, prisma, deleted } = build(['Game of Thrones (2010)']);
    // 247867 is a Game of Thrones episode. It cannot also be Dickinson S02E02.
    expect(await (svc as any).isForeignEpisodeId(item('Dickinson (2019)'), 'tvdb', '247867')).toBe(true);
    expect(deleted[0].where.id.in).toEqual(['other0']);
    // It must query the SAME provider, not hard-code imdb.
    expect(prisma.mediaExternalId.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ provider: 'tvdb' }) }),
    );
  });

  it('rejects a TMDB id claimed by another show (High Desert / Masters of the Air)', async () => {
    const { svc, deleted } = build(['Masters of the Air (2024)']);
    expect(await (svc as any).isForeignEpisodeId(item('High Desert (2023)'), 'tmdb', '239574')).toBe(true);
    expect(deleted[0].where.id.in).toEqual(['other0']);
  });

  it('accepts a TVDB id only this show claims', async () => {
    const { svc, prisma } = build([]);
    // Dickinson S02E02's real id, straight from its own sidecar.
    expect(await (svc as any).isForeignEpisodeId(item('Dickinson (2019)'), 'tvdb', '7984092')).toBe(false);
    expect(prisma.mediaExternalId.deleteMany).not.toHaveBeenCalled();
  });

  it('leaves an unguarded provider alone', async () => {
    const { svc, prisma } = build(['Some Other Show (2020)']);
    expect(await (svc as any).isForeignEpisodeId(item('Dickinson (2019)'), 'anilist', '123')).toBe(false);
    expect(prisma.mediaExternalId.deleteMany).not.toHaveBeenCalled();
  });

  it('does not touch movies — the collision rule is about episodes', async () => {
    const { svc, prisma } = build(['Other Movie (2020)']);
    expect(await (svc as any).isForeignEpisodeId(item('A Movie (2020)', 'movie'), 'tvdb', '247867')).toBe(false);
    expect(prisma.mediaExternalId.deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * tinyMediaManager writes a `<tvdbid>` inside EVERY `<actor>` block. Reading ids from
 * the whole document therefore returns the first CAST MEMBER's id instead of the
 * episode's — and preferring that bare tag over the explicit `<uniqueid>` made it
 * stick.
 *
 * On a real library this put one id (247867) on the whole of Dickinson season 2, AND on
 * Game of Thrones, AND on Marvel's Luke Cage — because the same actor is in all three.
 * It is what produced 871 tvdb ids "shared" across unrelated shows: shared cast, not
 * shared episodes.
 */
describe('parseNfoXml — external ids are not read out of the cast list', () => {
  // Trimmed from the real sidecar: Dickinson S02E02, tinyMediaManager 4.3.2.
  const NFO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<episodedetails>
  <title>Fame is a fickle food</title>
  <season>2</season>
  <episode>2</episode>
  <id>7984092</id>
  <uniqueid default="false" type="tvdb">7984092</uniqueid>
  <uniqueid default="true" type="imdb">tt11729982</uniqueid>
  <credits tvdbid="7881302">Rachel Axler</credits>
  <director tvdbid="294992">Christopher Storer</director>
  <actor>
    <name>Hailee Steinfeld</name>
    <role>Emily Dickinson</role>
    <tvdbid>247867</tvdbid>
  </actor>
  <actor>
    <name>Adrian Blake Enscoe</name>
    <tvdbid>8031157</tvdbid>
  </actor>
</episodedetails>`;

  it('takes the EPISODE id, not the first actor’s', () => {
    const parsed = parseNfoXml(NFO);
    expect(parsed.externalIds).toEqual({ tvdb: '7984092', imdb: 'tt11729982' });
    // 247867 is Hailee Steinfeld, not an episode of Dickinson.
    expect(parsed.externalIds?.tvdb).not.toBe('247867');
  });

  it('still reads the cast (the actor blocks are only excluded from the ID scan)', () => {
    const parsed = parseNfoXml(NFO);
    expect(parsed.cast).toEqual([
      { name: 'Hailee Steinfeld', role: 'Emily Dickinson' },
      { name: 'Adrian Blake Enscoe' },
    ]);
  });

  it('still honours a legacy sidecar that carries only the bare tags', () => {
    const legacy = `<episodedetails>
      <title>Old</title>
      <tvdbid>555123</tvdbid>
      <imdbid>tt0000001</imdbid>
    </episodedetails>`;
    expect(parseNfoXml(legacy).externalIds).toEqual({ tvdb: '555123', imdb: 'tt0000001' });
  });

  it('prefers the explicit uniqueid over a bare tag when both are present', () => {
    const both = `<episodedetails>
      <tvdbid>999999</tvdbid>
      <uniqueid type="tvdb">7984092</uniqueid>
    </episodedetails>`;
    expect(parseNfoXml(both).externalIds?.tvdb).toBe('7984092');
  });
});
