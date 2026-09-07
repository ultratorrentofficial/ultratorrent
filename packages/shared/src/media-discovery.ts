/**
 * The Media Discovery vocabulary, shared by the backend and the Discover UI.
 *
 * Discovery answers **what should be monitored**. It never decides whether a
 * particular release is worth grabbing — that stays with the existing Smart
 * Download engine — and it never downloads anything itself.
 *
 * These constants live here because both halves must agree on them exactly: a
 * decision the API emits and the UI cannot render, or a release type the filter
 * form offers and the evaluator ignores, is a silent mismatch that only shows up
 * as a title that never appears.
 */

// --- release-date semantics ------------------------------------------------
/**
 * Movie release types, in the order a title normally passes through them.
 *
 * Kept separate from television's because they are not the same question. A user
 * who wants "films once they reach streaming" is asking about a date that may be
 * a year after the theatrical one, and a single merged list would make that
 * distinction unexpressible.
 */
export const MOVIE_RELEASE_TYPES = [
  'festival',
  'limited_theatrical',
  'wide_theatrical',
  'digital',
  'streaming',
  'physical',
  'unknown',
] as const;
export type MovieReleaseType = (typeof MOVIE_RELEASE_TYPES)[number];

export const TV_RELEASE_TYPES = [
  'series_premiere',
  'season_premiere',
  'episode_air',
  'finale',
  'streaming',
  'unknown',
] as const;
export type TvReleaseType = (typeof TV_RELEASE_TYPES)[number];

export const RELEASE_TYPES = [...MOVIE_RELEASE_TYPES, ...TV_RELEASE_TYPES] as const;
export type ReleaseType = MovieReleaseType | TvReleaseType;

// --- decisions -------------------------------------------------------------
/**
 * What a discovery template decided about a title.
 *
 * `needs_review` is not a failure. It is the honest answer whenever the engine
 * declined to act on its own — an ambiguous identity, a blocked category, or an
 * auto-add limit already spent — and it exists so those titles are never
 * silently dropped.
 */
export const DISCOVERY_DECISIONS = [
  'auto_monitor',
  'notify',
  'ignore',
  'needs_review',
  /*
   * Outcomes about what ALREADY EXISTS here, rather than about the title itself.
   *
   * These are separated from `needs_review` because they are answered
   * differently. "We nearly acted and stopped" sends somebody to the inbox to
   * decide; "this is already monitored" needs nobody at all, and burying it in
   * the review queue would train people to ignore that queue.
   */
  /** A watchlist entry and an acquisition rule both already exist. Nothing to do. */
  'already_monitored',
  /** In the library, but nothing is watching for more of it. */
  'exists_not_monitored',
  /** Half set up — an entry with no rule, or a rule with no entry. Offer to finish it. */
  'exists_monitoring_incomplete',
  /**
   * A new series whose premiere has already happened.
   *
   * Not `ignore`: the title is exactly what the template is looking for, and the
   * only thing wrong with it is that automating it would import something old.
   * It is shown so a person can add it deliberately.
   */
  'review_past_release',
] as const;
export type DiscoveryDecision = (typeof DISCOVERY_DECISIONS)[number];

/** Decisions that mean the title is represented here already. */
export const EXISTING_DECISIONS = [
  'already_monitored',
  'exists_not_monitored',
  'exists_monitoring_incomplete',
] as const;

/** Where a discovered title currently sits. */
export const DISCOVERY_STATUSES = [
  'new',
  'evaluated',
  'monitored',
  'notified',
  'ignored',
  'needs_review',
  /** Represented in UltraTorrent already; discovery made no changes. */
  'exists',
  /** A past-premiere title held for a person to decide about. */
  'past_release',
] as const;
export type DiscoveryStatus = (typeof DISCOVERY_STATUSES)[number];

/**
 * How much the merged identity is trusted.
 *
 * `ambiguous` means two providers cannot be reconciled — the same title and year
 * pointing at different works. Such a title is NEVER auto-monitored however well
 * it scores on every other axis: a wrong id propagates into dedup and every
 * downstream lookup, while an unmonitored title merely waits for a person.
 */
export const DISCOVERY_IDENTITY_STATUSES = ['resolved', 'ambiguous', 'conflicted'] as const;
export type DiscoveryIdentityStatus = (typeof DISCOVERY_IDENTITY_STATUSES)[number];

// --- category policy -------------------------------------------------------
/**
 * How a title's categories are compared with the template's policy.
 *
 * - `ANY`     — one qualifying category is enough.
 * - `ALL`     — every category the title carries must qualify.
 * - `PRIMARY` — only the provider's first/primary category is considered.
 *
 * None of these can override a blocked category: exclusion is evaluated before
 * the mode is consulted at all.
 */
export const CATEGORY_MATCH_MODES = ['ANY', 'ALL', 'PRIMARY'] as const;
export type CategoryMatchMode = (typeof CATEGORY_MATCH_MODES)[number];

// --- providers -------------------------------------------------------------
/**
 * What a discovery provider can answer. A provider declares only what it
 * genuinely supports; the registry routes each query to the providers that
 * claim the matching capability rather than calling every provider and
 * discarding empty replies.
 */
export const DISCOVERY_CAPABILITIES = [
  'upcoming_movies',
  'upcoming_series',
  'returning_series',
  'upcoming_seasons',
  'upcoming_episodes',
  'trending',
  'popular',
  'details',
] as const;
export type DiscoveryCapability = (typeof DISCOVERY_CAPABILITIES)[number];

// --- path templates --------------------------------------------------------
/**
 * The only tokens a target-path template may contain.
 *
 * An allow-list, not an escape mechanism: everything else is rejected before a
 * path is rendered. There is deliberately **no `{library_path}`** — a generated
 * rule is `managed_intake`, so the destination follows from its Storage Profile
 * and the intake pipeline organises into the library afterwards. A template that
 * spelled the library path would be pre-creating folders the organiser may never
 * use, and inverting the pipeline it is supposed to feed.
 *
 * There is also no `{intake_path}`: the staging root is not the template's to
 * choose either. It comes from the profile, and the template describes only the
 * leaf beneath it.
 */
export const PATH_TEMPLATE_TOKENS = [
  'title',
  'tvshow',
  'movie',
  'year',
  'season',
  'season_number',
] as const;
export type PathTemplateToken = (typeof PATH_TEMPLATE_TOKENS)[number];

/**
 * A zeroed counter for every decision, built from the vocabulary itself.
 *
 * Spelled out by hand in two files, this needed editing in both every time a
 * decision was added — and a missed one is a `NaN` in a report rather than an
 * error, so it would ship.
 */
export function zeroDecisionCounts(): Record<DiscoveryDecision | 'not_applicable', number> {
  const out = { not_applicable: 0 } as Record<DiscoveryDecision | 'not_applicable', number>;
  for (const d of DISCOVERY_DECISIONS) out[d] = 0;
  return out;
}
