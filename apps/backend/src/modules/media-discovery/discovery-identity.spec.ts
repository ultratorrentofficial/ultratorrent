import { identityKey, identityKeys, mergeDiscoveries, type SourcedDiscovery } from './discovery-identity';
import type { RawDiscovery } from './discovery-provider';

const raw = (over: Partial<RawDiscovery> = {}): RawDiscovery => ({
  mediaType: 'movie',
  title: 'A Film',
  externalIds: {},
  ...over,
});
const from = (provider: string, over: Partial<RawDiscovery> = {}): SourcedDiscovery => ({
  provider,
  raw: raw(over),
});

describe('identity keys', () => {
  /*
   * TMDB numbers movies and shows in separate spaces, so `tmdb:123` alone is
   * ambiguous between a film and a series. Everything else is globally unique
   * and is deliberately NOT qualified, so a key survives a media-type correction.
   */
  it('qualifies a TMDB id by media type and leaves the others alone', () => {
    expect(identityKey('tmdb', '123', 'movie')).toBe('tmdb:movie:123');
    expect(identityKey('tmdb', '123', 'tv')).toBe('tmdb:tv:123');
    expect(identityKey('imdb', 'tt99', 'movie')).toBe('imdb:tt99');
    expect(identityKey('tvmaze', '42', 'tv')).toBe('tvmaze:42');
  });

  it('orders keys strongest first', () => {
    expect(identityKeys({ tvmaze: '42', imdb: 'tt99', tmdb: '7' }, 'tv')).toEqual([
      'imdb:tt99',
      'tmdb:tv:7',
      'tvmaze:42',
    ]);
  });
});

describe('merging on a shared id', () => {
  it('joins two providers that name the same IMDb id, whatever they call it', () => {
    const out = mergeDiscoveries([
      from('tmdb', { title: 'The Sheep Detectives', externalIds: { imdb: 'tt32565993', tmdb: '1301421' } }),
      from('tvmaze', { title: 'Three Bags Full', externalIds: { imdb: 'tt32565993', tvmaze: '900' } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].sourceProviders).toEqual(['tmdb', 'tvmaze']);
    expect(out[0].externalIds).toEqual({ imdb: 'tt32565993', tmdb: '1301421', tvmaze: '900' });
    expect(out[0].identityStatus).toBe('resolved');
  });

  it('answers to every key it has ever been known by', () => {
    const [m] = mergeDiscoveries([
      from('tvmaze', { mediaType: 'tv', title: 'S', externalIds: { tvmaze: '1234' } }),
      from('tmdb', { mediaType: 'tv', title: 'S', externalIds: { tvmaze: '1234', imdb: 'tt5' } }),
    ]);
    // The canonical key moved to imdb once one appeared; persisting on it alone
    // would have created a second row for one show.
    expect(m.dedupeKey).toBe('imdb:tt5');
    expect(m.alternateKeys).toContain('tvmaze:1234');
  });

  it('keeps every provider’s dates, tagged, rather than collapsing them', () => {
    const [m] = mergeDiscoveries([
      from('tmdb', { externalIds: { imdb: 'tt1' }, releaseDates: [{ releaseType: 'digital', date: '2026-10-01', confidence: 0.9 }] }),
      from('tvmaze', { externalIds: { imdb: 'tt1' }, releaseDates: [{ releaseType: 'streaming', date: '2026-10-05', confidence: 0.7 }] }),
    ]);
    expect(m.releaseDates).toEqual([
      { releaseType: 'digital', date: '2026-10-01', confidence: 0.9, source: 'tmdb' },
      { releaseType: 'streaming', date: '2026-10-05', confidence: 0.7, source: 'tvmaze' },
    ]);
  });

  it('unions genres and providers without duplicating them', () => {
    const [m] = mergeDiscoveries([
      from('tmdb', { externalIds: { imdb: 'tt1' }, genres: ['Drama', 'Crime'] }),
      from('tvmaze', { externalIds: { imdb: 'tt1' }, genres: ['Crime', 'Mystery'] }),
    ]);
    expect(m.genres.sort()).toEqual(['Crime', 'Drama', 'Mystery']);
  });
});

describe('refusing to merge', () => {
  /*
   * The case this whole module exists for. TMDB carries three distinct 2026 films
   * called "The Odyssey". Keying on title+year would fuse them into one record,
   * and every downstream decision would then concern a film nobody chose.
   */
  it('does NOT fuse three same-title films one provider already distinguishes', () => {
    const out = mergeDiscoveries([
      from('tmdb', { title: 'The Odyssey', year: 2026, externalIds: { tmdb: '1368337' } }),
      from('tmdb', { title: 'The Odyssey', year: 2026, externalIds: { tmdb: '1698863' } }),
      from('tmdb', { title: 'The Odyssey', year: 2026, externalIds: { tmdb: '1756234' } }),
    ]);
    expect(out).toHaveLength(3);
    expect(out.every((m) => m.identityStatus === 'ambiguous')).toBe(true);
    expect(out[0].identityNote).toMatch(/more than one distinct work/i);
  });

  it('caps an ambiguous identity’s confidence below any sane auto-monitor floor', () => {
    const out = mergeDiscoveries([
      from('tmdb', { title: 'The Odyssey', year: 2026, externalIds: { tmdb: '1' } }),
      from('tmdb', { title: 'The Odyssey', year: 2026, externalIds: { tmdb: '2' } }),
    ]);
    // The template default floor is 0.8; no configuration can raise this past it.
    expect(out.every((m) => m.confidence <= 0.2)).toBe(true);
  });

  it('keeps two films apart when their ids contradict, however identical the title', () => {
    const out = mergeDiscoveries([
      from('tmdb', { title: 'Leviticus', year: 2026, externalIds: { tmdb: '1564614' } }),
      from('trakt', { title: 'Leviticus', year: 2026, externalIds: { tmdb: '1658905' } }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('marks a group conflicted when a shared id drags in a contradicting one', () => {
    const out = mergeDiscoveries([
      from('a', { externalIds: { imdb: 'tt1', tmdb: '100' } }),
      from('b', { externalIds: { imdb: 'tt1', tmdb: '999' } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].identityStatus).toBe('conflicted');
    expect(out[0].confidence).toBeLessThanOrEqual(0.2);
  });

  it('keeps a film and a series with the same TMDB number apart', () => {
    const out = mergeDiscoveries([
      from('tmdb', { mediaType: 'movie', title: 'Dual', externalIds: { tmdb: '55' } }),
      from('tmdb', { mediaType: 'tv', title: 'Dual', externalIds: { tmdb: '55' } }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('joining on title and year', () => {
  it('joins two DIFFERENT providers with no contradicting id', () => {
    const out = mergeDiscoveries([
      from('tmdb', { mediaType: 'tv', title: 'Silo', year: 2023, externalIds: { tmdb: '125988' } }),
      from('tvmaze', { mediaType: 'tv', title: 'Silo', year: 2023, externalIds: { tvmaze: '58444' } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].sourceProviders).toEqual(['tmdb', 'tvmaze']);
    // Corroboration by a second provider raises confidence.
    expect(out[0].confidence).toBeGreaterThan(0.4);
  });

  it('does not join across different years', () => {
    const out = mergeDiscoveries([
      from('tmdb', { title: 'Dune', year: 1984, externalIds: { tmdb: '1' } }),
      from('tvmaze', { title: 'Dune', year: 2021, externalIds: { tvmaze: '2' } }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('normalizes punctuation so a colon does not split one show in two', () => {
    const out = mergeDiscoveries([
      from('tmdb', { mediaType: 'tv', title: 'SILA: The Life Within Everything', year: 2026, externalIds: { tmdb: '1761542' } }),
      from('tvmaze', { mediaType: 'tv', title: 'SILA The Life Within Everything', year: 2026, externalIds: { tvmaze: '9' } }),
    ]);
    expect(out).toHaveLength(1);
  });
});

describe('confidence', () => {
  it('scores an IMDb-backed, twice-corroborated identity highly', () => {
    const [m] = mergeDiscoveries([
      from('tmdb', { externalIds: { imdb: 'tt1', tmdb: '2' } }),
      from('tvmaze', { externalIds: { imdb: 'tt1', tvmaze: '3' } }),
    ]);
    expect(m.confidence).toBeGreaterThanOrEqual(0.8);
  });

  /*
   * Most TVmaze shows carry no TVDB or IMDb id — enough to key a record, not
   * enough to act on. A single weak id must not clear a default 0.8 floor.
   */
  it('scores a TVmaze-only identity below the auto-monitor floor', () => {
    const [m] = mergeDiscoveries([from('tvmaze', { mediaType: 'tv', externalIds: { tvmaze: '93841' } })]);
    expect(m.confidence).toBeLessThan(0.8);
    expect(m.identityStatus).toBe('resolved');
  });

  it('scores a record with NO external id lowest, and still keys it', () => {
    const [m] = mergeDiscoveries([from('tvmaze', { title: 'Nameless Thing', year: 2026 })]);
    expect(m.confidence).toBeLessThanOrEqual(0.1);
    expect(m.dedupeKey).toBe('title:movie:nameless thing:2026');
  });

  it('metadata richness does not buy confidence — only identity does', () => {
    const [m] = mergeDiscoveries([
      from('tmdb', { title: 'Lush', overview: 'x'.repeat(400), posterUrl: 'p', rating: 9, voteCount: 5000, genres: ['Drama'] }),
    ]);
    expect(m.confidence).toBeLessThanOrEqual(0.1);
  });
});

describe('robustness', () => {
  it('drops records with no usable title rather than keying on an empty string', () => {
    expect(mergeDiscoveries([from('tmdb', { title: '   ' })])).toEqual([]);
  });

  it('is order-independent — the same inputs merge the same way reversed', () => {
    const inputs: SourcedDiscovery[] = [
      from('a', { externalIds: { imdb: 'tt1' } }),
      from('b', { externalIds: { imdb: 'tt1', tmdb: '9' } }),
      from('c', { externalIds: { tmdb: '9' } }),
    ];
    const forward = mergeDiscoveries(inputs);
    const reverse = mergeDiscoveries([...inputs].reverse());
    expect(forward).toHaveLength(1);
    expect(reverse).toHaveLength(1);
    expect(reverse[0].externalIds).toEqual(forward[0].externalIds);
  });

  it('chains a transitive join: a↔b by imdb, b↔c by tmdb', () => {
    const out = mergeDiscoveries([
      from('a', { externalIds: { imdb: 'tt1' } }),
      from('b', { externalIds: { imdb: 'tt1', tmdb: '9' } }),
      from('c', { externalIds: { tmdb: '9' } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].sourceProviders).toEqual(['a', 'b', 'c']);
  });
});
