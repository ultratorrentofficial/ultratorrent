/**
 * Media Intelligence — the vocabulary for derived media conclusions.
 *
 * The one rule this file exists to enforce: **Media Intelligence owns
 * conclusions, not source facts.** Every field here is either a conclusion
 * (health, findings) or a *projection* of a fact that some other domain owns —
 * Media Manager owns files and technical data, Media Acquisition owns wanted
 * episodes, Media Intake owns intake jobs, the torrent subsystem owns torrent
 * state, Media Server Analytics owns playback. Nothing here is authoritative,
 * and everything here is rebuildable from those domains.
 *
 * Two conventions are load-bearing and easy to get wrong:
 *
 * 1. **UNKNOWN is not NONE.** "No technical probe has run" and "this file has no
 *    audio" are different claims, and collapsing the first into `0`/`false`/`[]`
 *    is how a projection starts lying. Every section therefore carries a
 *    {@link MediaFactStatus} plus a machine-readable {@link MediaUnknownReason},
 *    and its value fields are nullable rather than zero-defaulted.
 * 2. **Facts are sampled at different times.** A library scan, a mediainfo probe
 *    and a playback aggregate are observed hours apart, so each section carries
 *    its own `observedAt`. Presenting them as one atomic snapshot would be the
 *    most convincing kind of wrong.
 *
 * Identity deliberately reuses `media-identity.ts` (`canonicalizeTitle`) and
 * languages reuse `media-language.ts` (`canonicalLanguage`). There is no second
 * identity system here.
 */

import type { MediaFindingCodeValue } from './media-intelligence-codes.js';

/* ------------------------------------------------------------------ entities */

/**
 * What Media Intelligence can evaluate.
 *
 * These map onto what the repository actually stores: a `movie` and an
 * `episode` are both `MediaItem` rows, a `series` is a `MediaShow` row, and a
 * `season` has no row at all — it is `(showId, seasonNumber)`, so its id is a
 * composite string. See {@link MediaEntityRef}.
 */
export const MEDIA_INTELLIGENCE_ENTITY_TYPES = ['movie', 'series', 'season', 'episode'] as const;
export type MediaIntelligenceEntityType = (typeof MEDIA_INTELLIGENCE_ENTITY_TYPES)[number];

/**
 * A stable handle for an evaluated entity.
 *
 * `entityId` is the source domain's own id — `MediaItem.id` for a movie or
 * episode, `MediaShow.id` for a series, and `${showId}:${seasonNumber}` for a
 * season, which owns no row. Media Intelligence mints no ids of its own.
 */
export interface MediaEntityRef {
  entityType: MediaIntelligenceEntityType;
  entityId: string;
}

/* -------------------------------------------------------------- fact status */

/**
 * Whether a section could be answered at all.
 *
 * `partial` is the honest answer when some contributing rows were resolvable and
 * others were not — a series whose episodes are half-probed, for instance.
 */
export const MEDIA_FACT_STATUSES = ['known', 'partial', 'unknown'] as const;
export type MediaFactStatus = (typeof MEDIA_FACT_STATUSES)[number];

/**
 * Why a section is not fully known. Machine-readable so the UI can explain it
 * without string-matching prose, and so a future Attention Center can filter on
 * "everything blocked on an unresolved mapping".
 */
export const MEDIA_UNKNOWN_REASONS = [
  /** No mediainfo probe has run for these files yet. */
  'not_probed',
  /** A probe ran and permanently gave up (`MediaFile.probeError`). */
  'probe_failed',
  /** The library has never been scanned, so nothing has been observed. */
  'not_scanned',
  /** No safe mapping exists from this entity to the other domain's rows. */
  'no_mapping',
  /** The domain keeps a derived aggregate and has not computed one for this entity. */
  'no_aggregate',
  /** An aggregate exists but was computed against different inputs/settings. */
  'stale',
  /** This entity is not monitored for acquisition, so acquisition state is N/A. */
  'not_monitored',
  /** Nothing links this media to a torrent (it did not arrive through intake). */
  'no_torrent_link',
  /** The torrent engine could not be reached, so live state is genuinely unknown. */
  'engine_unreachable',
  /** The section does not apply to this entity type (e.g. episode counts on a movie). */
  'not_applicable',
] as const;
export type MediaUnknownReason = (typeof MEDIA_UNKNOWN_REASONS)[number];

/**
 * Provenance carried by every section.
 *
 * `source` names the owning domain, never Media Intelligence — the point is that
 * a reader can always see which system is actually responsible for the number.
 * `observedAt` is when the SOURCE observed it, not when we assembled the view;
 * null means that source records no timestamp for the fact.
 */
export interface MediaFactProvenance {
  status: MediaFactStatus;
  source: string;
  observedAt: string | null;
  unknownReason?: MediaUnknownReason;
}

/* ------------------------------------------------------------------ sections */

/** Canonical identity, projected from the owning rows. Never re-derived here. */
export interface MediaIdentityFacts extends MediaFactProvenance {
  title: string | null;
  /** Comparison form from `canonicalizeTitle`, for display of what was matched. */
  normalizedTitle: string | null;
  year: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  /** provider → external id, exactly as stored. */
  externalIds: Record<string, string>;
  /**
   * `unmatched | matched | manual`, verbatim from `MediaItem.matchStatus`.
   *
   * Note that `unmatched` does NOT mean "no identity": the scanner writes title,
   * year, season and episode while leaving this at its default, which is what
   * every intake import looks like. Treat a 0 confidence as unknown, not zero.
   */
  matchStatus: string | null;
  /** Null when never scored — distinct from a genuine 0. */
  confidence: number | null;
  /** Two library rows claiming the same external id. Evidence, never a merge. */
  conflictingExternalIds: boolean;
}

/** Where the media physically lives, and how fresh that observation is. */
export interface MediaLibraryFacts extends MediaFactProvenance {
  present: boolean | null;
  libraryId: string | null;
  libraryName: string | null;
  libraryKind: string | null;
  /** Redacted for callers without path visibility; null when withheld. */
  path: string | null;
  fileCount: number | null;
  episodeCount: number | null;
  seasonCount: number | null;
  totalBytes: number | null;
  duplicateGroupCount: number | null;
  duplicateReclaimableBytes: number | null;
  /** `MediaLibrary.lastScanAt` — the only scan-freshness signal that exists. */
  lastScanAt: string | null;
}

/**
 * Episode completeness, reused wholesale from Missing Episodes.
 *
 * Only meaningful for `series`/`season`. For a movie, completeness is presence,
 * which {@link MediaLibraryFacts.present} already answers — inventing episode
 * semantics for films is exactly the TV-shaped thinking to avoid.
 */
export interface MediaCompletenessFacts extends MediaFactProvenance {
  expected: number | null;
  owned: number | null;
  missing: number | null;
  unaired: number | null;
  ignored: number | null;
  /** Episodes deliberately outside the operator's requested scope. */
  excludedFromScope: number | null;
  /** owned / (expected - unaired - ignored), 0..100; null when not computable. */
  completionPercent: number | null;
  /** Cached airing status (`ended`, `continuing`, …) when known. */
  showStatus: string | null;
}

/**
 * One measured technical profile.
 *
 * Phase 2 (Quality Compliance) compares this against the auto-download
 * preference ladder, so it must carry measured values only — never a guess
 * recovered from a filename. `declared` keeps the filename-derived tokens
 * visible without letting them masquerade as measurement.
 */
export interface MediaTechnicalProfile {
  width: number | null;
  height: number | null;
  /** Banded from height by the probe (`2160p|1080p|720p|480p|sd`). */
  resolution: string | null;
  videoCodec: string | null;
  bitrateKbps: number | null;
  durationSec: number | null;
  frameRate: number | null;
  videoBitDepth: number | null;
  hdrFormat: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  container: string | null;
  sizeBytes: number | null;
}

export interface MediaTechnicalFacts extends MediaFactProvenance {
  /** Files whose values were measured by mediainfo (`techSource === 'probe'`). */
  measuredFileCount: number | null;
  /** Files never probed — pending, not "no data". */
  unprobedFileCount: number | null;
  /** Files a probe permanently gave up on. */
  unmeasurableFileCount: number | null;
  /**
   * The representative measured profile. For a series this is the dominant one;
   * `distinctProfileCount` says how much variation it is hiding.
   */
  profile: MediaTechnicalProfile | null;
  distinctProfileCount: number | null;
  /**
   * Filename-derived tokens, kept strictly separate from measurement. Present
   * only as context; Phase 2 must never compare against these.
   */
  declared: { resolution: string | null; videoCodec: string | null; hdr: string | null } | null;
}

export interface MediaMetadataFacts extends MediaFactProvenance {
  /** Null provider means never successfully enriched — a load-bearing signal. */
  provider: string | null;
  hasOverview: boolean | null;
  hasGenres: boolean | null;
  year: number | null;
  runtimeMinutes: number | null;
  nfoPresent: boolean | null;
  /** Last write to the metadata row; not a fetch time — no fetch time exists. */
  updatedAt: string | null;
}

export interface MediaArtworkFacts extends MediaFactProvenance {
  posterPresent: boolean | null;
  fanartPresent: boolean | null;
  /** Artwork types present, e.g. `['poster','fanart','season_poster']`. */
  typesPresent: string[];
  /** Against the baseline the repository already defines (poster + fanart). */
  missingRequiredCount: number | null;
}

export interface MediaSubtitleFacts extends MediaFactProvenance {
  /** Canonical base languages across sidecars AND Subtitle Intelligence rows. */
  languages: string[];
  /** Items (episodes, or the movie) carrying at least one subtitle. */
  itemsWithSubtitles: number | null;
  itemsTotal: number | null;
  /**
   * Embedded/in-container tracks are not modelled anywhere in the repository, so
   * "no rows" cannot be reported as "no subtitles". This flag says so out loud.
   */
  embeddedTracksKnown: boolean;
}

export interface MediaAcquisitionFacts extends MediaFactProvenance {
  monitored: boolean | null;
  watchlistItemId: string | null;
  /** `backfill_and_monitor | backfill_only | monitor_new_only`, when recorded. */
  mode: string | null;
  watchlistStatus: string | null;
  ruleId: string | null;
  ruleEnabled: boolean | null;
  /** True when the add deliberately has no rule (Backfill-Only). */
  usesGlobalPreferences: boolean | null;
  searchesPending: number | null;
  searchesFailed: number | null;
  searchesNoResults: number | null;
  lastSearchAt: string | null;
  lastGrabAt: string | null;
  activeBackfillJobId: string | null;
}

export interface MediaIntakeFacts extends MediaFactProvenance {
  total: number | null;
  active: number | null;
  imported: number | null;
  failed: number | null;
  quarantined: number | null;
  lastIntakeAt: string | null;
  /** Bounded sample of unresolved failures, for explanation. */
  lastError: string | null;
}

/**
 * Torrent association.
 *
 * The only honest bridge is an intake job carrying both `mediaItemId` and
 * `torrentHash`, so media that was scanned in from disk has no association at
 * all — which is UNKNOWN, not "not seeding". Live state comes from the engine;
 * when the engine cannot be reached that too is UNKNOWN rather than zero.
 */
export interface MediaTorrentFacts extends MediaFactProvenance {
  associatedCount: number | null;
  seedingCount: number | null;
  erroredCount: number | null;
  /** Items linked to at least one torrent, out of the items considered. */
  linkedItemCount: number | null;
  consideredItemCount: number | null;
}

/**
 * Aggregate playback only.
 *
 * Deliberately no viewer names, IP addresses, devices, clients, GeoIP or
 * household evidence: the underlying watch-history rows carry all of those, so
 * this layer reads the derived per-item aggregate instead and never the history
 * table. `approximate` marks the cases where the underlying join is a title
 * match rather than an id.
 */
export interface MediaUsageFacts extends MediaFactProvenance {
  playCount: number | null;
  completedPlayCount: number | null;
  uniqueViewerCount: number | null;
  lastPlayedAt: string | null;
  totalPlaybackSeconds: number | null;
  /** True when derived through title matching or rolled up across episodes. */
  approximate: boolean;
}

export interface MediaStorageFacts extends MediaFactProvenance {
  totalBytes: number | null;
  fileCount: number | null;
  duplicateBytes: number | null;
  /** Proven by existing duplicate detection only — never a speculative estimate. */
  reclaimableBytes: number | null;
  storageProfileId: string | null;
  storageProfileName: string | null;
}

/* ------------------------------------------------------------------ findings */

export const MEDIA_FINDING_SEVERITIES = ['info', 'opportunity', 'warning', 'error', 'critical'] as const;
export type MediaFindingSeverity = (typeof MEDIA_FINDING_SEVERITIES)[number];

export const MEDIA_INTELLIGENCE_DOMAINS = [
  'identity',
  'library',
  'completeness',
  'technical',
  'metadata',
  'artwork',
  'subtitles',
  'acquisition',
  'intake',
  'torrent',
  'usage',
  'storage',
] as const;
export type MediaIntelligenceDomain = (typeof MEDIA_INTELLIGENCE_DOMAINS)[number];

/**
 * A derived, explainable conclusion.
 *
 * `code` is the stable machine identity — it is what a future Attention Center
 * filters on and what survives translation, so it must never carry prose. The
 * human sentence is rendered from the code plus `evidence` at presentation time
 * and is deliberately NOT persisted: storing English would make the store the
 * authority on wording in a product that ships two languages.
 *
 * `evidence` is bounded on purpose. A series missing forty episodes must not
 * carry forty rows into every list response; it carries a count and a sample.
 */
export interface MediaFinding {
  code: MediaFindingCodeValue;
  domain: MediaIntelligenceDomain;
  severity: MediaFindingSeverity;
  entityType: MediaIntelligenceEntityType;
  entityId: string;
  /** Bounded, machine-readable support for the conclusion. */
  evidence: Record<string, unknown>;
  /** The domain that supplied the underlying facts. */
  source: string;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  /** Whether an existing capability can act on it; Phase 1 only points. */
  actionable: boolean;
  /** CAMA capability ids, e.g. `media.metadata.refresh`. Never new actions. */
  actionCapabilityIds?: string[];
}

/* -------------------------------------------------------------------- health */

/**
 * Entity-level health.
 *
 * Distinct from the per-item hygiene score in the Media Manager's pure
 * `media-health-score.ts` (`healthy|attention|problem|unknown`), which this
 * layer consumes as one input rather than replacing. The extra tiers exist
 * because severity-aware aggregation needs to say "one failed intake is worse
 * than three cosmetic gaps" without arithmetic averaging them away.
 */
export const MEDIA_HEALTH_STATUSES = ['healthy', 'attention', 'degraded', 'critical', 'unknown'] as const;
export type MediaHealthStatus = (typeof MEDIA_HEALTH_STATUSES)[number];

/** Per-domain conclusion, so "why" is answerable without re-deriving anything. */
export interface MediaDomainHealth {
  domain: MediaIntelligenceDomain;
  status: MediaHealthStatus;
  findingCodes: MediaFindingCodeValue[];
}

export interface MediaHealthSummary {
  status: MediaHealthStatus;
  /**
   * Optional 0–100 hygiene score, carried through from the Media Manager's
   * existing scorer. The STATUS and findings are the product; the number is a
   * convenience for sorting and must never be the only thing shown.
   */
  score: number | null;
  domains: MediaDomainHealth[];
  /** Codes driving the overall status, worst first. Informational ones excluded. */
  reasons: MediaFindingCodeValue[];
}

/* ---------------------------------------------------------- unified state */

/** When each contributing domain last observed its half of the picture. */
export interface MediaFreshness {
  /** When this view was assembled — not when the facts were observed. */
  assembledAt: string;
  sections: Array<{ domain: MediaIntelligenceDomain; observedAt: string | null; status: MediaFactStatus }>;
}

/**
 * The complete derived view of one media entity.
 *
 * Every section is optional-by-status rather than optional-by-absence: a field
 * that could not be answered is present with `status: 'unknown'` and a reason,
 * because a missing key and a known-nothing are different answers.
 */
export interface UnifiedMediaState {
  entityType: MediaIntelligenceEntityType;
  entityId: string;
  identity: MediaIdentityFacts;
  library: MediaLibraryFacts;
  completeness: MediaCompletenessFacts;
  technical: MediaTechnicalFacts;
  metadata: MediaMetadataFacts;
  artwork: MediaArtworkFacts;
  subtitles: MediaSubtitleFacts;
  acquisition: MediaAcquisitionFacts;
  intake: MediaIntakeFacts;
  torrent: MediaTorrentFacts;
  usage: MediaUsageFacts;
  storage: MediaStorageFacts;
  health: MediaHealthSummary;
  findings: MediaFinding[];
  freshness: MediaFreshness;
}

/* ----------------------------------------------------------------- list DTOs */

/** One row of the Media Health list. Deliberately small — no section payloads. */
export interface MediaIntelligenceSummary {
  entityType: MediaIntelligenceEntityType;
  entityId: string;
  title: string;
  year: number | null;
  libraryId: string | null;
  libraryName: string | null;
  health: MediaHealthStatus;
  healthScore: number | null;
  findingCounts: Record<MediaFindingSeverity, number>;
  totalBytes: number | null;
  missingCount: number | null;
  lastPlayedAt: string | null;
  /** When the projection row was computed; stale rows must read as stale. */
  calculatedAt: string;
}

/** Aggregated counts for the Intelligence overview, generated from findings. */
export interface MediaIntelligenceOverview {
  analyzed: number;
  byHealth: Record<MediaHealthStatus, number>;
  /** Finding code → count, so the UI never hard-codes a category list. */
  byFindingCode: Array<{ code: MediaFindingCodeValue; domain: MediaIntelligenceDomain; severity: MediaFindingSeverity; count: number }>;
  /** Null until a projection has ever been built. */
  lastCalculatedAt: string | null;
  /** True while a rebuild is in flight, so the UI can say so rather than lie. */
  rebuilding: boolean;
}

export interface MediaIntelligenceListResult {
  items: MediaIntelligenceSummary[];
  total: number;
  page: number;
  pageSize: number;
}
