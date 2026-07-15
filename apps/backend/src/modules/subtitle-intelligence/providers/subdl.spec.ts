import { SubDLProvider, resolveSubdlUrl } from './subdl.provider';
import type { SubtitleSearchQuery } from './subtitle-provider';

const query: SubtitleSearchQuery = { languages: ['en'], imdbId: 'tt0111161', title: 'The Show', season: 1, episode: 2 };

describe('resolveSubdlUrl', () => {
  it('resolves a host-relative path against the SubDL CDN', () => {
    expect(resolveSubdlUrl('/subtitle/123-456.zip')).toBe('https://dl.subdl.com/subtitle/123-456.zip');
  });
  it('accepts an absolute SubDL url', () => {
    expect(resolveSubdlUrl('https://dl.subdl.com/subtitle/x.zip')).toBe('https://dl.subdl.com/subtitle/x.zip');
  });
  it('rejects a non-SubDL host (SSRF guard)', () => {
    expect(resolveSubdlUrl('https://evil.example.com/x.zip')).toBeNull();
    expect(resolveSubdlUrl('http://dl.subdl.com.evil.com/x.zip')).toBeNull(); // lookalike host
  });
});

describe('SubDLProvider', () => {
  const p = new SubDLProvider({ apiKey: 'k' });

  it('reports capabilities (no hash, imdb/tmdb yes)', () => {
    expect(p.name).toBe('subdl');
    expect(p.supportsHashSearch()).toBe(false);
    expect(p.supportsImdbSearch()).toBe(true);
    expect(p.getCapabilities().hearingImpaired).toBe(true);
  });

  it('needs an API key to be configured', () => {
    expect(new SubDLProvider({}).validateConfiguration()).toBe(false);
    expect(p.validateConfiguration()).toBe(true);
  });

  it('normalizes a SubDL subtitle, echoing the queried ids', () => {
    const n = p.normalizeResult(
      { release_name: 'The.Show.S01E02.1080p', name: 'The.Show.S01E02.en.srt', language: 'EN', url: '/subtitle/1.zip', hi: true, author: 'bob' },
      query,
    );
    expect(n?.provider).toBe('subdl');
    expect(n?.language).toBe('en');
    expect(n?.hearingImpaired).toBe(true);
    expect(n?.imdbId).toBe('tt0111161');
    expect(n?.providerFileId).toBe('/subtitle/1.zip');
    expect(n?.uploader).toBe('bob');
  });

  it('skips a result without a download url', () => {
    expect(p.normalizeResult({ language: 'EN' }, query)).toBeNull();
  });
});
