/**
 * Finding codes — the stable machine vocabulary of Media Intelligence.
 *
 * Kept apart from the DTOs on purpose. A code is an identity, not a message: it
 * is what the derived projection stores, what a future Attention Center filters
 * on, what an i18n key is built from, and what a CAMA action is wired to. Prose
 * lives in the locale files and is rendered from `code + evidence` at display
 * time, so a wording change never rewrites stored state and a Spanish reader
 * never sees an English sentence that was persisted years ago.
 *
 * Renaming a code is therefore a breaking change. Adding one is cheap.
 *
 * The default `domain` and `severity` recorded here are the *classification* of
 * the finding, not a policy decision about the media. Two rules govern severity
 * and both come straight from the Phase 1 brief:
 *
 *   - A **failure** is a health problem: an aired episode that is missing, an
 *     intake that failed, an identity that cannot be resolved.
 *   - A **preference** is not. Missing optional subtitles, a 1080p file when a
 *     2160p release exists, media nobody has watched in two years, a torrent
 *     that is no longer seeding — none of these are defects until an explicit
 *     policy says so, and no such policy exists in Phase 1. They are recorded
 *     as `info`/`opportunity` so the facts are visible without pretending the
 *     library is broken.
 */

import type { MediaFindingSeverity, MediaIntelligenceDomain } from './media-intelligence.js';

/**
 * Every finding Phase 1 can produce.
 *
 * Deliberately short. A code is added only when the evaluator can prove it from
 * stored facts — a finding that cannot be evidenced is worse than none, because
 * it teaches operators to distrust the whole surface.
 */
export const MEDIA_FINDING_CODES = {
  /** No usable identity: nothing matched and no external id is recorded. */
  IDENTITY_UNRESOLVED: 'IDENTITY_UNRESOLVED',
  /** Two library rows claim the same external id. Reported, never auto-merged. */
  IDENTITY_EXTERNAL_ID_CONFLICT: 'IDENTITY_EXTERNAL_ID_CONFLICT',
  /** Aired, in-scope episodes are absent from the library. */
  EPISODES_MISSING: 'EPISODES_MISSING',
  /** One or more intake jobs ended in `failed`. */
  INTAKE_FAILED: 'INTAKE_FAILED',
  /** Intake stopped and asked for a person (`quarantined`). */
  INTAKE_QUARANTINED: 'INTAKE_QUARANTINED',
  /** Duplicate detection has an open group covering this media. */
  DUPLICATE_MEDIA_PRESENT: 'DUPLICATE_MEDIA_PRESENT',
  /** Never successfully enriched — `MediaMetadata.providerName` is null. */
  METADATA_INCOMPLETE: 'METADATA_INCOMPLETE',
  /** Missing the baseline artwork the Media Manager already defines. */
  ARTWORK_INCOMPLETE: 'ARTWORK_INCOMPLETE',
  /** Factual coverage gap. Informational: no subtitle policy exists in Phase 1. */
  SUBTITLE_COVERAGE_INCOMPLETE: 'SUBTITLE_COVERAGE_INCOMPLETE',
  /**
   * The file satisfies a rung of the operator's own ladder, but not the top
   * one. An OPPORTUNITY, never a defect: they configured that fallback
   * themselves, and nothing here has asked an indexer whether a better
   * release can actually be obtained.
   */
  QUALITY_UPGRADE_POTENTIAL: 'QUALITY_UPGRADE_POTENTIAL',
  /** Measured quality contradicts every rung of the configured ladder. */
  QUALITY_BELOW_PREFERENCE: 'QUALITY_BELOW_PREFERENCE',
  /** Monitored, but its acquisition rule is disabled or unusable. */
  ACQUISITION_NOT_READY: 'ACQUISITION_NOT_READY',
  /** Searches keep failing — the indexers could not answer, repeatedly. */
  ACQUISITION_SEARCH_FAILING: 'ACQUISITION_SEARCH_FAILING',
  /** A backfill job is present but has made no progress. */
  BACKFILL_STALLED: 'BACKFILL_STALLED',
  /** An associated torrent is in an error state. */
  TORRENT_ERROR: 'TORRENT_ERROR',
  /** No mediainfo measurement exists, so quality cannot be judged at all. */
  MEDIA_TECHNICAL_DATA_MISSING: 'MEDIA_TECHNICAL_DATA_MISSING',
  /** The library has never been scanned, so everything about it is a guess. */
  LIBRARY_NEVER_SCANNED: 'LIBRARY_NEVER_SCANNED',
} as const;

export type MediaFindingCode = keyof typeof MEDIA_FINDING_CODES;
export type MediaFindingCodeValue = (typeof MEDIA_FINDING_CODES)[MediaFindingCode];

/** Every code, for iteration in tests, filters and the overview aggregation. */
export const ALL_MEDIA_FINDING_CODES = Object.values(MEDIA_FINDING_CODES) as MediaFindingCodeValue[];

export interface MediaFindingDefinition {
  code: MediaFindingCodeValue;
  domain: MediaIntelligenceDomain;
  severity: MediaFindingSeverity;
  /**
   * Whether an existing capability can act on this. Phase 1 only *points* at
   * capabilities that already exist — it introduces no actions of its own.
   */
  actionCapabilityIds?: string[];
}

/**
 * Classification for each code.
 *
 * `actionCapabilityIds` reference CAMA ids that are already registered by their
 * owning modules. Codes whose natural action does not exist yet (missing
 * episodes, intake retry) carry none rather than a dangling id — an action the
 * catalogue cannot resolve would render as a dead control.
 */
export const MEDIA_FINDING_DEFINITIONS: Readonly<Record<MediaFindingCodeValue, MediaFindingDefinition>> = {
  [MEDIA_FINDING_CODES.IDENTITY_UNRESOLVED]: {
    code: MEDIA_FINDING_CODES.IDENTITY_UNRESOLVED,
    domain: 'identity',
    severity: 'warning',
  },
  [MEDIA_FINDING_CODES.IDENTITY_EXTERNAL_ID_CONFLICT]: {
    code: MEDIA_FINDING_CODES.IDENTITY_EXTERNAL_ID_CONFLICT,
    domain: 'identity',
    // Two works wearing one id corrupts dedup, metadata and every downstream
    // lookup, and only a person can say which one is right.
    severity: 'error',
  },
  [MEDIA_FINDING_CODES.EPISODES_MISSING]: {
    code: MEDIA_FINDING_CODES.EPISODES_MISSING,
    domain: 'completeness',
    severity: 'warning',
  },
  [MEDIA_FINDING_CODES.INTAKE_FAILED]: {
    code: MEDIA_FINDING_CODES.INTAKE_FAILED,
    domain: 'intake',
    severity: 'error',
  },
  [MEDIA_FINDING_CODES.INTAKE_QUARANTINED]: {
    code: MEDIA_FINDING_CODES.INTAKE_QUARANTINED,
    domain: 'intake',
    severity: 'warning',
  },
  [MEDIA_FINDING_CODES.DUPLICATE_MEDIA_PRESENT]: {
    code: MEDIA_FINDING_CODES.DUPLICATE_MEDIA_PRESENT,
    // Filed under storage, not library: duplicates cost space and want review,
    // they do not mean the media is broken.
    domain: 'storage',
    severity: 'warning',
    actionCapabilityIds: ['duplicates.ignore'],
  },
  [MEDIA_FINDING_CODES.QUALITY_UPGRADE_POTENTIAL]: {
    code: MEDIA_FINDING_CODES.QUALITY_UPGRADE_POTENTIAL,
    // Filed under `technical`: the subject is the media's own quality, and
    // acquisition merely supplies the yardstick it is measured against.
    domain: 'technical',
    /*
     * `opportunity`, which floors to HEALTHY. This file states the rule
     * directly — "a 1080p file when a 2160p release exists" is a preference,
     * not a defect — and a perfectly playable episode must never rank
     * alongside a failed intake or missing media.
     *
     * No `actionCapabilityIds`: CAMA registers no acquisition-search and no
     * re-probe capability, and a dangling id renders as a dead control.
     */
    severity: 'opportunity',
  },
  [MEDIA_FINDING_CODES.QUALITY_BELOW_PREFERENCE]: {
    code: MEDIA_FINDING_CODES.QUALITY_BELOW_PREFERENCE,
    domain: 'technical',
    // Warning, not error: the media plays. It simply satisfies nothing the
    // operator asked for, which is worth their attention and no more.
    severity: 'warning',
  },
  [MEDIA_FINDING_CODES.METADATA_INCOMPLETE]: {
    code: MEDIA_FINDING_CODES.METADATA_INCOMPLETE,
    domain: 'metadata',
    severity: 'info',
    actionCapabilityIds: ['media.metadata.refresh'],
  },
  [MEDIA_FINDING_CODES.ARTWORK_INCOMPLETE]: {
    code: MEDIA_FINDING_CODES.ARTWORK_INCOMPLETE,
    domain: 'artwork',
    severity: 'info',
  },
  [MEDIA_FINDING_CODES.SUBTITLE_COVERAGE_INCOMPLETE]: {
    code: MEDIA_FINDING_CODES.SUBTITLE_COVERAGE_INCOMPLETE,
    domain: 'subtitles',
    // Informational by design: wanting a language is a preference, and Phase 1
    // owns no subtitle policy to violate.
    severity: 'info',
  },
  [MEDIA_FINDING_CODES.ACQUISITION_NOT_READY]: {
    code: MEDIA_FINDING_CODES.ACQUISITION_NOT_READY,
    domain: 'acquisition',
    severity: 'warning',
  },
  [MEDIA_FINDING_CODES.ACQUISITION_SEARCH_FAILING]: {
    code: MEDIA_FINDING_CODES.ACQUISITION_SEARCH_FAILING,
    domain: 'acquisition',
    severity: 'warning',
  },
  [MEDIA_FINDING_CODES.BACKFILL_STALLED]: {
    code: MEDIA_FINDING_CODES.BACKFILL_STALLED,
    domain: 'acquisition',
    severity: 'warning',
  },
  [MEDIA_FINDING_CODES.TORRENT_ERROR]: {
    code: MEDIA_FINDING_CODES.TORRENT_ERROR,
    domain: 'torrent',
    severity: 'warning',
  },
  [MEDIA_FINDING_CODES.MEDIA_TECHNICAL_DATA_MISSING]: {
    code: MEDIA_FINDING_CODES.MEDIA_TECHNICAL_DATA_MISSING,
    domain: 'technical',
    // Informational: an unprobed file is unmeasured, not defective. The backfill
    // probes it in the background on its own schedule.
    severity: 'info',
  },
  [MEDIA_FINDING_CODES.LIBRARY_NEVER_SCANNED]: {
    code: MEDIA_FINDING_CODES.LIBRARY_NEVER_SCANNED,
    domain: 'library',
    severity: 'info',
  },
};

/**
 * Severities that count against health.
 *
 * `info` and `opportunity` are deliberately excluded: they are things worth
 * seeing, not things that are wrong. This is the single place that distinction
 * is encoded, so a new informational code can never silently make a healthy
 * library look degraded.
 */
export const HEALTH_AFFECTING_SEVERITIES: readonly MediaFindingSeverity[] = [
  'warning',
  'error',
  'critical',
] as const;
