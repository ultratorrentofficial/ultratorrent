import { YifyProvider, parseYifyRows, yifyDownload } from './yify.provider';

// Trimmed from the live yifysubtitles.ch movie page for tt0133093 (The Matrix).
const FIXTURE = `
<tbody>
  <tr data-id="119081">
    <td class="rating-cell"><span class="label label-success">2</span></td>
    <td class="flag-cell"><span class="flag flag-sa"></span><span class="sub-lang">Arabic</span></td>
    <td><a href="/subtitles/the-matrix-1999-arabic-yify-119081"><span class="text-muted">subtitle</span> The Matrix</a></td>
    <td class="other-cell"></td>
  </tr>
  <tr data-id="119099">
    <td class="rating-cell"><span class="label label-success">4</span></td>
    <td class="flag-cell"><span class="flag flag-us"></span><span class="sub-lang">English</span></td>
    <td><a href="/subtitles/the-matrix-1999-english-yify-119099"><span class="text-muted">subtitle</span> The Matrix</a></td>
    <td class="other-cell"></td>
  </tr>
</tbody>`;

describe('parseYifyRows', () => {
  it('parses language, slug, and rating from real row markup', () => {
    const rows = parseYifyRows(FIXTURE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ slug: 'the-matrix-1999-arabic-yify-119081', language: 'ar', rating: 2 });
    expect(rows[1]).toMatchObject({ slug: 'the-matrix-1999-english-yify-119099', language: 'en', rating: 4 });
  });

  it('returns nothing for a page with no rows', () => {
    expect(parseYifyRows('<html><body>no subtitles</body></html>')).toEqual([]);
  });
});

describe('yifyDownload', () => {
  it('builds the zip URL and the required Referer', () => {
    const { url, referer } = yifyDownload('the-matrix-1999-english-yify-119099');
    expect(url).toBe('https://yifysubtitles.ch/subtitle/the-matrix-1999-english-yify-119099.zip');
    expect(referer).toBe('https://yifysubtitles.ch/subtitle/the-matrix-1999-english-yify-119099');
  });
});

describe('YifyProvider', () => {
  const p = new YifyProvider();

  it('is a keyless, movie-only, IMDb-keyed provider', () => {
    expect(p.name).toBe('yify');
    expect(p.validateConfiguration()).toBe(true);
    expect(p.supportsImdbSearch()).toBe(true);
    expect(p.supportsSeriesSearch()).toBe(false);
    expect(p.supportsHashSearch()).toBe(false);
  });

  it('does not search for TV content or without an imdb id', async () => {
    expect(await p.search({ languages: ['en'], title: 'X' })).toEqual([]);
    expect(await p.search({ languages: ['en'], imdbId: 'tt1', mediaType: 'tv' })).toEqual([]);
  });
});
