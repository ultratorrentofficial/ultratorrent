import { MEDIA_ITEM_SORTS, type MediaItemSort } from '@/lib/api';
import { EMPTY_FILTERS, type BrowserFilters } from './BrowserFilterBar';

/**
 * The browser's filters, carried in the URL rather than in component state.
 *
 * Reported from a real session: sort the TV library by *Recently added*, open a
 * show, open an episode — and there is no way back to the list you were looking
 * at. Half of that is a missing Back button, and half is this: the sort lived in
 * `useState`, so even returning to the same URL rebuilt the default A–Z view.
 * A view an operator arranged is part of where they are, and "where you are" is
 * the URL — which is also what makes it survive a reload and a shared link.
 *
 * Only non-default values are written. A URL that spells out every default is
 * noise, and it makes "am I filtered?" harder to answer at a glance.
 */
export const FILTER_PARAM_KEYS = ['sort', 'q', 'status', 'issue'] as const;

export function filtersFromParams(params: URLSearchParams): BrowserFilters {
  const sort = params.get('sort');
  return {
    search: params.get('q') ?? '',
    // Narrowed against the shipped list rather than trusted: a hand-edited URL
    // must not put an unknown ordering into a query the server will reject.
    sort: (MEDIA_ITEM_SORTS as readonly string[]).includes(sort ?? '')
      ? (sort as MediaItemSort)
      : EMPTY_FILTERS.sort,
    matchStatus: (params.get('status') as BrowserFilters['matchStatus']) || null,
    issue: (params.get('issue') as BrowserFilters['issue']) || null,
  };
}

/**
 * The next query string: `base` with the filter keys rewritten.
 *
 * Everything else in `base` is preserved — `library`, `show` and `showTitle`
 * are the operator's position, and rewriting filters must not throw the
 * position away. That is exactly how entering a show used to drop the sort.
 */
export function paramsWithFilters(
  base: URLSearchParams,
  filters: BrowserFilters,
): Record<string, string> {
  const next: Record<string, string> = {};
  base.forEach((value, key) => {
    if (!(FILTER_PARAM_KEYS as readonly string[]).includes(key)) next[key] = value;
  });
  if (filters.sort !== EMPTY_FILTERS.sort) next.sort = filters.sort;
  if (filters.search) next.q = filters.search;
  if (filters.matchStatus) next.status = filters.matchStatus;
  if (filters.issue) next.issue = filters.issue;
  return next;
}
