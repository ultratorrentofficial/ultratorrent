import { describe, expect, it } from 'vitest';
import { filtersFromParams, paramsWithFilters } from './filters-params';
import { EMPTY_FILTERS } from './BrowserFilterBar';

const p = (s: string) => new URLSearchParams(s);

/**
 * The defect: "Library Browser → TV Shows → re-order to Recently Added → select
 * Reacher → select an episode. Here I can't go back." Returning to the browser
 * rebuilt the default A–Z list, because the arrangement lived in component
 * state and only the position (library, show) was ever in the URL.
 */
describe('browser filters in the URL', () => {
  it('reads an arranged view back out of the URL', () => {
    expect(filtersFromParams(p('library=lib1&sort=added_desc&q=reacher'))).toMatchObject({
      sort: 'added_desc',
      search: 'reacher',
    });
  });

  it('falls back to the default for an ordering it does not ship', () => {
    // A hand-edited URL must not put an unknown ordering into a server query.
    expect(filtersFromParams(p('sort=by_vibes')).sort).toBe(EMPTY_FILTERS.sort);
  });

  it('keeps the position when the arrangement changes', () => {
    // Entering a show used to replace every parameter, which is precisely how
    // the sort was lost on the way in.
    const next = paramsWithFilters(p('library=lib1&show=k1&showTitle=Reacher'), {
      ...EMPTY_FILTERS,
      sort: 'added_desc',
    });
    expect(next).toMatchObject({ library: 'lib1', show: 'k1', showTitle: 'Reacher', sort: 'added_desc' });
  });

  it('writes nothing for a default view', () => {
    // A URL spelling out every default is noise, and hides whether anything is
    // actually filtered.
    expect(paramsWithFilters(p('library=lib1'), EMPTY_FILTERS)).toEqual({ library: 'lib1' });
  });

  it('drops a filter that was cleared rather than leaving it stale', () => {
    const next = paramsWithFilters(p('library=lib1&q=old&status=unmatched'), EMPTY_FILTERS);
    expect(next).toEqual({ library: 'lib1' });
  });

  it('round-trips every filter', () => {
    const filters = { search: 'x', sort: 'year_desc', matchStatus: 'unmatched', issue: 'duplicate' } as const;
    const round = filtersFromParams(new URLSearchParams(paramsWithFilters(p(''), filters)));
    expect(round).toEqual(filters);
  });
});
