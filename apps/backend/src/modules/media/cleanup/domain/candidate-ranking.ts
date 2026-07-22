/**
 * Candidate ranking for storage-pressure runs.
 *
 * When a run must reclaim a target and cannot take everything, something decides
 * what goes first. That decision is **explainable by construction**: a fixed set of
 * weighted, named factors, each contributing a stated number of points with a
 * human-readable reason. There is deliberately no learned or opaque score — an
 * operator must be able to read "why this file, and not that one" and disagree.
 *
 * Score is a preference ORDER, never permission. Ranking runs only over candidates
 * that already survived policy evaluation and every mandatory exclusion.
 */

export interface RankingFacts {
  reclaimableBytes: number;
  /** Days since the last completed play; null = never played. */
  daysSinceLastPlay: number | null;
  completedPlayCount: number;
  /** How far below the library's best copy of this title, in resolution tiers. */
  qualityTiersBelowBest: number | null;
  /** 0–1, how sure we are a verified replacement survives this. */
  replacementConfidence: number | null;
  daysSinceAdded: number | null;
  rating: number | null;
  isDuplicate: boolean;
}

export interface RankingContribution {
  factor: string;
  points: number;
  /** Rendered for the UI, e.g. "never played". */
  detail: string;
}

export interface RankingResult {
  score: number;
  contributions: RankingContribution[];
}

/** Weights are spaced so a higher factor cannot be outvoted by the sum of lower ones. */
export const RANKING_WEIGHTS = {
  replacementVerified: 1000,
  duplicate: 500,
  neverPlayed: 300,
  staleness: 200,
  qualityObsolescence: 150,
  reclaimSize: 100,
  lowUse: 50,
  age: 25,
  lowRating: 10,
} as const;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function rankCandidate(facts: RankingFacts): RankingResult {
  const contributions: RankingContribution[] = [];
  const add = (factor: string, points: number, detail: string) => {
    if (points > 0) contributions.push({ factor, points: Math.round(points), detail });
  };

  // A verified surviving replacement is the strongest signal there is: removing
  // this loses nothing.
  if (facts.replacementConfidence != null && facts.replacementConfidence > 0) {
    add('replacement', RANKING_WEIGHTS.replacementVerified * clamp01(facts.replacementConfidence),
      `verified replacement (confidence ${Math.round(facts.replacementConfidence * 100)}%)`);
  }

  if (facts.isDuplicate) {
    add('duplicate', RANKING_WEIGHTS.duplicate, 'another copy of this title exists');
  }

  if (facts.completedPlayCount === 0) {
    add('never_played', RANKING_WEIGHTS.neverPlayed, 'never played to completion');
  }

  // Staleness saturates at two years — beyond that, older is not meaningfully worse.
  if (facts.daysSinceLastPlay != null) {
    add('staleness', RANKING_WEIGHTS.staleness * clamp01(facts.daysSinceLastPlay / 730),
      `last played ${facts.daysSinceLastPlay} day(s) ago`);
  } else if (facts.completedPlayCount === 0) {
    add('staleness', RANKING_WEIGHTS.staleness, 'no play on record');
  }

  if (facts.qualityTiersBelowBest != null && facts.qualityTiersBelowBest > 0) {
    add('quality', RANKING_WEIGHTS.qualityObsolescence * clamp01(facts.qualityTiersBelowBest / 3),
      `${facts.qualityTiersBelowBest} tier(s) below the best copy held`);
  }

  // Reclaim saturates at 20 GiB so one enormous file cannot dominate the order.
  const gib = facts.reclaimableBytes / 1024 ** 3;
  add('reclaim', RANKING_WEIGHTS.reclaimSize * clamp01(gib / 20), `${gib.toFixed(1)} GiB reclaimable`);

  if (facts.completedPlayCount > 0 && facts.completedPlayCount < 3) {
    add('low_use', RANKING_WEIGHTS.lowUse, `only ${facts.completedPlayCount} completed play(s)`);
  }

  if (facts.daysSinceAdded != null) {
    add('age', RANKING_WEIGHTS.age * clamp01(facts.daysSinceAdded / 1095), `added ${facts.daysSinceAdded} day(s) ago`);
  }

  // Rating is the weakest signal on purpose: it is someone else's opinion.
  if (facts.rating != null && facts.rating < 5) {
    add('low_rating', RANKING_WEIGHTS.lowRating * clamp01((5 - facts.rating) / 5), `rated ${facts.rating}`);
  }

  const score = contributions.reduce((n, c) => n + c.points, 0);
  return { score, contributions: contributions.sort((a, b) => b.points - a.points) };
}

/** Highest score first; ties broken deterministically so ordering is reproducible. */
export function compareRanked(
  a: { score: number; id: string },
  b: { score: number; id: string },
): number {
  return b.score - a.score || a.id.localeCompare(b.id);
}
