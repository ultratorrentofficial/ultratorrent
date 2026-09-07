import { formatCalendarDate, formatDateTime, formatRelativeTime } from '@/lib/format';

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
