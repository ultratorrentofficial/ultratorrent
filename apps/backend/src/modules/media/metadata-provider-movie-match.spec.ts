import { TmdbMetadataProvider } from './metadata-provider';

/**
 * The movie matcher must verify TMDB's result, not trust its popularity ranking.
 *
 * TMDB `/search/movie` ranks by popularity, so a short query title returns a
 * popular longer film first. Taking `results[0]` blindly wrote one film's ids onto
 * three different movies live — "The Maze Runner" (2014), "Maze" (2017) and "The
 * Runner" (2015) all got imdb tt1790864 / tmdb 198663. These pin the fix: a result
 * is accepted only when its title AND year actually match the query.
 */
function providerReturning(searchResults: any[], full: any = {}) {
  const provider = new TmdbMetadataProvider('test-key');
  // Stub the private HTTP layer: first call is the search, second is /movie/:id.
  (provider as unknown as { get: (p: string) => Promise<any> }).get = async (path: string) =>
    path.startsWith('/search/movie') ? { results: searchResults } : full;
  return provider;
}

// TMDB result shapes, popularity-ordered as the API returns them.
const mazeRunner = { id: 198663, title: 'The Maze Runner', original_title: 'The Maze Runner', release_date: '2014-09-10' };
const menInBlack = { id: 607, title: 'Men in Black', original_title: 'Men in Black', release_date: '1997-07-02' };

describe('TmdbMetadataProvider — movie result verification', () => {
  it('rejects a wrong-but-popular film for a short query title (the Maze case)', async () => {
    // Query "Maze" (2017). TMDB ranks "The Maze Runner" (2014) first.
    const provider = providerReturning([mazeRunner]);
    const details = await provider.fetchDetails({ kind: 'movie', title: 'Maze', year: 2017 });
    // No match beats a wrong match: a movie with no id is incomplete; a movie with
    // the WRONG id corrupts detection and dedup.
    expect(details).toBeNull();
  });

  it('rejects "The Runner" (2015) matching "The Maze Runner" (2014)', async () => {
    const provider = providerReturning([mazeRunner]);
    expect(await provider.fetchDetails({ kind: 'movie', title: 'The Runner', year: 2015 })).toBeNull();
  });

  it('rejects a 25-year year gap even when the title is a substring ("Men" → "Men in Black")', async () => {
    const provider = providerReturning([menInBlack]);
    expect(await provider.fetchDetails({ kind: 'movie', title: 'Men', year: 2022 })).toBeNull();
  });

  it('accepts the correct film — exact title and year', async () => {
    const provider = providerReturning([mazeRunner], {
      title: 'The Maze Runner',
      release_date: '2014-09-10',
      imdb_id: 'tt1790864',
    });
    const details = await provider.fetchDetails({ kind: 'movie', title: 'The Maze Runner', year: 2014 });
    expect(details).not.toBeNull();
    expect(details!.externalIds).toMatchObject({ tmdb: '198663', imdb: 'tt1790864' });
  });

  it('accepts a minor title variance on the right year (parsed name vs canonical)', async () => {
    // Folder parsed "Maze Runner"; TMDB canonical "The Maze Runner", same year.
    const provider = providerReturning([mazeRunner], { title: 'The Maze Runner', release_date: '2014-09-10', imdb_id: 'tt1790864' });
    const details = await provider.fetchDetails({ kind: 'movie', title: 'Maze Runner', year: 2014 });
    expect(details).not.toBeNull();
    expect(details!.externalIds?.tmdb).toBe('198663');
  });

  it('picks the correct result even when it is not first in the ranking', async () => {
    // A popular wrong film outranks the exact match; verification promotes the match.
    const exact = { id: 5182124, title: 'Maze', original_title: 'Maze', release_date: '2017-09-22' };
    const provider = providerReturning([mazeRunner, exact], { title: 'Maze', release_date: '2017-09-22', imdb_id: 'tt5182124' });
    const details = await provider.fetchDetails({ kind: 'movie', title: 'Maze', year: 2017 });
    expect(details).not.toBeNull();
    expect(details!.externalIds?.tmdb).toBe('5182124');
  });

  it('tolerates a one-year release/metadata drift, but not more', async () => {
    const provider = providerReturning([mazeRunner], { title: 'The Maze Runner', release_date: '2014-09-10', imdb_id: 'tt1790864' });
    // ±1 year is accepted (a release-date vs listing-year discrepancy)…
    expect(await provider.fetchDetails({ kind: 'movie', title: 'The Maze Runner', year: 2015 })).not.toBeNull();
    // …a 2-year gap on a weak-ish title is not.
    const provider2 = providerReturning([mazeRunner]);
    expect(await provider2.fetchDetails({ kind: 'movie', title: 'Runner', year: 2012 })).toBeNull();
  });

  it('rejects a same-YEAR near-miss the year gate cannot catch ("Soft" → "Soft & Quiet", both 2022)', async () => {
    // Live contamination: "Soft (2022)" got "Soft & Quiet (2022)"'s id. Same year,
    // so only the title-similarity threshold separates them.
    const softAndQuiet = { id: 900001, title: 'Soft & Quiet', original_title: 'Soft & Quiet', release_date: '2022-11-04' };
    const provider = providerReturning([softAndQuiet]);
    expect(await provider.fetchDetails({ kind: 'movie', title: 'Soft', year: 2022 })).toBeNull();
  });

  it('rejects a same-year remake collision ("The King" → "The Lion King", both 2019)', async () => {
    const lionKing2019 = { id: 420818, title: 'The Lion King', original_title: 'The Lion King', release_date: '2019-07-12' };
    const provider = providerReturning([lionKing2019]);
    expect(await provider.fetchDetails({ kind: 'movie', title: 'The King', year: 2019 })).toBeNull();
  });

  it('returns null on an empty search rather than throwing', async () => {
    const provider = providerReturning([]);
    expect(await provider.fetchDetails({ kind: 'movie', title: 'Nonexistent Film', year: 2030 })).toBeNull();
  });
});
