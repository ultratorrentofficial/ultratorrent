import { buildContent, buildSections, renderHtml, renderText, escapeHtml } from './newsletter-render';

const items = [
  { title: 'The Matrix', mediaType: 'movie', year: 1999, season: null, episode: null, addedAt: new Date() },
  { title: 'The Show', mediaType: 'tv', year: null, season: 1, episode: 2, addedAt: new Date() },
  { title: 'Music Thing', mediaType: 'music', year: null, season: null, episode: null, addedAt: new Date() },
];

describe('newsletter rendering', () => {
  it('groups items into movie / episode / other sections', () => {
    const s = buildSections(items);
    expect(s.map((x) => x.key)).toEqual(['movies', 'episodes', 'other']);
    expect(s[0].items[0].title).toBe('The Matrix');
  });

  it('renders an HTML email with the title, items and version footer', () => {
    const content = buildContent(items, new Date());
    const html = renderHtml(content, { title: 'Weekly', version: '0.15.0' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Weekly');
    expect(html).toContain('The Matrix (1999)');
    expect(html).toContain('The Show S01E02');
    expect(html).toContain('UltraTorrent v0.15.0');
  });

  it('renders a plain-text alternative', () => {
    const content = buildContent(items, new Date());
    const text = renderText(content, { title: 'Weekly', version: '0.15.0' });
    expect(text).toContain('New Movies');
    expect(text).toContain('- The Matrix (1999)');
  });

  it('shows an empty-period message when nothing was added', () => {
    const html = renderHtml(buildContent([], new Date()), { title: 'Weekly', version: '0.15.0' });
    expect(html).toMatch(/Nothing new/i);
  });

  it('escapes HTML in titles (no injection from library data)', () => {
    const html = renderHtml(buildContent([{ title: '<script>x</script>', mediaType: 'movie', year: null, season: null, episode: null, addedAt: new Date() }], new Date()), { title: 'W', version: '1' });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('includes an unsubscribe link when provided', () => {
    const html = renderHtml(buildContent(items, new Date()), { title: 'W', version: '1', unsubscribeUrl: 'https://x/unsub?t=abc' });
    expect(html).toContain('https://x/unsub?t=abc');
    expect(html).toContain('Unsubscribe');
  });
});
