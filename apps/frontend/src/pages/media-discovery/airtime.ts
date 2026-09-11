import { calendarMonthOf, formatCalendarDate, formatDateTime, formatRelativeTime } from '@/lib/format';

/**
 * Turning a release date into something a person reads.
 *
 * The whole difficulty is that the API returns two different KINDS of date and
 * only one of them may be converted to a viewer's timezone:
 *
 *   `airsAt` — a real instant the provider stated (TVmaze publishes an
 *              `airstamp` with an offset). Localises correctly.
 *   `date`   — the network's local calendar date. Converting it moves it a day
 *              for anyone west of UTC, so it is rendered as the day it says.
 *
 * A single "just format the date" would be wrong for one of the two, and wrong
 * in the quiet way: the show simply appears to air a day earlier than it does.
 */

export interface ReleaseDateLike {
  releaseType: string;
  date: string | null;
  airsAt?: string | null;
  region?: string | null;
}

export interface AirInfo {
  /** "Sat, 15 Nov 2026, 09:00 PM" or "Sat, 15 Nov 2026" */
  when: string;
  /** "in 3 days" / "2 days ago" — omitted when there is no usable instant. */
  relative: string | null;
  /** True when a real clock time is being shown, not just a day. */
  hasTime: boolean;
}

/**
 * The release worth putting on a card.
 *
 * The soonest one that still has a date. A title often carries several — a
 * premiere, an episode airing, a streaming drop — and the next one is the one a
 * person is deciding about.
 */
export function nextRelease<T extends ReleaseDateLike>(dates: T[] | undefined): T | null {
  const dated = (dates ?? []).filter((d) => d.date || d.airsAt);
  if (!dated.length) return null;
  const key = (d: T) => d.airsAt ?? d.date ?? '';
  return [...dated].sort((a, b) => key(a).localeCompare(key(b)))[0];
}

export function describeAir(release: ReleaseDateLike | null | undefined): AirInfo | null {
  if (!release) return null;

  if (release.airsAt) {
    return {
      when: formatDateTime(release.airsAt),
      relative: formatRelativeTime(release.airsAt),
      hasTime: true,
    };
  }
  if (release.date) {
    return {
      when: formatCalendarDate(release.date),
      /*
       * A relative time IS still useful for a date-only release — "in 3 days" is
       * the thing most people actually want — and it is computed from midnight
       * UTC on that day. That is precise to within a day, which is all the
       * underlying value claims to be, so it cannot mislead the way a clock time
       * derived from the same value would.
       */
      relative: formatRelativeTime(`${release.date.slice(0, 10)}T00:00:00.000Z`),
      hasTime: false,
    };
  }
  return null;
}

/**
 * The calendar month a release falls in, as `YYYY-MM`.
 *
 * Follows the same two-kinds-of-date rule as {@link describeAir}, and for the
 * same reason. An instant is placed in the viewer's own zone: a 9pm Eastern
 * premiere on 31 October is stamped 01:00 UTC on 1 November, and filing it under
 * November would contradict the date printed on its own card. A calendar date is
 * already the network's local day, so its month is read straight off it.
 */
export function releaseMonthKey(release: ReleaseDateLike | null | undefined): string | null {
  if (!release) return null;
  if (release.airsAt) return calendarMonthOf(release.airsAt);
  const m = release.date ? /^(\d{4})-(\d{2})/.exec(release.date) : null;
  return m ? `${m[1]}-${m[2]}` : null;
}

export interface ReleaseMonthGroup<T> {
  /** `YYYY-MM`, or null for titles with no dated release. */
  key: string | null;
  items: T[];
}

/**
 * Items filed under the month of their next release, in the order given.
 *
 * The server does the ordering — a page is a slice of it, so the order has to
 * be decided where every title is visible. This only draws the boundaries.
 *
 * Groups are merged by month rather than cut at every change, and the months
 * are then put in calendar order. The server orders by instant and the heading
 * is a LOCAL month, so a 9pm premiere on 31 October (01:00 UTC, 1 November) sorts
 * after a date-only release on 1 November; cutting on change would print
 * November, October, November. Within a month the server's order stands.
 * Undated titles always come last: an unannounced date is not "soon".
 */
export function groupByReleaseMonth<T>(
  items: readonly T[],
  releaseOf: (item: T) => ReleaseDateLike | null,
): ReleaseMonthGroup<T>[] {
  const groups = new Map<string | null, T[]>();
  for (const item of items) {
    const key = releaseMonthKey(releaseOf(item));
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  const dated = [...groups]
    .filter((entry): entry is [string, T[]] => entry[0] !== null)
    // `YYYY-MM` sorts correctly as text.
    .sort(([a], [b]) => a.localeCompare(b));
  const undated = groups.get(null);
  return [
    ...dated.map(([key, grouped]) => ({ key, items: grouped })),
    ...(undated ? [{ key: null, items: undated }] : []),
  ];
}
