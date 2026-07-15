import { buildSearchLevels, levelAllowsAutoAccept } from './search-strategy';
import type { SubtitleSearchQuery } from '../providers/subtitle-provider';

const full: SubtitleSearchQuery = {
  languages: ['en'],
  movieHash: 'abcd000000000001',
  fileSize: 1000,
  releaseName: 'Show.S01E02.1080p.WEB-DL.NTB',
  releaseGroup: 'NTB',
  title: 'Show',
  year: 2020,
  season: 1,
  episode: 2,
  imdbId: 'tt0111161',
  tmdbId: '550',
};

describe('buildSearchLevels', () => {
  it('emits all four levels in most-confident-first order', () => {
    const levels = buildSearchLevels(full);
    expect(levels.map((l) => l.level)).toEqual([1, 2, 3, 4]);
    expect(levels[0].query.movieHash).toBe('abcd000000000001');
    expect(levels[2].query.imdbId).toBe('tt0111161');
  });

  it('skips the hash level when no hash is present', () => {
    const levels = buildSearchLevels({ ...full, movieHash: undefined, fileSize: undefined });
    expect(levels.map((l) => l.level)).toEqual([2, 3, 4]);
  });

  it('skips the external-id level when no ids are present', () => {
    const levels = buildSearchLevels({ ...full, imdbId: undefined, tmdbId: undefined, tvdbId: undefined });
    expect(levels.map((l) => l.level)).toEqual([1, 2, 4]);
  });

  it('falls back to a title-only level', () => {
    const levels = buildSearchLevels({ languages: ['en'], title: 'Solo' });
    expect(levels.map((l) => l.level)).toEqual([4]);
    expect(levels[0].query.title).toBe('Solo');
  });

  it('carries languages onto every level', () => {
    for (const l of buildSearchLevels(full)) expect(l.query.languages).toEqual(['en']);
  });
});

describe('levelAllowsAutoAccept', () => {
  it('permits levels 1–3 and forbids title-only level 4', () => {
    expect(levelAllowsAutoAccept(1)).toBe(true);
    expect(levelAllowsAutoAccept(3)).toBe(true);
    expect(levelAllowsAutoAccept(4)).toBe(false);
  });
});
