import type {
  MediaQualityAggregate,
  MediaQualityCompliance,
  MediaQualityDimension,
  MediaQualityDimensionVerdict,
  MediaQualityNotEvaluableReason,
  MediaQualityStatus,
  NormalizedMediaQuality,
  NormalizedPreferenceLadder,
  NormalizedPreferenceRung,
} from '@ultratorrent/shared';

import { codecEquivalent, compact } from '../../rss/match-engine';
import { RESOLUTION_CLASSES } from '../../media/cleanup/domain/resolution-class';

/**
 * Quality compliance — the pure, deterministic core of Phase 2.
 *
 * Answers one question: does the media already on disk satisfy a rung of the
 * operator's own acquisition ladder, and does a rung they prefer more exist?
 *
 * Three rules govern everything here, and every one of them is about refusing
 * to overclaim:
 *
 *  1. **Unknown is never failure.** A dimension nobody measured, and a
 *     requirement that describes a release name rather than a file, are both
 *     `not_evaluable`. A rung is failed only when a dimension was actually
 *     established and actually disagrees.
 *  2. **A fallback rung is not a defect.** The operator wrote those rungs
 *     themselves. Matching rung 3 of 4 is `acceptable`; it earns upgrade
 *     *potential*, not a health problem.
 *  3. **Order comes from the ladder, never from intuition.** 2160p is more
 *     pixels than 1080p — that is a fact. Whether it is *preferable* is
 *     policy, and the ladder is the only thing that states it.
 */

/** A rung matches when no evaluable dimension contradicts it. */
interface RungOutcome {
  rung: NormalizedPreferenceRung;
  matched: boolean;
  /** True when nothing on this rung could be judged at all. */
  blind: boolean;
  dimensions: MediaQualityDimensionVerdict[];
}

const verdict = (
  dimension: MediaQualityDimension,
  result: 'pass' | 'fail' | 'not_evaluable',
  required: string | null,
  actual: string | null,
  reason: MediaQualityNotEvaluableReason | null = null,
): MediaQualityDimensionVerdict => ({ dimension, result, required, actual, reason });

/**
 * Terms that map onto something we actually measure.
 *
 * Deliberately tiny. Every entry here is a claim that a measured column can
 * settle the term; anything absent falls through to `not_evaluable`, which is
 * the correct answer for the overwhelming majority of real terms (`WEB-DL`,
 * `AMZN`, `REPACK`, `x265-MeGusta`, …) because a renamed file on disk records
 * neither its source nor its release group anywhere in this schema.
 */
const BIT_DEPTH_TERMS: Record<string, number> = { '10bit': 10, '10 bit': 10, '8bit': 8, '8 bit': 8 };
const HDR_TERMS = new Set(['hdr', 'hdr10', 'hdr10+', 'dv', 'dolbyvision', 'dolby vision']);
const RESOLUTION_TERMS = new Set([...RESOLUTION_CLASSES, '4k', 'uhd']);
const CODEC_TERMS = new Set(['x264', 'h264', 'avc', 'x265', 'h265', 'hevc', 'av1', 'xvid', 'vp9']);

/** `4k`/`uhd` are the same tier as `2160p`; everything else is already a class. */
function resolutionTermToClass(term: string): string {
  const t = compact(term);
  return t === '4k' || t === 'uhd' ? '2160p' : t;
}

/**
 * Judge one required/excluded term against measured facts.
 *
 * Returns null when the term is not one we can settle — the caller turns that
 * into `not_evaluable` rather than guessing in either direction.
 */
function evaluateTerm(term: string, owned: NormalizedMediaQuality): boolean | null {
  const t = compact(term);

  if (t in BIT_DEPTH_TERMS || term.toLowerCase().trim() in BIT_DEPTH_TERMS) {
    const want = BIT_DEPTH_TERMS[t] ?? BIT_DEPTH_TERMS[term.toLowerCase().trim()];
    return owned.videoBitDepth == null ? null : owned.videoBitDepth === want;
  }
  if (HDR_TERMS.has(t)) {
    return owned.hdr == null ? null : owned.hdr;
  }
  if (RESOLUTION_TERMS.has(t)) {
    if (!owned.resolutionClass) return null;
    return compact(owned.resolutionClass) === resolutionTermToClass(term);
  }
  if (CODEC_TERMS.has(t)) {
    if (!owned.videoCodec) return null;
    return codecEquivalent(owned.videoCodec, term);
  }
  // A source, a release group, a scene tag, a free-text phrase: all describe
  // the release NAME. Nothing on disk preserves it after import and rename.
  return null;
}

/** Why a term could not be settled, for the explanation. */
function termReason(term: string, owned: NormalizedMediaQuality): MediaQualityNotEvaluableReason {
  const t = compact(term);
  if (t in BIT_DEPTH_TERMS || HDR_TERMS.has(t) || RESOLUTION_TERMS.has(t) || CODEC_TERMS.has(t)) {
    return 'not_measured';
  }
  // A group tag is conventionally `something-GROUP`; a bare word is a scene tag.
  if (/-[a-z0-9]+$/i.test(term.trim())) return 'release_group';
  void owned;
  return 'release_name_only';
}

/** Evaluate one rung against the owned file. */
function evaluateRung(rung: NormalizedPreferenceRung, owned: NormalizedMediaQuality): RungOutcome {
  const dims: MediaQualityDimensionVerdict[] = [];

  if (rung.resolution) {
    const want = resolutionTermToClass(rung.resolution);
    if (!owned.resolutionClass) {
      dims.push(verdict('resolution', 'not_evaluable', rung.resolution, null, 'not_measured'));
    } else {
      const ok = compact(owned.resolutionClass) === want;
      dims.push(verdict('resolution', ok ? 'pass' : 'fail', rung.resolution, owned.resolutionClass));
    }
  }

  if (rung.codec) {
    if (!owned.videoCodec) {
      dims.push(verdict('codec', 'not_evaluable', rung.codec, null, 'not_measured'));
    } else {
      const ok = codecEquivalent(owned.videoCodec, rung.codec);
      dims.push(verdict('codec', ok ? 'pass' : 'fail', rung.codec, owned.videoCodec));
    }
  }

  // Source survives in no column this schema owns once a file is renamed.
  if (rung.source) {
    dims.push(verdict('source', 'not_evaluable', rung.source, null, 'release_name_only'));
  }

  // `qualityRules.quality` is a substring test against a release title.
  if (rung.quality) {
    dims.push(verdict('quality', 'not_evaluable', rung.quality, null, 'free_text'));
  }

  for (const term of rung.requiredTerms) {
    const settled = evaluateTerm(term, owned);
    if (settled == null) {
      dims.push(verdict('terms', 'not_evaluable', `requires ${term}`, null, termReason(term, owned)));
    } else {
      dims.push(verdict('terms', settled ? 'pass' : 'fail', `requires ${term}`, describeFor(term, owned)));
    }
  }

  for (const term of rung.excludedTerms) {
    const settled = evaluateTerm(term, owned);
    if (settled == null) {
      dims.push(verdict('terms', 'not_evaluable', `excludes ${term}`, null, termReason(term, owned)));
    } else {
      // Present when the term evaluates true — which for an exclusion is a fail.
      dims.push(verdict('terms', settled ? 'fail' : 'pass', `excludes ${term}`, describeFor(term, owned)));
    }
  }

  // Size is a filesystem fact and always comparable when present.
  if (rung.maxBytes != null || rung.minBytes != null) {
    if (owned.sizeBytes == null) {
      dims.push(verdict('size', 'not_evaluable', sizeLabel(rung), null, 'not_measured'));
    } else {
      const overMax = rung.maxBytes != null && owned.sizeBytes > rung.maxBytes;
      const underMin = rung.minBytes != null && owned.sizeBytes < rung.minBytes;
      dims.push(
        verdict('size', overMax || underMin ? 'fail' : 'pass', sizeLabel(rung), String(owned.sizeBytes)),
      );
    }
  }

  const failed = dims.some((d) => d.result === 'fail');
  const anyPass = dims.some((d) => d.result === 'pass');
  return {
    rung,
    matched: !failed,
    // A rung with constraints, none of which could be judged, tells us nothing.
    blind: dims.length > 0 && !anyPass && !failed,
    dimensions: dims,
  };
}

function sizeLabel(rung: NormalizedPreferenceRung): string {
  if (rung.maxBytes != null && rung.minBytes != null) return `${rung.minBytes}–${rung.maxBytes} bytes`;
  if (rung.maxBytes != null) return `≤ ${rung.maxBytes} bytes`;
  return `≥ ${rung.minBytes} bytes`;
}

/** What the file actually shows for the dimension a term addresses. */
function describeFor(term: string, owned: NormalizedMediaQuality): string | null {
  const t = compact(term);
  if (t in BIT_DEPTH_TERMS) return owned.videoBitDepth == null ? null : `${owned.videoBitDepth}-bit`;
  if (HDR_TERMS.has(t)) return owned.hdr == null ? null : owned.hdr ? (owned.hdrFormat ?? 'HDR') : 'SDR';
  if (RESOLUTION_TERMS.has(t)) return owned.resolutionClass;
  if (CODEC_TERMS.has(t)) return owned.videoCodec;
  return null;
}

/**
 * Compare owned media against the effective ladder.
 *
 * Walks the ladder in the operator's own order and takes the FIRST rung that
 * is not contradicted — the same first-match-wins semantics acquisition uses
 * when it picks a release, so the two layers cannot disagree about which rung
 * a thing belongs to.
 */
export function evaluateQualityCompliance(
  owned: NormalizedMediaQuality | null,
  ladder: NormalizedPreferenceLadder,
): MediaQualityCompliance {
  const base = {
    matchedRung: null,
    matchedRungName: null,
    preferredRung: ladder.rungs.length ? 0 : null,
    totalRungs: ladder.rungs.length,
    upgradePotential: false,
    dimensions: [] as MediaQualityDimensionVerdict[],
    preferenceSource: ladder.source,
    preferenceSourceLabel: ladder.sourceLabel,
  };

  // No ladder: technical quality may be perfectly well known, but policy
  // compliance is undefined. Inventing a default ("1080p is fine") would be
  // this layer asserting a preference the operator never expressed.
  if (!ladder.rungs.length) {
    return {
      ...base,
      status: 'unknown',
      reasons: ['no_acquisition_preferences'],
      unknownReason: 'no_acquisition_preferences',
    };
  }

  if (!owned) {
    return {
      ...base,
      status: 'unknown',
      reasons: ['no_measured_quality'],
      unknownReason: 'no_measured_quality',
    };
  }

  const outcomes = ladder.rungs.map((r) => evaluateRung(r, owned));
  const firstMatch = outcomes.find((o) => o.matched && !o.blind);

  // Every rung was unjudgeable: the ladder asks only for things a file on disk
  // cannot answer (a source, a release group, a scene tag).
  if (!firstMatch && outcomes.every((o) => o.blind || o.dimensions.length === 0)) {
    return {
      ...base,
      status: 'unknown',
      dimensions: outcomes[0]?.dimensions ?? [],
      reasons: ['not_evaluable_from_owned_media'],
      unknownReason: 'not_evaluable_from_owned_media',
    };
  }

  if (!firstMatch) {
    return {
      ...base,
      status: 'below_preference',
      dimensions: outcomes[0]?.dimensions ?? [],
      reasons: ['no_rung_satisfied'],
      unknownReason: null,
    };
  }

  const index = firstMatch.rung.rung;
  const status: MediaQualityStatus = index === 0 ? 'preferred' : 'acceptable';
  return {
    ...base,
    status,
    matchedRung: index,
    matchedRungName: firstMatch.rung.name,
    // Potential, not availability: a better rung exists in the operator's own
    // ladder. Nothing here has asked an indexer whether it can be obtained.
    upgradePotential: index > 0,
    dimensions: firstMatch.dimensions,
    reasons: index === 0 ? ['matched_preferred_rung'] : ['matched_fallback_rung'],
    unknownReason: null,
  };
}

/**
 * Roll per-episode verdicts into a series/season answer.
 *
 * The aggregate must never hide an outlier: 61 preferred episodes and one at
 * 720p is not "a 1080p series". `worstResolution` and `mixed` exist precisely
 * so the exception survives the summary.
 */
export function aggregateQuality(
  entries: ReadonlyArray<{ compliance: MediaQualityCompliance; owned: NormalizedMediaQuality | null }>,
): MediaQualityAggregate {
  const counts = { preferred: 0, acceptable: 0, belowPreference: 0, unknown: 0, upgradePotential: 0 };
  const byClass = new Map<string, number>();
  let worstOrdinal: number | null = null;
  let worst: string | null = null;

  for (const e of entries) {
    switch (e.compliance.status) {
      case 'preferred': counts.preferred += 1; break;
      case 'acceptable': counts.acceptable += 1; break;
      case 'below_preference': counts.belowPreference += 1; break;
      default: counts.unknown += 1; break;
    }
    if (e.compliance.upgradePotential) counts.upgradePotential += 1;

    const cls = e.owned?.resolutionClass ?? null;
    if (cls) {
      byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
      const ord = e.owned?.resolutionOrdinal ?? null;
      if (ord != null && (worstOrdinal == null || ord < worstOrdinal)) {
        worstOrdinal = ord;
        worst = cls;
      }
    }
  }

  const dominant = [...byClass.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    evaluated: entries.length,
    ...counts,
    dominantResolution: dominant,
    worstResolution: worst,
    mixed: byClass.size > 1,
  };
}
