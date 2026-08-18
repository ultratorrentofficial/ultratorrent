import type { Prisma } from '@prisma/client';

/**
 * How a library listing is ordered.
 *
 * The browser had one order — title ascending — which answers "where is this
 * film" and nothing else. "What arrived this week" and "what is oldest" are the
 * questions an operator actually asks of a library they are curating, and
 * neither can be answered by scrolling an alphabet.
 *
 * A closed set, mapped here rather than accepted from the query string: an
 * arbitrary `orderBy` from the client is both an injection surface and a way to
 * sort by an unindexed column and stall the database.
 */
export const ITEM_SORTS = [
  'title',
  'title_desc',
  'added_desc',
  'added_asc',
  'year_desc',
  'year_asc',
  'updated_desc',
] as const;

export type ItemSort = (typeof ITEM_SORTS)[number];

export const DEFAULT_ITEM_SORT: ItemSort = 'title';

export function isItemSort(value: string | undefined): value is ItemSort {
  return !!value && (ITEM_SORTS as readonly string[]).includes(value);
}

/**
 * The Prisma ordering for a sort key.
 *
 * Two properties every entry has to keep:
 *
 * **A stable tiebreaker.** Ordering by a non-unique column alone leaves rows
 * with equal values in an undefined order, which SQL is free to change between
 * queries — so a paged grid can show one item twice and skip another entirely
 * while the reader is paging. `id` breaks every tie.
 *
 * **Nulls last.** `year` and `sortTitle` are nullable, and a descending sort
 * puts NULLs first by default in PostgreSQL — so "newest first" would open with
 * every film whose year was never identified. Unknown belongs at the end of the
 * list, whichever direction is asked for.
 */
export function orderByForSort(sort: ItemSort): Prisma.MediaItemOrderByWithRelationInput[] {
  switch (sort) {
    case 'title_desc':
      return [{ title: 'desc' }, { id: 'asc' }];
    case 'added_desc':
      return [{ createdAt: 'desc' }, { id: 'asc' }];
    case 'added_asc':
      return [{ createdAt: 'asc' }, { id: 'asc' }];
    case 'year_desc':
      return [{ year: { sort: 'desc', nulls: 'last' } }, { title: 'asc' }, { id: 'asc' }];
    case 'year_asc':
      return [{ year: { sort: 'asc', nulls: 'last' } }, { title: 'asc' }, { id: 'asc' }];
    case 'updated_desc':
      return [{ updatedAt: 'desc' }, { id: 'asc' }];
    case 'title':
    default:
      // `createdAt` kept as the second key for the default, preserving the
      // ordering the browser has always had for same-titled items.
      return [{ title: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];
  }
}

/**
 * Does this ordering follow the alphabet?
 *
 * The A–Z rail anchors the listing at a letter (`title >= 'M'`), which only
 * means anything while the listing is IN title order. Under "recently added"
 * the same anchor silently drops everything before M for no visible reason, so
 * the caller drops the anchor instead.
 */
export function isAlphabetical(sort: ItemSort): boolean {
  return sort === 'title';
}

/**
 * One show, reduced to the fields an ordering needs.
 *
 * A show is not a row in the database — it is a grouping of its episodes — so
 * the same sort keys have to be answered from the group. `lastAddedAt` is the
 * newest episode's `createdAt`, which is the only reading of "recently added"
 * that means anything for television: a series folder is created once, years
 * ago, and never touched again, while the thing an operator is looking for is
 * the show that just received an episode.
 */
export interface SortableSeries {
  title: string;
  year: number | null;
  lastAddedAt: Date;
  lastUpdatedAt: Date;
}

/**
 * Order shows the way the same key orders items.
 *
 * Reported from a live library: sorting the TV browser by "recently added" left
 * the order unchanged, because the show list was sorted by title unconditionally
 * and the chosen key never reached it. A show that gained an episode minutes ago
 * sorted between the same two neighbours it always had.
 *
 * Title is the tiebreaker everywhere, so equal timestamps (a season imported in
 * one pass) stay in a stable, readable order rather than an arbitrary one.
 */
export function compareSeries(sort: ItemSort): (a: SortableSeries, b: SortableSeries) => number {
  const byTitle = (a: SortableSeries, b: SortableSeries) => a.title.localeCompare(b.title);
  // Unknown year belongs at the end in both directions, matching `orderByForSort`.
  const byYear = (a: SortableSeries, b: SortableSeries, dir: 1 | -1) => {
    if (a.year == null && b.year == null) return 0;
    if (a.year == null) return 1;
    if (b.year == null) return -1;
    return (a.year - b.year) * dir;
  };
  switch (sort) {
    case 'title_desc':
      return (a, b) => -byTitle(a, b);
    case 'added_desc':
      return (a, b) => b.lastAddedAt.getTime() - a.lastAddedAt.getTime() || byTitle(a, b);
    case 'added_asc':
      return (a, b) => a.lastAddedAt.getTime() - b.lastAddedAt.getTime() || byTitle(a, b);
    case 'year_desc':
      return (a, b) => byYear(a, b, -1) || byTitle(a, b);
    case 'year_asc':
      return (a, b) => byYear(a, b, 1) || byTitle(a, b);
    case 'updated_desc':
      return (a, b) => b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime() || byTitle(a, b);
    case 'title':
    default:
      return byTitle;
  }
}
