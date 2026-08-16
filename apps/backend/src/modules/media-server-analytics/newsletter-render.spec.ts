import {
  buildContent,
  groupShows,
  renderHtml,
  renderText,
  renderRating,
  renderBadges,
  formatEpisodeList,
  countLabel,
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
    // The product credit — "Powered by <brand> v<version>", linked to the repo
    // when a source URL is supplied (see newsletter-branding.spec.ts).
    expect(html).toContain('Powered by');
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

/**
 * The header mark.
 *
 * The lettered "UT" tile was a stand-in for the product logo. It ships as an
 * inline CID attachment rather than a `data:` URI because Gmail and Outlook
 * strip `data:` image sources in mail, and falls back to the tile whenever no
 * logo was attached — a text-only or attachment-less send still gets a header.
 */
describe('the brand mark in the header', () => {
  it('renders the logo as a cid image when one is attached', () => {
    const html = renderHtml(sampleContent(), { ...opts(), logoCid: 'nlbrandlogo' });
    expect(html).toContain('src="cid:nlbrandlogo"');
    // Sized in HTML attributes too — Outlook ignores style on images.
    // Dimensions as HTML attributes, or Outlook renders the 560px source raw.
    expect(html).toMatch(/<img src="cid:nlbrandlogo" width="280" height="74"/);
    // Shrinks on a narrow phone rather than forcing a horizontal scroll.
    expect(html).toContain('max-width:100%');
    expect(html).not.toContain('>UT<');
  });

  it('falls back to the lettered tile with no logo', () => {
    const html = renderHtml(sampleContent(), { ...opts(), logoCid: null });
    expect(html).toContain('>UT<');
    expect(html).not.toContain('cid:nlbrandlogo');
  });
});

/**
 * Episode labels must describe what actually arrived.
 *
 * The label was always `E{min}–E{max}`, so one new episode read "E05–E05" — a
 * range of one — and three scattered episodes read "E02–E09", implying eight
 * that were never added.
 */
describe('formatEpisodeList', () => {
  it('shows a single episode as itself, not a range of one', () => {
    expect(formatEpisodeList([5])).toBe('E05');
  });

  it('shows an unbroken run as a range', () => {
    expect(formatEpisodeList([2, 3, 4, 5, 6])).toBe('E02–E06');
  });

  it('lists the episodes when there are gaps, rather than implying the ones between', () => {
    expect(formatEpisodeList([2, 4, 9])).toBe('E02, E04 and E09');
    expect(formatEpisodeList([1, 3])).toBe('E01 and E03');
  });

  it('sorts and de-duplicates before deciding', () => {
    // Order of arrival is the order rows came back, not episode order.
    expect(formatEpisodeList([9, 2, 4, 2])).toBe('E02, E04 and E09');
    expect(formatEpisodeList([3, 2, 4])).toBe('E02–E04');
  });

  it('localizes the conjunction', () => {
    expect(formatEpisodeList([2, 4, 9], 'y')).toBe('E02, E04 y E09');
  });

  it('is empty when no episode number is known', () => {
    expect(formatEpisodeList([])).toBe('');
  });

  it('pads to two digits and handles three-digit episodes', () => {
    expect(formatEpisodeList([7])).toBe('E07');
    expect(formatEpisodeList([100, 102])).toBe('E100 and E102');
  });
});

/**
 * The poster cell must not be squeezed out.
 *
 * The thumbnail sits in a fixed cell beside an auto-width text cell. With
 * `max-width:100%` it contributed no minimum width, so a wide unbreakable
 * genres pill took the space and the poster collapsed to a few pixels — which
 * reads as a card with no artwork. Three of 23 shows lost their poster.
 */
describe('poster sizing', () => {
  it('gives the thumbnail a floor, not a ceiling', () => {
    const content = buildContent(episodes, since, until);
    // The sizing only applies to the image branch, so the card needs a poster.
    content.sections[0].shows[0].posterCid = 'nlposter-0';

    const html = renderHtml(content, opts());

    expect(html).toContain('min-width:84px');
    expect(html).not.toMatch(/width:84px;max-width:100%/);
  });

  it('lets a long badge wrap so it cannot squeeze the poster', () => {
    const long = renderBadges(['Animation · Action & Adventure · Sci-Fi & Fantasy']);
    expect(long).toContain('white-space:normal');
  });

  it('keeps a short badge on one line', () => {
    expect(renderBadges(['S04 · E02–E06'])).toContain('white-space:nowrap');
    expect(renderBadges(['45m'])).toContain('white-space:nowrap');
  });
});

/**
 * Counts must agree with their noun. A show with one new episode read
 * "1 Episodes" on its card and in the section summary.
 */
describe('countLabel', () => {
  const en = newsletterStrings('en-US');
  const es = newsletterStrings('es-PR');

  it('uses the singular for exactly one', () => {
    expect(countLabel(1, 'episodes', en)).toBe('Episode');
    expect(countLabel(1, 'shows', en)).toBe('Show');
    expect(countLabel(1, 'movies', en)).toBe('Movie');
    expect(countLabel(1, 'items', en)).toBe('Item');
  });

  it('uses the plural for none or many', () => {
    expect(countLabel(0, 'episodes', en)).toBe('Episodes');
    expect(countLabel(2, 'episodes', en)).toBe('Episodes');
  });

  it('does not just strip an "s" — Spanish singulars differ', () => {
    expect(countLabel(1, 'shows', es)).toBe('Serie');
    expect(countLabel(1, 'movies', es)).toBe('Película');
    expect(countLabel(2, 'shows', es)).toBe('Series');
  });

  it('leaves a label with no singular form alone', () => {
    expect(countLabel(1, 'brandTitle', en)).toBe(en.brandTitle);
  });

  it('reaches the rendered card and the plain-text part', () => {
    const one = [{ id: 'x', title: 'Solo', mediaType: 'tv', year: 2024, season: 1, episode: 5, addedAt: since }];
    const content = buildContent(one, since, until);
    expect(renderHtml(content, opts())).toContain('1 Episode<');
    expect(renderText(content, opts())).toContain('1 Episode ·');
  });
});
