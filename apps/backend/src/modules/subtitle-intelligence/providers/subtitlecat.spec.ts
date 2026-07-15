import {
  SubtitleCatProvider,
  parseSubtitleCatResults,
  parseSubtitleCatSrtLinks,
  resolveSubtitleCatUrl,
  subtitleCatLang,
} from './subtitlecat.provider';

// From the live subtitlecat.com search + detail pages.
const SEARCH = `
<a href="subs/1059/Matrix.Generation.2023.1080p.WEB.html">Matrix Generation</a>
<a href="https://gomakego.com?utm_source=subtitlecat">ad</a>
<a href="subs/673/Matrix Reloaded The.en-en.html">Matrix Reloaded</a>`;
const DETAIL = `
<a id="download_en" href="/subs/1507/Matrix Reloaded The.en-en-en.srt">English</a>
<a id="download_es" href="/subs/1542/Matrix Reloaded The.en-en-es-419.srt">Spanish</a>`;

describe('parseSubtitleCatResults', () => {
  it('extracts detail-page paths and ignores ad links', () => {
    expect(parseSubtitleCatResults(SEARCH)).toEqual([
      'subs/1059/Matrix.Generation.2023.1080p.WEB.html',
      'subs/673/Matrix Reloaded The.en-en.html',
    ]);
  });
});

describe('subtitleCatLang', () => {
  it('reads a native-language srt as not machine-translated', () => {
    expect(subtitleCatLang('/subs/1507/Matrix Reloaded The.en-en-en.srt')).toEqual({
      language: 'en',
      machineTranslated: false,
    });
  });
  it('reads an auto-translated srt (en → es-419) as machine-translated Spanish', () => {
    expect(subtitleCatLang('/subs/1542/Matrix Reloaded The.en-en-es-419.srt')).toEqual({
      language: 'es',
      machineTranslated: true,
    });
  });
});

describe('parseSubtitleCatSrtLinks', () => {
  it('extracts each srt link with its language + translation flag', () => {
    const links = parseSubtitleCatSrtLinks(DETAIL);
    expect(links).toEqual([
      { href: '/subs/1507/Matrix Reloaded The.en-en-en.srt', language: 'en', machineTranslated: false },
      { href: '/subs/1542/Matrix Reloaded The.en-en-es-419.srt', language: 'es', machineTranslated: true },
    ]);
  });
});

describe('resolveSubtitleCatUrl (SSRF guard)', () => {
  it('resolves relative paths against the SubtitleCat host', () => {
    expect(resolveSubtitleCatUrl('/subs/1/x.srt')).toBe('https://www.subtitlecat.com/subs/1/x.srt');
    expect(resolveSubtitleCatUrl('subs/1/x.html')).toBe('https://www.subtitlecat.com/subs/1/x.html');
  });
  it('rejects a foreign host', () => {
    expect(resolveSubtitleCatUrl('https://evil.com/x.srt')).toBeNull();
  });
});

describe('SubtitleCatProvider', () => {
  const p = new SubtitleCatProvider();
  it('is a keyless, title-based provider that advertises machine translation', () => {
    expect(p.name).toBe('subtitlecat');
    expect(p.validateConfiguration()).toBe(true);
    expect(p.supportsMachineTranslation()).toBe(true);
    expect(p.supportsImdbSearch()).toBe(false);
  });
  it('returns nothing without a title', async () => {
    expect(await p.search({ languages: ['en'] })).toEqual([]);
  });
});
