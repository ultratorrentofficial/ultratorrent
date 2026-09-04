/**
 * Pre-send verification: does this item have enough to be worth announcing?
 *
 * A newsletter is a shop window. An entry with no poster and no synopsis is a
 * line of text where a card should be, and a reader cannot tell whether the
 * film is dull or the library is broken. On the 2026-09-04 Movies issue six of
 * nineteen films went out like that — a third of the email.
 *
 * The rule is split in two on purpose:
 *
 *  - **Required** — artwork and a synopsis. Without either the card has nothing
 *    to show, so the item is withheld from the issue and carried to the next
 *    one (see `deferredItems`), not dropped.
 *  - **Advisory** — year, runtime, rating, genres. Each is a pill on the card
 *    that simply does not render when absent; the card still works. These are
 *    reported so an operator can see a library degrading, and never withhold.
 *
 * Kept pure and separate from the newsletter service so the rule can be read
 * and tested without a database, an SMTP server or a render.
 */

/** Everything verification can find missing. */
export type MissingField = 'art' | 'overview' | 'year' | 'runtime' | 'rating' | 'genres';

/** Missing any of these and the item is not published. */
export const REQUIRED_FIELDS = ['art', 'overview'] as const;

/** Missing any of these is worth reporting, but the card still stands up. */
export const ADVISORY_FIELDS = ['year', 'runtime', 'rating', 'genres'] as const;

/** The parts of a newsletter entry verification actually judges. */
export interface VerifiableEntry {
  title: string;
  year?: number | null;
  overview?: string | null;
  rating?: number | null;
  runtime?: number | null;
  genres?: string[];
}

export interface EntryVerdict {
  /** Required fields that are absent — non-empty means "do not publish". */
  missing: MissingField[];
  /** Advisory fields that are absent — reported, never blocking. */
  advisory: MissingField[];
}

/** Text that is present, not just non-null: `''` and `'   '` are not a synopsis. */
function hasText(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Judge one entry.
 *
 * `hasArt` is passed in rather than read off the entry because artwork is
 * resolved separately — a show's poster comes from the show's own library item,
 * not from the episode that triggered the issue.
 */
export function verifyEntry(entry: VerifiableEntry, hasArt: boolean): EntryVerdict {
  const missing: MissingField[] = [];
  if (!hasArt) missing.push('art');
  if (!hasText(entry.overview)) missing.push('overview');

  const advisory: MissingField[] = [];
  if (entry.year == null) advisory.push('year');
  if (entry.runtime == null || entry.runtime <= 0) advisory.push('runtime');
  if (entry.rating == null || entry.rating <= 0) advisory.push('rating');
  if (!entry.genres || entry.genres.length === 0) advisory.push('genres');

  return { missing, advisory };
}

/** True when nothing REQUIRED is missing. Advisory gaps never block a send. */
export function isPublishable(verdict: EntryVerdict): boolean {
  return verdict.missing.length === 0;
}

/** One entry that did not pass, as the event log and the preview report it. */
export interface WithheldEntry {
  itemId?: string;
  title: string;
  year: number | null;
  mediaType: string;
  missing: MissingField[];
  /** True once this entry has already been held back by an earlier issue. */
  deferred?: boolean;
}

/** One entry that passed but is missing something worth mentioning. */
export interface IncompleteEntry {
  title: string;
  advisory: MissingField[];
}

/** What pre-send verification found, for the operator and the event log. */
export interface VerificationReport {
  /** Entries examined, before anything was withheld. */
  checked: number;
  /** Entries that will be published. */
  published: number;
  /** Entries held back from this issue. */
  withheld: WithheldEntry[];
  /** Published entries with advisory gaps. */
  incomplete: IncompleteEntry[];
  /** Entries a repair pass managed to complete in time for this issue. */
  repaired: number;
  /** Entries dropped for good: deferred past the window and still incomplete. */
  abandoned: WithheldEntry[];
}

export function emptyReport(): VerificationReport {
  return { checked: 0, published: 0, withheld: [], incomplete: [], repaired: 0, abandoned: [] };
}

/**
 * How long an item keeps being carried forward before the newsletter gives up.
 *
 * A film TMDB has under a different name ("Middletown" is "Teenage Wasteland"
 * there) will never complete on its own, and retrying it every week forever
 * spends provider calls to reach the same answer. Four weeks is long enough for
 * a provider to publish artwork for a new release and short enough that the
 * operator hears about a permanent failure while the file is still recent.
 */
export const DEFERRAL_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;

/** One carried-forward item as stored on the newsletter. */
export interface DeferredItem {
  id: string;
  /** ISO timestamp of the FIRST issue that held it back. */
  firstDeferredAt: string;
}

/** Read the stored `deferredItems` defensively — it is operator-visible JSON. */
export function parseDeferred(value: unknown): DeferredItem[] {
  if (!Array.isArray(value)) return [];
  const out: DeferredItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const { id, firstDeferredAt } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0) continue;
    out.push({
      id,
      firstDeferredAt:
        typeof firstDeferredAt === 'string' && !Number.isNaN(Date.parse(firstDeferredAt))
          ? firstDeferredAt
          : new Date(0).toISOString(),
    });
  }
  return out;
}

/** Split the carried-forward list into "still try" and "past the window". */
export function partitionDeferred(
  deferred: DeferredItem[],
  now: Date,
): { live: DeferredItem[]; expired: DeferredItem[] } {
  const live: DeferredItem[] = [];
  const expired: DeferredItem[] = [];
  for (const d of deferred) {
    const age = now.getTime() - Date.parse(d.firstDeferredAt);
    (age > DEFERRAL_WINDOW_MS ? expired : live).push(d);
  }
  return { live, expired };
}

/**
 * The list to store after an issue: everything withheld now, each keeping the
 * date it was FIRST held back so the window measures the whole wait rather than
 * restarting every week.
 */
export function nextDeferred(
  withheld: WithheldEntry[],
  previous: DeferredItem[],
  now: Date,
): DeferredItem[] {
  const firstSeen = new Map(previous.map((d) => [d.id, d.firstDeferredAt]));
  const out: DeferredItem[] = [];
  for (const w of withheld) {
    if (!w.itemId) continue;
    out.push({ id: w.itemId, firstDeferredAt: firstSeen.get(w.itemId) ?? now.toISOString() });
  }
  return out;
}
