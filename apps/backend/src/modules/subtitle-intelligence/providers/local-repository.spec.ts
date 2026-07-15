import {
  LocalRepositoryProvider,
  localMatchScore,
  normalizeToken,
  subtitleLangFromName,
} from './local-repository.provider';
import type { SubtitleSearchQuery } from './subtitle-provider';

describe('normalizeToken', () => {
  it('lower-cases and collapses to alphanumeric words', () => {
    expect(normalizeToken('The.Show_S01E02-1080p')).toBe('the show s01e02 1080p');
  });
});

describe('subtitleLangFromName', () => {
  it('reads language + forced/sdh flags', () => {
    expect(subtitleLangFromName('Movie.en.srt')).toEqual({ language: 'en', forced: false, sdh: false });
    expect(subtitleLangFromName('Movie.eng.forced.srt')).toEqual({ language: 'en', forced: true, sdh: false });
    expect(subtitleLangFromName('Movie.es.sdh.srt')).toEqual({ language: 'es', forced: false, sdh: true });
    expect(subtitleLangFromName('Movie.srt').language).toBe('und');
  });
});

describe('localMatchScore', () => {
  const movie: SubtitleSearchQuery = { languages: ['en'], title: 'The Matrix' };
  const episode: SubtitleSearchQuery = { languages: ['en'], title: 'The Show', season: 1, episode: 2 };

  it('matches a movie by a majority of title words', () => {
    expect(localMatchScore('The.Matrix.1999.en.srt', movie)).toBeGreaterThan(0);
    expect(localMatchScore('Completely.Different.srt', movie)).toBe(0);
  });

  it('requires the exact episode when one is queried', () => {
    expect(localMatchScore('The.Show.S01E02.en.srt', episode)).toBeGreaterThanOrEqual(2);
    expect(localMatchScore('The.Show.S01E03.en.srt', episode)).toBe(0); // wrong episode
  });
});

describe('LocalRepositoryProvider', () => {
  const guard = { assertWithinHardRoots: (p: string) => p };

  it('is unconfigured without a repo path', () => {
    expect(new LocalRepositoryProvider({}, guard).validateConfiguration()).toBe(false);
    expect(new LocalRepositoryProvider({ repoPath: '/downloads/subs' }, guard).validateConfiguration()).toBe(true);
  });

  it('advertises offline capabilities (no network search modes)', () => {
    const caps = new LocalRepositoryProvider({ repoPath: '/x' }, guard).getCapabilities();
    expect(caps.hashSearch).toBe(false);
    expect(caps.imdbSearch).toBe(false);
    expect(caps.releaseSearch).toBe(true);
  });

  it('returns nothing when the repo path escapes the hard roots', async () => {
    const denying = { assertWithinHardRoots: () => { throw new Error('outside roots'); } };
    const p = new LocalRepositoryProvider({ repoPath: '/etc' }, denying);
    expect(await p.search({ languages: ['en'], title: 'X' })).toEqual([]);
  });
});
