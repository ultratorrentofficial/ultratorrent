import {
  buildContent,
  groupShows,
  renderHtml,
  renderText,
  renderRating,
  renderBadges,
  escapeHtml,
  sampleContent,
  type NewsletterItem,
  type RenderOptions,
} from './newsletter-render';
import { NEWSLETTER_STRINGS, newsletterStrings } from './newsletter-strings';

const since = new Date('2026-06-26');
const until = new Date('2026-07-03');

function opts(over: Partial<RenderOptions> = {}): RenderOptions {
  return {
    strings: newsletterStrings('en-US'),
    version: '0.16.0',
    serverName: 'EHPLEX',
    dateRange: '2026-06-26 - 2026-07-03',
    brand: 'UltraTorrent',
    unsubscribeUrl: 'https://x/unsub?t=abc',
    preferencesUrl: 'https://x/prefs',
    instanceUrl: 'https://ut.example',
    ...over,
  };
}

const episodes: NewsletterItem[] = [
  { id: 'e1', title: 'Silverpeak', mediaType: 'tv', year: 2024, season: 1, episode: 1, addedAt: since, rating: 8.4, runtime: 52, genres: ['Drama'], overview: 'A frontier town keeps a secret.' },
  { id: 'e2', title: 'Silverpeak', mediaType: 'tv', year: 2024, season: 1, episode: 2, addedAt: since, rating: 8.0 },
  { id: 'e3', title: 'Silverpeak', mediaType: 'tv', year: 2024, season: 2, episode: 1, addedAt: since },
];
const movie: NewsletterItem = { id: 'm1', title: 'The Long Night', mediaType: 'movie', year: 2024, season: null, episode: null, addedAt: since, rating: 7.2, runtime: 124, genres: ['Drama'] };

describe('newsletter content grouping', () => {
  it('groups episodes into one show with counts + season range', () => {
    const shows = groupShows(episodes);
    expect(shows).toHaveLength(1);
    expect(shows[0]).toMatchObject({ title: 'Silverpeak', episodeCount: 3, seasonCount: 2, seasonRange: 'S01–S02', episodeRange: 'E01–E02' });
    // Rating is the mean of episodes that carry one.
    expect(shows[0].rating).toBeCloseTo(8.2, 1);
  });

  it('splits content into one section per type (Tautulli-style)', () => {
    const c = buildContent([...episodes, movie], since, until);
    expect(c.sections.map((s) => s.key)).toEqual(['tv', 'movie']);
    const tv = c.sections.find((s) => s.key === 'tv')!;
    expect(tv.layout).toBe('shows');
    expect(tv.shows).toHaveLength(1);
    expect(tv.count).toEqual([
      { n: 1, labelKey: 'shows' },
      { n: 3, labelKey: 'episodes' },
    ]);
    const movies = c.sections.find((s) => s.key === 'movie')!;
    expect(movies.layout).toBe('grid');
    expect(movies.movies.map((m) => m.title)).toEqual(['The Long Night']);
    expect(movies.count).toEqual([{ n: 1, labelKey: 'movies' }]);
    expect(c.totalItems).toBe(4);
  });

  it('creates a music section (grid, "items" count) for concert/music types', () => {
    const concert: NewsletterItem = { id: 'c1', title: 'Live at Roadburn', mediaType: 'concert', year: 2025, season: null, episode: null, addedAt: since };
    const c = buildContent([concert], since, until);
    expect(c.sections.map((s) => s.key)).toEqual(['music']);
    expect(c.sections[0]).toMatchObject({ layout: 'grid', titleKey: 'musicTitle', count: [{ n: 1, labelKey: 'items' }] });
  });

  it('omits sections for types with no new items', () => {
    const c = buildContent([movie], since, until);
    expect(c.sections.map((s) => s.key)).toEqual(['movie']);
  });
});

describe('renderRating (5-star normalization)', () => {
  it('normalizes a 0–10 rating to filled/empty stars', () => {
    const html = renderRating(8.4, '#f5a623'); // 8.4/2 = 4.2 -> 4 stars
    expect((html.match(/#f5a623/g) ?? []).length).toBe(4);
    expect(html).toContain('8.4');
  });
  it('renders nothing when unrated', () => {
    expect(renderRating(null, '#f5a623')).toBe('');
    expect(renderRating(0, '#f5a623')).toBe('');
  });
});

describe('renderHtml (dark digest template)', () => {
  it('renders the branded header, server, date range and amber divider', () => {
    const html = renderHtml(buildContent([...episodes, movie], since, until), opts());
    expect(html).toContain('ULTRATORRENT NEWSLETTER');
    expect(html).toContain('EHPLEX');
    expect(html).toContain('2026-06-26 - 2026-07-03');
    expect(html).toContain('#f5a623'); // amber accent
  });

  it('renders section headers with count summaries', () => {
    const html = renderHtml(buildContent([...episodes, movie], since, until), opts());
    expect(html).toContain('Recently Added TV Shows');
    expect(html).toContain('Recently Added Movies');
    expect(html).toContain('Shows');
    expect(html).toContain('Episodes');
  });

  it('renders TV cards and a movie grid', () => {
    const html = renderHtml(buildContent([...episodes, movie], since, until), opts());
    expect(html).toContain('Silverpeak');
    expect(html).toContain('The Long Night');
    expect(html).toContain('class="col"'); // two-column grid cells
  });

  it('renders a three-area footer with unsubscribe + preferences + brand', () => {
    const html = renderHtml(buildContent(episodes, since, until), opts());
    expect(html).toContain('https://x/unsub?t=abc');
    expect(html).toContain('Unsubscribe');
    expect(html).toContain('Preferences');
    expect(html).toContain('https://ut.example');
    expect(html).toContain('Delivered by');
  });

  it('falls back to a placeholder (no cid) when a poster is missing', () => {
    const html = renderHtml(buildContent(episodes, since, until), opts());
    expect(html).not.toContain('cid:');
  });

  it('shows the empty message when nothing was added', () => {
    const html = renderHtml(buildContent([], since, until), opts());
    expect(html).toMatch(/No new media/i);
  });

  it('escapes HTML in titles and overviews', () => {
    const evil: NewsletterItem = { id: 'x', title: '<script>x</script>', mediaType: 'movie', year: null, season: null, episode: null, addedAt: since, overview: '<img onerror=1>' };
    const html = renderHtml(buildContent([evil], since, until), opts());
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img onerror=1>');
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('renders localized strings from the ES set', () => {
    const html = renderHtml(buildContent(episodes, since, until), opts({ strings: newsletterStrings('es-PR') }));
    expect(html).toContain('BOLETÍN DE ULTRATORRENT');
    expect(html).toContain('Series Agregadas Recientemente');
  });
});

describe('renderBadges', () => {
  it('renders each non-empty badge and drops falsy ones', () => {
    const html = renderBadges(['2024', '', '1h 2m']);
    expect(html).toContain('2024');
    expect(html).toContain('1h 2m');
  });
});

describe('renderText (plain-text fallback)', () => {
  it('lists shows and movies with counts', () => {
    const text = renderText(buildContent([...episodes, movie], since, until), opts());
    expect(text).toContain('Recently Added TV Shows');
    expect(text).toContain('- Silverpeak (2024) — 3 Episodes');
    expect(text).toContain('Recently Added Movies');
    expect(text).toContain('- The Long Night (2024)');
  });
});

describe('sampleContent', () => {
  it('produces representative TV + movie sections for the empty preview', () => {
    const c = sampleContent();
    const tv = c.sections.find((s) => s.key === 'tv');
    const movies = c.sections.find((s) => s.key === 'movie');
    expect(tv?.shows.length).toBeGreaterThan(0);
    expect(movies?.movies.length).toBeGreaterThan(0);
    expect(renderHtml(c, opts())).toContain('Silverpeak');
  });
});

describe('newsletter i18n parity (en-US / es-PR)', () => {
  it('has identical keys across both locales', () => {
    const en = Object.keys(NEWSLETTER_STRINGS['en-US']).sort();
    const es = Object.keys(NEWSLETTER_STRINGS['es-PR']).sort();
    expect(es).toEqual(en);
    for (const [, v] of Object.entries(NEWSLETTER_STRINGS['es-PR'])) {
      expect(v).toBeTruthy();
    }
  });
});
