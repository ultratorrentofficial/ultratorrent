import { PodnapisiProvider, resolvePodnapisiUrl } from './podnapisi.provider';

describe('PodnapisiProvider.normalizeEntry', () => {
  const p = new PodnapisiProvider();

  it('normalizes a documented Podnapisi entry', () => {
    const n = p.normalizeEntry({
      id: 'abc123',
      language: 'EN',
      title: 'The Matrix',
      year: 1999,
      num_of_downloads: 4200,
      rating: 5,
      flags: { hearing_impaired: true, foreign_only: false },
      releases: ['The.Matrix.1999.1080p.BluRay'],
      download: '/subtitles/abc123/download',
    });
    expect(n).not.toBeNull();
    expect(n!.provider).toBe('podnapisi');
    expect(n!.language).toBe('en');
    expect(n!.releaseName).toBe('The.Matrix.1999.1080p.BluRay');
    expect(n!.hearingImpaired).toBe(true);
    expect(n!.downloads).toBe(4200);
    expect(n!.downloadUrl).toBe('/subtitles/abc123/download');
  });

  it('synthesizes a download path from the id when none is given', () => {
    const n = p.normalizeEntry({ id: 'xyz', language: 'es' });
    expect(n!.downloadUrl).toBe('/subtitles/xyz/download');
  });

  it('drops an entry with neither id nor download', () => {
    expect(p.normalizeEntry({ language: 'en' })).toBeNull();
  });
});

describe('resolvePodnapisiUrl (SSRF guard)', () => {
  it('resolves a relative download path', () => {
    expect(resolvePodnapisiUrl('/subtitles/abc/download')).toBe('https://www.podnapisi.net/subtitles/abc/download');
  });
  it('rejects a foreign host', () => {
    expect(resolvePodnapisiUrl('https://evil.com/x')).toBeNull();
  });
});

describe('PodnapisiProvider capabilities', () => {
  const p = new PodnapisiProvider();
  it('is keyless, release + series capable, no hash/imdb', () => {
    expect(p.validateConfiguration()).toBe(true);
    expect(p.supportsReleaseSearch()).toBe(true);
    expect(p.supportsSeriesSearch()).toBe(true);
    expect(p.supportsHashSearch()).toBe(false);
    expect(p.supportsImdbSearch()).toBe(false);
  });
});
