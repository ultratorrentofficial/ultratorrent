/**
 * Which copy should we keep, and why?
 *
 * Pure and dependency-free so the decision is unit-testable and, more importantly,
 * *explainable*: every candidate carries the ordered reasons it won or lost. A
 * confidence number with no evidence behind it is not something an operator can
 * disagree with, and disagreeing is the whole point of a review screen.
 *
 * Two ideas are kept deliberately separate, because collapsing them is how a cleanup
 * deletes a director's cut:
 *
 *   - **confidence** — how sure we are these are the same media.
 *   - **requiresReview** — whether a human must decide anyway.
 *
 * A group can be maximally confident and still require review (two files that ARE the
 * same episode but differ in runtime by ten minutes are probably different cuts).
 *
 * ## Why the ranking leads with measured data
 *
 * `MediaFile` carries two families of technical fields. The parsed ones
 * (`resolution`, `videoCodec`, `hdr`) come from the FILENAME, and the renamer strips
 * exactly those tokens — measured on a live library: resolution present on 18% of
 * files, videoCodec on 8%, **hdr on 0%**. The measured ones (`width`/`height`,
 * `bitrateKbps`, `durationSec`, `audioChannels`) are read from the container and are
 * present on 97.6%. So the ranking is built on measured height and bitrate, with the
 * parsed strings used only as a fallback when nothing was measured.
 *
 * This is also why there is no HDR rule: the column is empty on every file in the
 * library. A preference that can never fire is worse than an absent one — it reads as
 * implemented.
 */

export interface RecommendationFile {
  size: number;
  /** Measured from the container. Trustworthy where present. */
  height?: number | null;
  width?: number | null;
  bitrateKbps?: number | null;
  durationSec?: number | null;
  audioChannels?: number | null;
  /** Parsed from the filename. Usually absent — see the note above. */
  resolution?: string | null;
  videoCodec?: string | null;
}

export interface RecommendationCandidate {
  id: string;
  title: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  path: string;
  modifiedAt?: Date | null;
  externalIds?: Array<{ provider: string; externalId: string }>;
  file?: RecommendationFile | null;
}

export interface CandidateVerdict {
  id: string;
  rank: number;
  score: number;
  reasons: string[];
}

export interface Recommendation {
  /** Candidate id to keep, or null when the group must not be auto-resolved. */
  keepId: string | null;
  confidence: number;
  requiresReview: boolean;
  /** Machine-readable review causes, so the UI can explain rather than just warn. */
  warnings: string[];
  verdicts: CandidateVerdict[];
  /** Bytes freed by keeping `keepId` and trashing the rest. */
  potentialSavingsBytes: number;
}

/** Editions/cuts that must never be silently collapsed into one another. */
const EDITION_MARKERS = [
  'directors cut', 'director cut', 'theatrical', 'extended', 'unrated', 'uncut',
  'remastered', 'special edition', 'final cut', 'ultimate edition', 'imax', '3d',
];

/** Runtime difference beyond this fraction suggests a different cut, not a re-encode. */
const RUNTIME_TOLERANCE = 0.05;

function normalizePath(p: string): string {
  return p.toLowerCase().replace(/[._-]+/g, ' ');
}

function editionOf(path: string): string | null {
  const n = normalizePath(path);
  return EDITION_MARKERS.find((m) => n.includes(m)) ?? null;
}

/** Effective vertical resolution: measured height first, parsed string as fallback. */
function heightOf(f: RecommendationFile | null | undefined): number | null {
  if (!f) return null;
  if (f.height != null && f.height > 0) return f.height;
  const m = f.resolution?.match(/(\d{3,4})[pi]/i);
  return m ? Number(m[1]) : null;
}

/**
 * Decide which copy to keep.
 *
 * Ordering is deterministic: every comparison is a total order over the candidates,
 * and the final tiebreak is the id, so the same input always yields the same winner.
 * An operator who reruns detection must not see the recommendation move around.
 */
export function recommend(candidates: RecommendationCandidate[]): Recommendation {
  const warnings: string[] = [];

  if (candidates.length < 2) {
    return { keepId: null, confidence: 0, requiresReview: true, warnings: ['too_few_candidates'], verdicts: [], potentialSavingsBytes: 0 };
  }

  // --- identity guards: reasons a human must look, regardless of confidence -----

  const years = new Set(candidates.map((c) => c.year ?? null).filter((y) => y != null));
  if (years.size > 1) warnings.push('different_years');

  const se = new Set(candidates.map((c) => `${c.season ?? ''}-${c.episode ?? ''}`));
  if (se.size > 1) warnings.push('different_episodes');

  const editions = new Set(candidates.map((c) => editionOf(c.path) ?? ''));
  if (editions.size > 1) warnings.push('different_editions');

  // A provider id that disagrees across candidates means the metadata itself is in
  // conflict. Grouping may still be right, but acting on it unreviewed is not.
  const byProvider = new Map<string, Set<string>>();
  for (const c of candidates) {
    for (const e of c.externalIds ?? []) {
      const set = byProvider.get(e.provider) ?? new Set<string>();
      set.add(e.externalId);
      byProvider.set(e.provider, set);
    }
  }
  if ([...byProvider.values()].some((s) => s.size > 1)) warnings.push('conflicting_external_ids');

  const runtimes = candidates.map((c) => c.file?.durationSec ?? null).filter((d): d is number => d != null && d > 0);
  if (runtimes.length > 1) {
    const min = Math.min(...runtimes);
    const max = Math.max(...runtimes);
    if ((max - min) / max > RUNTIME_TOLERANCE) warnings.push('runtime_mismatch');
  }

  // --- ranking ------------------------------------------------------------------

  const reasons = new Map<string, string[]>(candidates.map((c) => [c.id, []]));
  const note = (id: string, r: string) => reasons.get(id)!.push(r);

  const best = <T>(pick: (c: RecommendationCandidate) => T | null, better: (a: T, b: T) => boolean): T | null => {
    let acc: T | null = null;
    for (const c of candidates) {
      const v = pick(c);
      if (v == null) continue;
      if (acc == null || better(v, acc)) acc = v;
    }
    return acc;
  };

  const topHeight = best((c) => heightOf(c.file), (a, b) => a > b);
  const topBitrate = best((c) => c.file?.bitrateKbps ?? null, (a, b) => a > b);
  const topChannels = best((c) => c.file?.audioChannels ?? null, (a, b) => a > b);
  const topSize = best((c) => c.file?.size ?? null, (a, b) => a > b);

  const scored = candidates.map((c) => {
    let score = 0;
    const h = heightOf(c.file);
    // Weights are spaced so a higher tier cannot be outvoted by the sum of lower
    // ones: resolution beats any bitrate advantage, bitrate beats any audio
    // advantage, and size only ever breaks a tie between otherwise equal files.
    if (h != null && topHeight != null && h === topHeight) { score += 1000; note(c.id, 'highest_resolution'); }
    else if (h != null && topHeight != null) note(c.id, 'lower_resolution');
    else note(c.id, 'resolution_unknown');

    const b = c.file?.bitrateKbps ?? null;
    if (b != null && topBitrate != null && b === topBitrate) { score += 100; note(c.id, 'highest_bitrate'); }

    const ch = c.file?.audioChannels ?? null;
    if (ch != null && topChannels != null && ch === topChannels) { score += 10; note(c.id, 'most_audio_channels'); }

    // Deliberately weak. "Largest file wins" is not a quality policy — a bloated
    // re-encode is not better than a smaller, higher-bitrate source — so size only
    // separates candidates that tied on everything measurable.
    const s = c.file?.size ?? 0;
    if (topSize != null && s === topSize) { score += 1; note(c.id, 'largest_file_tiebreak'); }

    return { c, score };
  });

  scored.sort(
    (x, y) =>
      y.score - x.score ||
      (y.c.modifiedAt?.getTime() ?? 0) - (x.c.modifiedAt?.getTime() ?? 0) ||
      x.c.id.localeCompare(y.c.id),
  );

  const verdicts: CandidateVerdict[] = scored.map((s, i) => ({
    id: s.c.id,
    rank: i + 1,
    score: s.score,
    reasons: reasons.get(s.c.id)!,
  }));

  // Confidence reflects how much EVIDENCE separated the winner, not how loudly we
  // want to act. Two files with no measured data at all are a coin toss dressed up
  // as a decision.
  const winner = scored[0];
  const runnerUp = scored[1];
  const measured = candidates.filter((c) => heightOf(c.file) != null || c.file?.bitrateKbps != null).length;
  let confidence = 0;
  if (measured === candidates.length) confidence = winner.score > runnerUp.score ? 90 : 60;
  else if (measured > 0) confidence = winner.score > runnerUp.score ? 70 : 40;
  else confidence = 20;

  const requiresReview = warnings.length > 0 || confidence < 50;

  const keptSize = winner.c.file?.size ?? 0;
  const totalSize = candidates.reduce((a, c) => a + (c.file?.size ?? 0), 0);

  return {
    // A group needing review has no auto-keep: offering one invites a bulk action to
    // sweep up exactly the cases a human was meant to look at.
    keepId: requiresReview ? null : winner.c.id,
    confidence,
    requiresReview,
    warnings,
    verdicts,
    potentialSavingsBytes: Math.max(0, totalSize - keptSize),
  };
}
