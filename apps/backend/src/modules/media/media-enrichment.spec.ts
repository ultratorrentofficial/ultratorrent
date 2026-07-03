import { BadRequestException } from '@nestjs/common';
import { parseSubtitleFilename } from './media-subtitle.service';
import {
  validateArtworkUpload,
  sniffImageMime,
  MAX_ARTWORK_BYTES,
} from './media-artwork.service';
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
});
