/**
 * Recommendation ordering — a persisted, explainable rank.
 *
 * Exactly the problem `attention/priority.ts` solves for severity, and for
 * exactly the same reason: `confidence` is text, and sorting it directly
 * yields **high, low, medium** — which puts the advice UltraTorrent trusts
 * least above the advice it half-trusts. Alphabetical order is not meaning.
 *
 * So the rank is computed and stored:
 *
 *     0  high     — measured facts, a direct capability
 *     1  medium   — probably right; one input is partial or stale
 *     2  low      — worth a look; not enough to propose a specific remedy
 *
 * Lower sorts first. It is derived like everything else here and is
 * recomputed on every write, so it can never drift from the `confidence`
 * column beside it.
 *
 * Deliberately NOT the Attention priority rank. That one orders by how broken
 * something is; this orders by how much the system trusts its own suggestion.
 * A `low`-confidence recommendation about a critical finding is still a weak
 * suggestion, and pretending otherwise would let severity smuggle certainty
 * into advice that has none.
 */

const CONFIDENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Unknown confidence sorts last rather than first — never invent certainty. */
const UNKNOWN_CONFIDENCE_RANK = 9;

export function confidenceRank(confidence: string): number {
  return CONFIDENCE_RANK[confidence] ?? UNKNOWN_CONFIDENCE_RANK;
}

/**
 * The stable ordering every recommendation query uses.
 *
 * `id` is the final tie-break and is not decorative: without a total order
 * Postgres may return equal-ranked rows in a different sequence per query,
 * and page 2 would then repeat or skip rows from page 1.
 */
export const RECOMMENDATION_ORDER_BY = [
  { confidenceRank: 'asc' as const },
  // Oldest first within a rank: it has been waiting longest.
  { createdAt: 'asc' as const },
  { id: 'asc' as const },
];
