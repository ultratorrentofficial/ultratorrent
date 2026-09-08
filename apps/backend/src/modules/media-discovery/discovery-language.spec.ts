import { canonicalLanguage, languageAllowed } from '@ultratorrent/shared';
import { evaluateDiscovery, type PolicyMedia, type PolicyTemplate } from './discovery-policy';

/**
 * Providers do not agree what a language is called.
 *
 * TMDB stores ISO codes (`en`), TVmaze stores English names (`English`), and
 * both land in the same catalogue — measured live: 195 rows `English`, 170 rows
 * `en`. Comparing raw meant a template saying "English" rejected every
 * TMDB-sourced title, and the inbox showed them as "Not evaluated", as though
 * nothing had ever looked at them.
 */

describe('canonicalLanguage', () => {
  it('maps an ISO code to the name a person would type', () => {
    expect(canonicalLanguage('en')).toBe('english');
    expect(canonicalLanguage('de')).toBe('german');
    expect(canonicalLanguage('ja')).toBe('japanese');
  });

  it('accepts the name form unchanged', () => {
    expect(canonicalLanguage('English')).toBe('english');
    expect(canonicalLanguage('  German ')).toBe('german');
  });

  /* An unknown language must still match itself, not vanish. */
  it('passes an unknown value through rather than dropping it', () => {
    expect(canonicalLanguage('Klingon')).toBe('klingon');
  });

  it.each([null, undefined, '', '   '])('treats %s as no language', (v) => {
    expect(canonicalLanguage(v as never)).toBe('');
  });
});

describe('languageAllowed', () => {
  it('matches the two vocabularies against each other, both directions', () => {
    expect(languageAllowed('en', ['English'])).toBe(true);
    expect(languageAllowed('English', ['en'])).toBe(true);
  });

  it('still rejects a language the template did not name', () => {
    expect(languageAllowed('de', ['English'])).toBe(false);
    expect(languageAllowed('German', ['English', 'Spanish'])).toBe(false);
  });

  it('allows everything when the template names no languages', () => {
    expect(languageAllowed('en', [])).toBe(true);
    expect(languageAllowed(null, [])).toBe(true);
  });

  /*
   * An unknown language cannot satisfy a list that names specific ones —
   * treating "we do not know" as a match would let anything through whose
   * provider omitted the field.
   */
  it('does not let a missing language satisfy a specific list', () => {
    expect(languageAllowed(null, ['English'])).toBe(false);
    expect(languageAllowed('', ['English'])).toBe(false);
  });
});

describe('the live regression: an English show stored as "en"', () => {
  const NOW = new Date('2026-09-08T12:00:00Z');
  const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString().slice(0, 10);

  /** The template as actually configured on the affected installation. */
  const TEMPLATE: PolicyTemplate = {
    mediaType: 'tv',
    upcomingWindowDays: 90,
    regions: ['US'],
    languages: ['English'],
    networks: [], streamingServices: [], studios: [],
    releaseTypes: ['series_premiere'],
    autoMonitorCategories: ['Drama'],
    notifyOnlyCategories: [], ignoreCategories: [], blockedFromAutoCategories: [],
    categoryMatchMode: 'ANY',
    minimumConfidence: 0.8,
  };

  /** "Neagley" as TMDB delivered it: a new US drama, language `en`. */
  const tmdbShow: PolicyMedia = {
    mediaType: 'tv',
    title: 'Neagley',
    genres: ['Drama'],
    originalLanguage: 'en',
    identityStatus: 'resolved',
    confidence: 1,
    premiereDate: day(8),
    releaseDates: [{ releaseType: 'series_premiere', date: day(8), region: null, source: 'tmdb' }],
  };

  it('is auto-monitored rather than rejected for its language', () => {
    const v = evaluateDiscovery(tmdbShow, TEMPLATE, { now: NOW });
    expect(v.decision).toBe('auto_monitor');
  });

  it('the same show from TVmaze, stored as "English", behaves identically', () => {
    const v = evaluateDiscovery({ ...tmdbShow, originalLanguage: 'English' }, TEMPLATE, { now: NOW });
    expect(v.decision).toBe('auto_monitor');
  });

  it('a German show is still excluded, and says so in the reason', () => {
    const v = evaluateDiscovery({ ...tmdbShow, originalLanguage: 'de' }, TEMPLATE, { now: NOW });
    expect(v.applies).toBe(false);
    // The old reason was the bare "Language not allowed", which said nothing
    // about what was wanted or what was found.
    expect(v.reason).toContain('de');
    expect(v.reason).toMatch(/this template accepts/);
  });
});
