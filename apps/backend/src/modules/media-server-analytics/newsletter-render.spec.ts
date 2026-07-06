import { buildContent, buildSections, renderHtml, renderText, escapeHtml, type NewsletterItem } from './newsletter-render';

const items: NewsletterItem[] = [
  { title: 'The Matrix', mediaType: 'movie', year: 1999, season: null, episode: null, addedAt: new Date(), rating: 8.7, runtime: 136, certification: 'R', genres: ['Action', 'Sci-Fi'], overview: 'A hacker learns the truth.' },
  { title: 'The Show', mediaType: 'tv', year: null, season: 1, episode: 2, addedAt: new Date() },
  { title: 'Music Thing', mediaType: 'music', year: null, season: null, episode: null, addedAt: new Date() },
];

describe('newsletter rendering', () => {
  it('groups items into movie / episode / other sections', () => {
    const s = buildSections(items);
    expect(s.map((x) => x.key)).toEqual(['movies', 'episodes', 'other']);
    expect(s[0].items[0].title).toBe('The Matrix');
  });

  it('renders a rich HTML email with title, subtitle, count, items and footer', () => {
    const content = buildContent(items, new Date());
    const html = renderHtml(content, { title: 'Weekly', version: '0.15.0', subtitle: 'Everything added since Jul 1, 2026' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Weekly');
    expect(html).toContain('Everything added since Jul 1, 2026');
    expect(html).toContain('3 new additions');
    expect(html).toContain('The Matrix (1999)');
    expect(html).toContain('S01E02'); // episode tag chip
    expect(html).toContain('Delivered by UltraTorrent');
    expect(html).toContain('v0.15.0');
  });

  it('renders metadata chips (rating / runtime / certification / genres)', () => {
    const html = renderHtml(buildContent([items[0]], new Date()), { title: 'W', version: '1' });
    expect(html).toContain('★ 8.7');
    expect(html).toContain('2h 16m');
    expect(html).toContain('R');
    expect(html).toContain('Action · Sci-Fi');
    expect(html).toContain('A hacker learns the truth.');
  });

  it('emits a cid image when a poster is attached, else a placeholder', () => {
    const withPoster: NewsletterItem = { ...items[0], id: 'x1', posterCid: 'poster-x1' };
    const withHtml = renderHtml(buildContent([withPoster], new Date()), { title: 'W', version: '1' });
    expect(withHtml).toContain('src="cid:poster-x1"');
    // No posterCid → gradient placeholder with the title initial, no cid img.
    const noHtml = renderHtml(buildContent([items[0]], new Date()), { title: 'W', version: '1' });
    expect(noHtml).not.toContain('cid:');
    expect(noHtml).toContain('linear-gradient');
  });

  it('renders a plain-text alternative with sections and overviews', () => {
    const content = buildContent(items, new Date());
    const text = renderText(content, { title: 'Weekly', version: '0.15.0' });
    expect(text).toContain('New Movies');
    expect(text).toContain('- The Matrix (1999)');
    expect(text).toContain('A hacker learns the truth.');
  });

  it('shows an empty-period message when nothing was added', () => {
    const html = renderHtml(buildContent([], new Date()), { title: 'Weekly', version: '0.15.0' });
    expect(html).toMatch(/No new media/i);
  });

  it('escapes HTML in titles and overviews (no injection from library data)', () => {
    const html = renderHtml(
      buildContent([{ title: '<script>x</script>', mediaType: 'movie', year: null, season: null, episode: null, addedAt: new Date(), overview: '<img onerror=1>' }], new Date()),
      { title: 'W', version: '1' },
    );
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img onerror=1>');
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('includes an unsubscribe link when provided', () => {
    const html = renderHtml(buildContent(items, new Date()), { title: 'W', version: '1', unsubscribeUrl: 'https://x/unsub?t=abc' });
    expect(html).toContain('https://x/unsub?t=abc');
    expect(html).toContain('Unsubscribe');
  });
});
