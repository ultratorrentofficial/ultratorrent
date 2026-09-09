/**
 * Canonical title and year, in one place.
 *
 * Three different normalizers grew up in this codebase, none of which treated a
 * trailing `(2022)` as presentation metadata:
 *
 *   - `normalizeTitle()` in `media/imdb/imdb-match.ts` — used by discovery
 *   - `normalizeTitle()` in `rss/tv-show-status/tv-show-status-provider.ts`
 *   - an inline `title.toLowerCase().trim()` writing `WatchlistItem.normalizedTitle`
 *
 * So the same work, formatted two ways by two providers, produced two different
 * identities in every table — which is how "The Terminal List" and "The Terminal
 * List (2022)" both ended up monitored. These helpers are the single answer to
 * "what work is this", and the callers above defer to them.
 */

/**
 * A year a real title could plausibly carry as a *release* year.
 *
 * The lower bound is cinema itself; the upper bound is deliberately generous, so
 * an upcoming title announced several years out still normalizes. Anything
 * outside this is a number that happens to have four digits.
 */
const EARLIEST_RELEASE_YEAR = 1870;
const LATEST_PLAUSIBLE_YEAR = 2999;

/**
 * A trailing, parenthesised (or bracketed) four-digit year — and nothing else
 * after it.
 *
 * Anchored to the END on purpose. `(2022)` at the end of "Tulsa King (2022)" is
 * how a UI renders a year; the same digits anywhere else are part of the name.
 */
/*
 * The separator run is BOUNDED.
 *
 * `[\s._-]*` is unanchored and the pattern is tried at every position, so a
 * title made of separators costs O(n²) — a canonicalisation that runs on every
 * provider title, every RSS rule name and every library item. Thirty-two is far
 * more than any real title puts between its name and its year, so the semantics
 * are unchanged for anything genuine while the backtracking becomes linear.
 */
const TRAILING_YEAR = /[\s._-]{0,32}[([]\s*(\d{4})\s*[)\]]\s*$/;

/** A bare trailing year, as release names write it: `The.Terminal.List.2022`. */
const TRAILING_BARE_YEAR = /[\s._-]{1,32}(\d{4})\s*$/;

export interface CanonicalTitle {
  /** Display form, year suffix removed, whitespace tidied. */
  title: string;
  /** Comparison form: lowercase, punctuation-free, no year suffix. */
  normalizedTitle: string;
  /** The year lifted out of the title, if one was there. */
  year: number | null;
}

function plausibleYear(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= EARLIEST_RELEASE_YEAR && n <= LATEST_PLAUSIBLE_YEAR ? n : null;
}

/**
 * Strip a presentation year suffix — and only a presentation year suffix.
 *
 * The danger here is over-eagerness. These titles must survive untouched:
 *
 *   Blade Runner 2049      — the number IS the title
 *   2012                   — the whole title is a year
 *   Fahrenheit 451         — a number that is not a year
 *   Apollo 13              — likewise
 *   Ocean's 11 (2001)      — only the SUFFIX goes; the 11 stays
 *
 * So: a bare trailing number is removed only when something else remains, and a
 * parenthesised year is removed only when it is genuinely trailing. `2012` keeps
 * its title because stripping it would leave nothing, which is never right.
 */
export function splitTrailingYear(raw: string): { title: string; year: number | null } {
  let title = String(raw ?? '').trim();
  let year: number | null = null;

  const bracketed = title.match(TRAILING_YEAR);
  if (bracketed) {
    const candidate = plausibleYear(bracketed[1]);
    const rest = title.slice(0, bracketed.index).trim();
    /*
     * `rest` must be non-empty. A title that IS a parenthesised year — "(2012)" —
     * would otherwise normalize to the empty string and collide with every other
     * title that did the same.
     */
    if (candidate !== null && rest) {
      return { title: rest, year: candidate };
    }
    return { title, year: null };
  }

  const bare = title.match(TRAILING_BARE_YEAR);
  if (bare) {
    const candidate = plausibleYear(bare[1]);
    const rest = title.slice(0, bare.index).trim();
    /*
     * A bare trailing year is far weaker evidence than a bracketed one — "Blade
     * Runner 2049" has exactly this shape. It is only treated as a year when the
     * separator was a release-name separator (`.`, `_`, `-`), never a plain
     * space, because "Blade Runner 2049" and "The.Terminal.List.2022" differ in
     * precisely that.
     */
    const separator = title.slice(bare.index!, bare.index! + (bare[0].length - bare[1].length));
    const releaseStyle = /[._-]/.test(separator);
    if (candidate !== null && rest && releaseStyle) {
      return { title: rest, year: candidate };
    }
  }

  return { title, year };
}

/**
 * Base normalization: lowercase, diacritics folded, `&` spelled, punctuation
 * collapsed to single spaces.
 *
 * Deliberately identical in behaviour to `normalizeTitle()` in
 * `media/imdb/imdb-match.ts`, which remains the implementation the rest of the
 * media pipeline uses. This exists so `packages/shared` has no import into the
 * backend; the two must not drift.
 */
export function normalizeTitleBase(input: string): string {
  return String(input ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * The canonical identity of a title.
 *
 * `knownYear` wins when supplied — a provider's structured year field is better
 * evidence than digits parsed out of a display string. A year found in the title
 * is used only to fill a gap, and never to contradict.
 */
export function canonicalizeTitle(raw: string, knownYear?: number | null): CanonicalTitle {
  const { title, year: fromTitle } = splitTrailingYear(raw);
  const year =
    knownYear !== undefined && knownYear !== null && plausibleYear(String(knownYear)) !== null
      ? knownYear
      : fromTitle;
  return { title, normalizedTitle: normalizeTitleBase(title), year: year ?? null };
}

/**
 * Do two titles name the same work?
 *
 * Year is compared only when BOTH sides have one: a missing year is missing
 * information, not a mismatch — hand-added watchlist entries frequently carry
 * none. Two different years, though, are a real contradiction.
 */
export function sameCanonicalTitle(
  a: { normalizedTitle: string; year?: number | null },
  b: { normalizedTitle: string; year?: number | null },
): boolean {
  if (!a.normalizedTitle || a.normalizedTitle !== b.normalizedTitle) return false;
  if (a.year != null && b.year != null) return a.year === b.year;
  return true;
}
