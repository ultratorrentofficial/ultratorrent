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
