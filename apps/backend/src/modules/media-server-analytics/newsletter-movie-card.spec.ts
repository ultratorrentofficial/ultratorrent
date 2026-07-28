/**
 * A movie card must carry the same metadata a show card does.
 *
 * Reported as "movie items not showing the metadata: description for example".
 * The data was never missing: 20 of the 21 films in the window had an overview
 * and a rating in `media_metadata`, fetched by the same query that feeds the TV
 * section. `movieCard` simply rendered poster, title, year and rating and threw
 * the rest away, so a film arrived blank while an episode of a series did not.
 */
import { buildContent, renderHtml } from './newsletter-render';
import { newsletterStrings } from './newsletter-strings';

const now = new Date('2026-07-28T12:00:00Z');

const movie = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  title: 'The Lantern Problem',
  mediaType: 'movie',
  year: 2023,
  addedAt: now,
  overview: 'A lighthouse keeper counts the ships that never arrive.',
  rating: 7.8,
  runtime: 108,
  certification: 'PG-13',
  genres: ['Mystery', 'Drama'],
  // Deliberately not 'Movies': the section HEADING is that word, so a badge
  // assertion using it would pass whether or not the badge rendered.
  library: 'HD Films',
  ...over,
});

function html(items: Array<Record<string, unknown>>, style: Record<string, unknown> = {}) {
  const content = buildContent(items as never, new Date('2026-07-21T00:00:00Z'), now);
  // `version` is required and reaches escapeHtml; omitting it throws before
  // any assertion runs.
  return renderHtml(content, { strings: newsletterStrings('en-US'), version: '0.0.0-test', style } as never);
}

describe('movie card metadata', () => {
  it('renders the overview', () => {
    expect(html([movie()])).toContain('A lighthouse keeper counts the ships');
  });

  it('renders genres and certification as badges', () => {
    const out = html([movie()]);
    expect(out).toContain('Mystery · Drama');
    expect(out).toContain('PG-13');
  });

  it('still renders title, year, runtime and rating', () => {
    // The fields that already worked must not regress.
    const out = html([movie()]);
    expect(out).toContain('The Lantern Problem');
    expect(out).toContain('2023');
    expect(out).toMatch(/7\.8/);
  });

  it('honours showOverview: false exactly as the show card does', () => {
    expect(html([movie()], { showOverview: false })).not.toContain('A lighthouse keeper');
  });

  it('honours showGenres: false', () => {
    expect(html([movie()], { showGenres: false })).not.toContain('Mystery · Drama');
  });

  it('shows the library badge only when asked', () => {
    expect(html([movie()])).not.toContain('HD Films');
    expect(html([movie()], { showLibraryBadges: true })).toContain('HD Films');
  });

  it('omits an absent overview rather than rendering an empty block', () => {
    const out = html([movie({ overview: null })]);
    expect(out).toContain('The Lantern Problem');
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('null');
  });

  it('escapes the overview', () => {
    // Overviews come from providers and sidecars — arbitrary text in an email.
    const out = html([movie({ overview: '<script>alert(1)</script>' })]);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });
});
