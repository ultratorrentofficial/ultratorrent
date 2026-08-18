import {
  compareSeries, DEFAULT_ITEM_SORT, ITEM_SORTS, isAlphabetical, isItemSort, orderByForSort,
  type SortableSeries,
} from './item-sort';

describe('item sort', () => {
  it('accepts only known sorts', () => {
    for (const s of ITEM_SORTS) expect(isItemSort(s)).toBe(true);
    for (const s of ['createdAt', 'title; drop table', '', undefined]) {
      expect(isItemSort(s as string)).toBe(false);
    }
  });

  it('gives every sort a stable tiebreaker', () => {
    /*
     * Without one, rows with equal values sit in an order SQL may change
     * between queries — so paging a grid can show an item twice and skip
     * another. Every ordering must end at a unique column.
     */
    for (const s of ITEM_SORTS) {
      const order = orderByForSort(s);
      expect(order[order.length - 1]).toEqual({ id: 'asc' });
    }
  });

  it('sorts unknown years last in both directions', () => {
    // Descending would otherwise open with every film whose year was never
    // identified, because PostgreSQL puts NULLs first on DESC.
    expect(orderByForSort('year_desc')[0]).toEqual({ year: { sort: 'desc', nulls: 'last' } });
    expect(orderByForSort('year_asc')[0]).toEqual({ year: { sort: 'asc', nulls: 'last' } });
  });

  it('orders recently-added by creation time', () => {
    expect(orderByForSort('added_desc')[0]).toEqual({ createdAt: 'desc' });
    expect(orderByForSort('added_asc')[0]).toEqual({ createdAt: 'asc' });
  });

  it('keeps the historical default ordering', () => {
    expect(DEFAULT_ITEM_SORT).toBe('title');
    expect(orderByForSort('title').slice(0, 2)).toEqual([{ title: 'asc' }, { createdAt: 'asc' }]);
  });

  it('knows which sorts the A–Z rail still makes sense under', () => {
    // The rail anchors on `title >= letter`; under any other order that anchor
    // drops rows for no reason a reader can see.
    expect(isAlphabetical('title')).toBe(true);
    for (const s of ITEM_SORTS.filter((x) => x !== 'title')) expect(isAlphabetical(s)).toBe(false);
  });
});

/**
 * Reported from a live TV library: "sorted by Recently added ... there was no
 * change", because a show's own row is as old as its folder. What the operator
 * is looking for is the show that just received an episode.
 */
describe('compareSeries', () => {
  const show = (title: string, over: Partial<SortableSeries> = {}): SortableSeries => ({
    title,
    year: 2020,
    lastAddedAt: new Date('2020-01-01'),
    lastUpdatedAt: new Date('2020-01-01'),
    ...over,
  });

  it('puts the show with the newest episode first, not the newest folder', () => {
    const stale = show('Alpha', { lastAddedAt: new Date('2021-01-01') });
    const fresh = show('Zulu', { lastAddedAt: new Date('2026-08-18') });
    expect([stale, fresh].sort(compareSeries('added_desc'))[0]).toBe(fresh);
  });

  it('reverses for added_asc', () => {
    const old = show('Alpha', { lastAddedAt: new Date('2019-01-01') });
    const recent = show('Zulu', { lastAddedAt: new Date('2026-08-18') });
    expect([recent, old].sort(compareSeries('added_asc'))[0]).toBe(old);
  });

  it('breaks ties by title, so a season imported in one pass stays readable', () => {
    const at = new Date('2026-08-18');
    const b = show('Beyond the Gates', { lastAddedAt: at });
    const a = show('All American', { lastAddedAt: at });
    expect([b, a].sort(compareSeries('added_desc')).map((s) => s.title))
      .toEqual(['All American', 'Beyond the Gates']);
  });

  it('keeps an unknown year last in both directions', () => {
    const known = show('Known', { year: 2001 });
    const unknown = show('Unknown', { year: null });
    expect([unknown, known].sort(compareSeries('year_desc'))[1]).toBe(unknown);
    expect([unknown, known].sort(compareSeries('year_asc'))[1]).toBe(unknown);
  });

  it('still orders by title when asked to', () => {
    const z = show('Zulu', { lastAddedAt: new Date('2026-08-18') });
    const a = show('Alpha', { lastAddedAt: new Date('2019-01-01') });
    expect([z, a].sort(compareSeries('title')).map((s) => s.title)).toEqual(['Alpha', 'Zulu']);
    expect([a, z].sort(compareSeries('title_desc')).map((s) => s.title)).toEqual(['Zulu', 'Alpha']);
  });
});
