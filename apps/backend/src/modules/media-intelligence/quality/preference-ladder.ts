import type {
  MediaPreferenceSource,
  NormalizedPreferenceLadder,
  NormalizedPreferenceRung,
} from '@ultratorrent/shared';

import type { MatchCandidateInput } from '../../rss/match-engine';

/** The kinds of media a ladder can be asked to govern. */
export type LadderMediaKind = 'movie' | 'tv';

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

/**
 * Whether a resolved ladder actually applies to this kind of media.
 *
 * Acquisition never asks one ladder to serve both kinds: it scopes profiles by
 * `mediaType` and its global rungs are `smart_episode_match` — an EPISODE
 * matcher. Media Intelligence must respect the same boundary, because a ladder
 * built for episodes carries episode-shaped constraints, and the size caps are
 * the sharp edge: a 1 GB-per-episode ceiling applied to a feature film fails
 * every rung on size alone.
 *
 * That is not a hypothetical. Judging movies against this installation's
 * TV ladder marked 3,026 of 3,351 films `below_preference` purely on size —
 * Barbie at 2,153 MB against a 1 GB cap — which is a fabricated defect, not a
 * finding. When no rung applies, the honest answer is that no preferences
 * govern this title.
 */
export function ladderAppliesTo(
  candidates: readonly MatchCandidateInput[],
  kind: LadderMediaKind,
): boolean {
  if (!candidates.length) return false;
  if (kind === 'tv') return true;
  // A movie is governed only by rungs that are not episode matchers.
  return candidates.some((c) => c.matchType !== 'smart_episode_match');
}

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
