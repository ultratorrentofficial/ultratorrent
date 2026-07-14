import { mapRemoteIds, mapTvdbRecord } from './tvdb-metadata.provider';

/**
 * The mappers are the part that rots when TVDB renames a field, so they are pure
 * and tested against payloads shaped like the real v4 responses — no key, no
 * network. The traps encoded here are specific and were all seen in the wild:
 *
 *  - TVDB's `score` is a POPULARITY weight in the tens of thousands, not a 0–10
 *    user rating. Writing it into `rating` would poison a column TMDB and IMDb
 *    fill correctly.
 *  - external ids arrive as `remoteIds`, keyed by a human `sourceName`
 *    ("TheMovieDB.com"), not a slug.
 *  - an EPISODE lookup must overlay the episode's title/air-date while keeping
 *    the SERIES ids. Putting an episode's id in the series' id slot is the exact
 *    poisoning that once spread one episode's tconst across eighteen shows.
 */
const SERIES = {
  id: 121361,
  name: 'Game of Thrones',
  originalName: 'Game of Thrones',
  overview: 'Seven noble families fight for control of Westeros.',
  firstAired: '2011-04-17',
  averageRuntime: 60,
  score: 168041, // ← popularity, NOT a rating
  genres: [{ name: 'Drama' }, { name: 'Fantasy' }],
  networks: [{ name: 'HBO' }],
  companies: [{ name: 'Home Box Office' }],
  contentRatings: [{ name: 'TV-MA' }],
  tags: [{ name: 'dragons' }],
  remoteIds: [
    { id: 'tt0944947', type: 2, sourceName: 'IMDB' },
    { id: '1399', type: 12, sourceName: 'TheMovieDB.com' },
    { id: 'https://hbo.com/got', type: 0, sourceName: 'Official Website' },
  ],
  characters: [
    { peopleType: 'Actor', personName: 'Emilia Clarke', name: 'Daenerys Targaryen' },
    { peopleType: 'Director', personName: 'Alan Taylor' },
    { peopleType: 'Writer', personName: 'David Benioff' },
  ],
};

describe('mapRemoteIds', () => {
  it('maps the sources we can act on, by their human sourceName', () => {
    expect(mapRemoteIds(SERIES.remoteIds)).toEqual({ imdb: 'tt0944947', tmdb: '1399' });
  });

  it('ignores websites and socials rather than inventing providers for them', () => {
    expect(mapRemoteIds([{ id: 'x', sourceName: 'Facebook' }])).toEqual({});
    expect(mapRemoteIds(undefined)).toEqual({});
    expect(mapRemoteIds([{ sourceName: 'IMDB' }])).toEqual({}); // no id → no entry
  });
});

describe('mapTvdbRecord', () => {
  it('maps a series, and refuses to mistake TVDB’s popularity score for a rating', () => {
    const d = mapTvdbRecord(SERIES, { kind: 'tv' })!;

    expect(d.title).toBe('Game of Thrones');
    expect(d.overview).toContain('Westeros');
    expect(d.releaseDate).toBe('2011-04-17');
    expect(d.year).toBe(2011);
    expect(d.runtime).toBe(60);
    expect(d.genres).toEqual(['Drama', 'Fantasy']);
    expect(d.studios).toEqual(['HBO', 'Home Box Office']);
    expect(d.certification).toBe('TV-MA');
    expect(d.providerName).toBe('tvdb');
    expect(d.externalIds).toEqual({ tvdb: '121361', imdb: 'tt0944947', tmdb: '1399' });

    // The whole point: 168041 is not a rating and must not be written as one.
    expect(d.rating).toBeUndefined();
  });

  it('reads cast, directors and writers out of TVDB’s single `characters` list', () => {
    const d = mapTvdbRecord(SERIES, { kind: 'tv' })!;

    expect(d.cast).toEqual([{ name: 'Emilia Clarke', role: 'Daenerys Targaryen' }]);
    expect(d.directors).toEqual(['Alan Taylor']);
    expect(d.writers).toEqual(['David Benioff']);
    // A director is crew, not cast — TVDB puts them in the same array.
    expect(d.cast?.some((c) => c.name === 'Alan Taylor')).toBe(false);
  });

  it('overlays an episode’s title and air date while keeping the SERIES ids', () => {
    const episode = {
      id: 3254641,
      name: 'Winter Is Coming',
      overview: 'Ned Stark is torn between his family and an old friend.',
      aired: '2011-04-17',
      runtime: 62,
      seasonNumber: 1,
      number: 1,
    };

    const d = mapTvdbRecord(SERIES, { kind: 'tv', episode })!;

    expect(d.title).toBe('Winter Is Coming');
    expect(d.overview).toContain('Ned Stark');
    expect(d.releaseDate).toBe('2011-04-17');
    expect(d.runtime).toBe(62);

    // The ids still belong to the SERIES (121361), never the episode (3254641).
    expect(d.externalIds).toEqual({ tvdb: '121361', imdb: 'tt0944947', tmdb: '1399' });
    expect(d.externalIds?.tvdb).not.toBe('3254641');
  });

  it('maps a movie record, taking the year from its release date', () => {
    const d = mapTvdbRecord(
      {
        id: 615,
        name: 'The Matrix',
        first_release: { date: '1999-03-31' },
        genres: [{ name: 'Science Fiction' }],
        remoteIds: [{ id: 'tt0133093', sourceName: 'IMDB' }],
      },
      { kind: 'movie' },
    )!;

    expect(d.title).toBe('The Matrix');
    expect(d.year).toBe(1999);
    expect(d.externalIds).toEqual({ tvdb: '615', imdb: 'tt0133093' });
  });

  it('returns null for a record with no id, rather than a hollow result', () => {
    expect(mapTvdbRecord({ name: 'No Id' }, { kind: 'tv' })).toBeNull();
    expect(mapTvdbRecord(null, { kind: 'tv' })).toBeNull();
  });

  it('survives a payload with every optional field missing', () => {
    const d = mapTvdbRecord({ id: 7, name: 'Sparse' }, { kind: 'tv' })!;

    expect(d.title).toBe('Sparse');
    expect(d.genres).toEqual([]);
    expect(d.cast).toEqual([]);
    expect(d.year).toBeUndefined();
    expect(d.externalIds).toEqual({ tvdb: '7' });
  });
});
