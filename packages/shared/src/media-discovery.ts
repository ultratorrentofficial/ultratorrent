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
export const DISCOVERY_DECISIONS = ['auto_monitor', 'notify', 'ignore', 'needs_review'] as const;
export type DiscoveryDecision = (typeof DISCOVERY_DECISIONS)[number];

/** Where a discovered title currently sits. */
export const DISCOVERY_STATUSES = [
  'new',
  'evaluated',
  'monitored',
  'notified',
  'ignored',
  'needs_review',
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
