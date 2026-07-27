import { buildNfoXml } from './media-nfo.service';
import { parseNfoXml } from './media-metadata.service';

/**
 * NFO round-trip.
 *
 * The sidecar is what makes the database rebuildable: wipe `media_items`,
 * rescan, and the NFOs restore metadata and provider IDs without a single
 * provider call. tinyMediaManager relies on exactly this property, which is why
 * a wipe-and-rescan is routine there.
 *
 * That only holds while the writer and the parser agree. Anything the writer
 * emits and the parser ignores exists ONLY in Postgres, and is lost on a
 * rebuild — silently, because nothing fails.
 */
describe('NFO write → read', () => {
  const FULL = {
    title: 'Dune: Part Two',
    originalTitle: 'Dune: Part Two',
    sortTitle: 'Dune 02',
    overview: 'Paul unites with the Fremen.',
    year: 2024,
    runtime: 166,
    rating: 8.5,
    certification: 'PG-13',
    releaseDate: '2024-03-01',
    genres: ['Science Fiction', 'Adventure'],
    studios: ['Legendary'],
    directors: ['Denis Villeneuve'],
    writers: ['Jon Spaihts'],
    tags: ['imax', 'rewatch'],
    cast: [{ name: 'Timothée Chalamet', role: 'Paul Atreides' }, { name: 'Zendaya' }],
    externalIds: { imdb: 'tt15239678', tmdb: '693134' },
  };

  it('restores every field the writer emits', () => {
    const back = parseNfoXml(buildNfoXml('movie', FULL));

    expect(back.title).toBe(FULL.title);
    expect(back.originalTitle).toBe(FULL.originalTitle);
    expect(back.sortTitle).toBe(FULL.sortTitle);
    expect(back.overview).toBe(FULL.overview);
    expect(back.year).toBe(FULL.year);
    expect(back.runtime).toBe(FULL.runtime);
    expect(back.rating).toBe(FULL.rating);
    expect(back.certification).toBe(FULL.certification);
    expect(back.releaseDate).toBe(FULL.releaseDate);
    expect(back.genres).toEqual(FULL.genres);
    expect(back.studios).toEqual(FULL.studios);
    expect(back.directors).toEqual(FULL.directors);
    expect(back.writers).toEqual(FULL.writers);
    expect(back.tags).toEqual(FULL.tags);
  });

  it('restores the external ids, which are the expensive part', () => {
    // Losing these means re-identifying against a provider — the step that has
    // historically stamped the wrong film onto an item.
    const back = parseNfoXml(buildNfoXml('movie', FULL));
    expect(back.externalIds?.imdb).toBe('tt15239678');
    expect(back.externalIds?.tmdb).toBe('693134');
  });

  it('restores cast with roles', () => {
    const back = parseNfoXml(buildNfoXml('movie', FULL));
    expect(back.cast).toEqual([
      { name: 'Timothée Chalamet', role: 'Paul Atreides' },
      { name: 'Zendaya' },
    ]);
  });

  it('survives characters that would break the XML', () => {
    const back = parseNfoXml(buildNfoXml('movie', {
      ...FULL, title: 'Fish & <Chips> "Quoted"',
    }));
    expect(back.title).toBe('Fish & <Chips> "Quoted"');
  });

  it('does not read an ACTOR id as the item id', () => {
    /*
     * tinyMediaManager writes a <tvdbid> inside every <actor>. A whole-document
     * search returned the first cast member's id instead of the episode's,
     * which put one actor's id on all of Dickinson S2, Game of Thrones and Luke
     * Cage — 871 tvdb ids shared across unrelated shows.
     */
    const xml = `<?xml version="1.0"?><episodedetails>
      <title>Ep</title>
      <uniqueid type="tvdb">7984092</uniqueid>
      <actor><name>Someone</name><tvdbid>247867</tvdbid></actor>
    </episodedetails>`;
    expect(parseNfoXml(xml).externalIds?.tvdb).toBe('7984092');
  });

  it('ignores a release date that is not a date', () => {
    const back = parseNfoXml('<movie><title>x</title><premiered>unknown</premiered></movie>');
    expect(back.releaseDate).toBeUndefined();
  });

  it('reads the older sidecar spellings too', () => {
    // Libraries predate our writer; other tools emit <releasedate> / <aired>.
    expect(parseNfoXml('<movie><releasedate>2001-05-04</releasedate></movie>').releaseDate)
      .toBe('2001-05-04');
    expect(parseNfoXml('<episodedetails><aired>1999-01-02</aired></episodedetails>').releaseDate)
      .toBe('1999-01-02');
  });

  it('invents nothing for an empty sidecar', () => {
    // It still reports where it came from, which is how the chain knows a local
    // sidecar answered rather than a provider.
    const back = parseNfoXml('<movie></movie>');
    expect(back.providerName).toBe('local-nfo');
    const { providerName, ...facts } = back;
    expect(facts).toEqual({});
  });
});
