/**
 * Attention ordering — a persisted, explainable rank.
 *
 * The queue must come back worst-first, and the order must not shuffle
 * between pages. Neither is possible by sorting the `severity` column
 * directly: it is text, and alphabetically `critical` sorts before `error`
 * before `info` before `opportunity` before `warning`, which is close to the
 * reverse of what it means.
 *
 * So the rank is computed and stored. Two consequences worth stating plainly:
 * it must be recomputed anywhere severity or disposition changes (there are
 * exactly two such places — reconciliation and a disposition mutation), and
 * it is a *derived* value like everything else in this module, rebuildable
 * from the row it sits on.
 *
 * It is deliberately NOT a score out of 100. Every value here decodes:
 *
 *     rank = severityRank * 10 + (acknowledged ? 1 : 0)
 *
 *      0  critical, nobody has looked          10  error, nobody has looked
 *      1  critical, acknowledged               11  error, acknowledged
 *     20  warning, nobody has looked           30  opportunity
 *     40  info
 *
 * Lower sorts first. Acknowledgement demotes within a severity rather than
 * across it: seeing a critical finding does not make it less critical than a
 * warning nobody has read.
 *
 * Escalation needs no term of its own. Clearing a disposition returns the row
 * to `unreviewed`, which already outranks `acknowledged` by this formula.
 */

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  error: 1,
  warning: 2,
  opportunity: 3,
  info: 4,
};

/** Unknown severities sort last rather than first — never invent urgency. */
const UNKNOWN_SEVERITY_RANK = 9;

export function attentionPriority(severity: string, disposition: string): number {
  const base = SEVERITY_RANK[severity] ?? UNKNOWN_SEVERITY_RANK;
  return base * 10 + (disposition === 'acknowledged' ? 1 : 0);
}

/**
 * The stable ordering every attention query uses.
 *
 * `id` is the final tie-break and it is not decorative: without a total order
 * Postgres may return equal-ranked rows in a different sequence per query,
 * and page 2 would then repeat or skip rows from page 1.
 */
export const ATTENTION_ORDER_BY = [
  { attentionPriority: 'asc' as const },
  // Oldest first within a rank: it has been waiting longest.
  { firstObservedAt: 'asc' as const },
  { id: 'asc' as const },
];
