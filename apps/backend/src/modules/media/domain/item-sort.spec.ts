import {
  DEFAULT_ITEM_SORT, ITEM_SORTS, isAlphabetical, isItemSort, orderByForSort,
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
