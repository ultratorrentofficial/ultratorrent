/**
 * Quality compliance — the Phase 2 vocabulary.
 *
 * Phase 1 answers "what is the state of this media". Phase 2 answers "does what
 * I own satisfy the quality I actually asked for, and could a better release
 * exist within my own preferences". Both remain observational: this file
 * describes conclusions, never a second place to configure what 'good' means.
 *
 * **There is exactly one operator preference vocabulary, and it is not here.**
 * The acquisition ladder (`AcquisitionMatchCandidate`, a rule's
 * `RssRuleMatchCandidate` rows, or a `MediaAcquisitionProfile` tier) already
 * states what the operator wants, and `AcquisitionMatchPreferenceService`
 * already decides which of those applies. These types only *mirror* a resolved
 * ladder so a pure evaluator can compare measured file facts against it. A
 * second quality-profile model would let Acquisition say 1080p while
 * Intelligence says 2160p, which is precisely the contradiction this design
 * exists to prevent.
 */

/* ------------------------------------------------------------- provenance */

/**
 * How confidently a quality fact is known.
 *
 * Deliberately parallel to `MediaFile.techSource` rather than a new scale:
 * `measured` is a mediainfo probe, `inferred` is a filename guess, `unknown` is
 * that nobody has established it. The distinction is load-bearing — a file
 * whose codec was guessed from its name must never satisfy a codec
 * requirement, and a file nobody measured must never *fail* one.
 */
export const MEDIA_QUALITY_PROVENANCES = ['measured', 'inferred', 'unknown'] as const;
export type MediaQualityProvenance = (typeof MEDIA_QUALITY_PROVENANCES)[number];

/* --------------------------------------------------------- owned quality */

/**
 * The normalized quality of media that is already on disk.
 *
 * A value object, not a stored entity: assembled on demand from `MediaFile`
 * columns the Media Manager owns. Every field is nullable and null always means
 * *unknown*, never a zero or a negative — `hdr: null` is "nobody measured
 * colour", which is a different claim from `hdr: false` ("measured, and it is
 * SDR").
 *
 * Shaped so a later phase can normalize a *search candidate* into the same
 * type and compare the two without rewriting the evaluator.
 */
export interface NormalizedMediaQuality {
  /** Weakest provenance across the populated dimensions. */
  provenance: MediaQualityProvenance;

  /** `sd | 480p | 576p | 720p | 1080p | 1440p | 2160p | 4320p`, from pixels. */
  resolutionClass: string | null;
  /** Comparable rank for the class. Null whenever the class is unknown. */
  resolutionOrdinal: number | null;
  width: number | null;
  height: number | null;

  /** Normalized to the tokens acquisition speaks (`x265`, `x264`, `av1`, …). */
  videoCodec: string | null;
  videoBitDepth: number | null;

  /**
   * True only when colour was actually measured and reported HDR; false only
   * when colour was measured and reported none. Null when the probe never
   * extracted colour at all — which, on this codebase's older probe rows, is
   * common and must not be read as SDR.
   */
  hdr: boolean | null;
  hdrFormat: string | null;

  audioCodec: string | null;
  audioChannels: number | null;

  bitrateKbps: number | null;
  frameRate: number | null;
  durationSec: number | null;
  container: string | null;
  sizeBytes: number | null;
}

/* ------------------------------------------------------ preference ladder */

/** Where the effective ladder came from. Mirrors the acquisition cascade. */
export const MEDIA_PREFERENCE_SOURCES = [
  /** The global ordered Auto-Download ladder — the primary source. */
  'global_ladder',
  /** The show's own RSS rule candidates (used when the global ladder is empty). */
  'linked_rule',
  /** Per-media-type Auto-Download profiles, ranked into tiers. */
  'acquisition_profile',
  /** Nothing is configured anywhere. */
  'none',
] as const;
export type MediaPreferenceSource = (typeof MEDIA_PREFERENCE_SOURCES)[number];

/**
 * One rung of the effective ladder, reduced to what owned media can be judged
 * against. A mirror of the acquisition candidate, never a replacement for it.
 */
export interface NormalizedPreferenceRung {
  /** The acquisition candidate's own id, so the UI can name the real rung. */
  id: string;
  name: string;
  /** Position in the effective ladder. 0 is the most preferred. */
  rung: number;
  resolution: string | null;
  codec: string | null;
  source: string | null;
  /** Free-text `qualityRules.quality`; a release-name test, never measurable. */
  quality: string | null;
  requiredTerms: string[];
  excludedTerms: string[];
  maxBytes: number | null;
  minBytes: number | null;
}

export interface NormalizedPreferenceLadder {
  source: MediaPreferenceSource;
  /** Human label for the source, e.g. the profile or rule name. */
  sourceLabel: string | null;
  rungs: NormalizedPreferenceRung[];
}

/* --------------------------------------------------------- dimension math */

/**
 * The verdict for one dimension of one rung.
 *
 * `not_evaluable` is the whole point of this enum. A rung asking for `WEB-DL`
 * or a release group describes a *release name*, and a renamed file on disk
 * carries no trace of either — so the honest answer is neither pass nor fail.
 * Collapsing it into a fail would invent defects; collapsing it into a pass
 * would invent compliance.
 */
export const MEDIA_QUALITY_DIMENSION_RESULTS = ['pass', 'fail', 'not_evaluable'] as const;
export type MediaQualityDimensionResult = (typeof MEDIA_QUALITY_DIMENSION_RESULTS)[number];

/** The dimensions a rung can constrain. */
export const MEDIA_QUALITY_DIMENSIONS = [
  'resolution',
  'codec',
  'source',
  'quality',
  'hdr',
  'audio',
  'bitDepth',
  'size',
  'terms',
] as const;
export type MediaQualityDimension = (typeof MEDIA_QUALITY_DIMENSIONS)[number];

export interface MediaQualityDimensionVerdict {
  dimension: MediaQualityDimension;
  result: MediaQualityDimensionResult;
  /** What the rung asked for, as the operator wrote it. */
  required: string | null;
  /** What the file actually has, or null when unknown. */
  actual: string | null;
  /** Why it could not be judged. Only set for `not_evaluable`. */
  reason: MediaQualityNotEvaluableReason | null;
  /**
   * The raw numeric limit behind a size constraint, so a consumer can format
   * it as bytes rather than re-parsing a human string.
   */
  numericRequired?: number | null;
}

/** Why a dimension could not be judged from owned media. */
export const MEDIA_QUALITY_NOT_EVALUABLE_REASONS = [
  /** The file was never measured for this dimension. */
  'not_measured',
  /** The requirement describes a release name, which a renamed file has lost. */
  'release_name_only',
  /** The term is a release group; nothing on disk records it. */
  'release_group',
  /** A free-text quality phrase matched against a title we no longer have. */
  'free_text',
] as const;
export type MediaQualityNotEvaluableReason = (typeof MEDIA_QUALITY_NOT_EVALUABLE_REASONS)[number];

/* ------------------------------------------------------------- compliance */

/**
 * The compliance verdict.
 *
 * `preferred` is the top rung; `acceptable` is any lower rung the operator
 * themselves configured as a fallback — explicitly NOT a defect. `below_preference`
 * means every rung was confidently failed. `unknown` means no ladder exists, or
 * nothing could be judged.
 */
export const MEDIA_QUALITY_STATUSES = [
  'preferred',
  'acceptable',
  'below_preference',
  'unknown',
] as const;
export type MediaQualityStatus = (typeof MEDIA_QUALITY_STATUSES)[number];

/** Why compliance could not be determined. */
export const MEDIA_QUALITY_UNKNOWN_REASONS = [
  /** No ladder applies — nothing is configured for this media. */
  'no_acquisition_preferences',
  /** A ladder exists but nothing about the file could be measured. */
  'no_measured_quality',
  /** Every rung's constraints are release-name-only for this media. */
  'not_evaluable_from_owned_media',
] as const;
export type MediaQualityUnknownReason = (typeof MEDIA_QUALITY_UNKNOWN_REASONS)[number];

export interface MediaQualityCompliance {
  status: MediaQualityStatus;
  /** The best rung the file satisfies. Null when it satisfies none. */
  matchedRung: number | null;
  matchedRungName: string | null;
  /** Always 0 when a ladder exists — the operator's first choice. */
  preferredRung: number | null;
  totalRungs: number;
  /**
   * A better rung exists in the operator's OWN ladder that this file does not
   * satisfy. This is potential, not availability: no indexer has been asked
   * whether such a release can actually be obtained.
   */
  upgradePotential: boolean;
  /** Per-dimension verdicts for the matched rung, or for rung 0 if none matched. */
  dimensions: MediaQualityDimensionVerdict[];
  /** Short machine reasons explaining the status. */
  reasons: string[];
  unknownReason: MediaQualityUnknownReason | null;
  preferenceSource: MediaPreferenceSource;
  preferenceSourceLabel: string | null;
}

/* ------------------------------------------------------------- aggregates */

/** Per-status counts for a series or season. Outliers must stay visible. */
export interface MediaQualityAggregate {
  evaluated: number;
  preferred: number;
  acceptable: number;
  belowPreference: number;
  unknown: number;
  upgradePotential: number;
  /** The most common resolution class among measured files, for a headline. */
  dominantResolution: string | null;
  /** The worst measured resolution class present — the outlier a mean hides. */
  worstResolution: string | null;
  /** True when more than one resolution class is present. */
  mixed: boolean;
}

/**
 * The quality block on a unified media state.
 *
 * A correlation of the `technical` and `acquisition` sections rather than a
 * thirteenth fact domain: it introduces no new source of truth, and its
 * findings are filed under the existing `technical` domain.
 */
export interface MediaQualityFacts {
  /** The representative owned quality (a movie's file, or a series' dominant). */
  owned: NormalizedMediaQuality | null;
  ladder: NormalizedPreferenceLadder;
  compliance: MediaQualityCompliance;
  /** Present for series/season entities only. */
  aggregate: MediaQualityAggregate | null;
  /** Measured-vs-total, so an operator can judge how much to trust the verdict. */
  measuredFileCount: number;
  totalFileCount: number;
}
