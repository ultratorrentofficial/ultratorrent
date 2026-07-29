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

/**
 * The two-column layout itself.
 *
 * Requested as "a 2-column area per title … artwork, year, duration and rating
 * on the left and the movie description on the right", replacing a stacked
 * card. These assert the structure rather than the styling: which column each
 * fact lands in is the design, the pixel values are not.
 */
describe('movie card layout', () => {
  /** The markup of the left (poster) column, up to the gutter that ends it. */
  const leftCol = (out: string) => out.split('class="mposter"')[1]?.split('class="gut"')[0] ?? '';
  /** The markup of the right (description) column. */
  const rightCol = (out: string) => out.split('class="mbody"')[1] ?? '';

  it('puts the poster, year, duration and rating in the left column', () => {
    const out = html([movie()]);
    const left = leftCol(out);
    expect(left).toContain('2023');
    expect(left).toMatch(/1h 48m/);
    expect(left).toMatch(/7\.8/);
  });

  it('puts the title and description in the right column', () => {
    const right = rightCol(html([movie()]));
    expect(right).toContain('The Lantern Problem');
    expect(right).toContain('A lighthouse keeper counts the ships');
  });

  it('keeps the description out of the poster column', () => {
    // The whole point of the change: side by side, not stacked.
    expect(leftCol(html([movie()]))).not.toContain('A lighthouse keeper');
  });

  it('gives each film a full-width row rather than a half-width grid cell', () => {
    /*
     * A two-column card nested in the two-up grid would leave the description
     * ~180px — narrower than the stacked layout it replaced. Movies use
     * full-width rows; `class="col"` is the grid cell, and no movie may sit in
     * one.
     */
    expect(html([movie(), movie({ id: 'm2', title: 'Second Feature' })])).not.toContain('class="col"');
  });

  it('omits the facts line entirely when year and runtime are both absent', () => {
    // An empty line under the poster reads as a broken card.
    const out = html([movie({ year: null, runtime: null })]);
    expect(out).toContain('The Lantern Problem');
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('null');
  });

  it('collapses the two columns on a phone', () => {
    // At 320px the description would get ~170px beside a 120px poster.
    const out = html([movie()]);
    expect(out).toMatch(/@media only screen and \(max-width:600px\)/);
    expect(out).toMatch(/\.mposter\{[^}]*display:block!important/);
    expect(out).toMatch(/\.mbody\{[^}]*width:100%!important/);
  });

  it('centres the poster once stacked', () => {
    // A display:block image of fixed width ignores the cell's text-align.
    expect(html([movie()])).toMatch(/margin:0 auto/);
  });

  it('allows a longer overview than the stacked card did', () => {
    // The column is ~500px now; 140 characters was budgeted for ~300px.
    const long = 'x'.repeat(400);
    const out = html([movie({ overview: long })]);
    expect(out).toContain('x'.repeat(250));
  });
});
