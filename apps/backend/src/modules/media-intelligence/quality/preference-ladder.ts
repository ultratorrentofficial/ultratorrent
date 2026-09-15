import type {
  MediaPreferenceSource,
  NormalizedPreferenceLadder,
  NormalizedPreferenceRung,
} from '@ultratorrent/shared';

import type { MatchCandidateInput } from '../../rss/match-engine';

/**
 * The effective acquisition ladder → the shape the quality evaluator reads.
 *
 * A projection, emphatically not a resolution. `AcquisitionMatchPreferenceService`
 * decides WHICH ladder applies — global first, then the show's RSS rule
 * candidates, then per-media-type profiles — and this file must never
 * re-implement that cascade, or the two would drift and Intelligence would
 * start judging media against preferences Acquisition would not have used.
 *
 * All this does is flatten the candidates Acquisition handed back into the
 * dimensions an owned file can be compared against, preserving rung order
 * exactly: index 0 is the operator's first choice.
 */

/** Rungs arrive pre-ordered from acquisition; the index IS the preference. */
export function normalizeLadder(
  candidates: readonly MatchCandidateInput[],
  source: MediaPreferenceSource,
  sourceLabel: string | null,
): NormalizedPreferenceLadder {
  const rungs: NormalizedPreferenceRung[] = candidates.map((c, index) => {
    const q = c.qualityRules ?? {};
    const s = c.sizeRules ?? {};
    return {
      id: c.id,
      name: c.name,
      rung: index,
      resolution: q.resolution ?? null,
      codec: q.codec ?? null,
      source: q.source ?? null,
      quality: q.quality ?? null,
      requiredTerms: [...(c.requiredTerms ?? [])],
      excludedTerms: [...(c.excludedTerms ?? [])],
      maxBytes: s.maxBytes ?? null,
      minBytes: s.minBytes ?? null,
    };
  });

  return {
    source: rungs.length ? source : 'none',
    sourceLabel: rungs.length ? sourceLabel : null,
    rungs,
  };
}

/** An empty ladder — nothing is configured for this media. */
export function emptyLadder(): NormalizedPreferenceLadder {
  return { source: 'none', sourceLabel: null, rungs: [] };
}
