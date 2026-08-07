/**
 * Which RSS rule downloaded a torrent.
 *
 * An `rss_rule`-scoped policy matches on this. The association lives in
 * `RssRuleMatchEvaluation`, which records every evaluation a rule made — most
 * of them decided nothing — so picking the right row is not a plain lookup.
 *
 * Pure, so the two rules that make it correct can be tested without a database.
 */

export interface RuleMatchRow {
  torrentHash: string | null;
  rssRuleId: string;
  actionTaken: string | null;
  createdAt: Date;
}

/**
 * Map info-hash → the rule that downloaded it.
 *
 * Two things decide the answer, and both matter:
 *
 * - **Only `download` counts.** A rule that evaluated an item and declined it,
 *   or skipped it as a duplicate, did not put that torrent in the queue. Every
 *   rule watching a busy feed logs a row per item, so counting those would
 *   attribute a torrent to whichever rule happened to look at it last.
 * - **Most recent wins.** A torrent removed and re-grabbed has two download
 *   rows, and the one that put the CURRENT copy there is the later one.
 *
 * Hashes are compared lowercased: the engine and the RSS pipeline record them
 * in whatever case their source used, and the existing single-torrent lookup
 * has always compared case-insensitively for the same reason.
 */
export function rulesByTorrentHash(rows: readonly RuleMatchRow[]): Map<string, string> {
  const out = new Map<string, string>();
  const seenAt = new Map<string, number>();

  for (const row of rows) {
    if (!row.torrentHash) continue;
    if (row.actionTaken !== 'download') continue;

    const hash = row.torrentHash.toLowerCase();
    const at = row.createdAt.getTime();
    const prior = seenAt.get(hash);
    // Strictly newer, so a stable input order decides ties rather than the last
    // row read winning by accident.
    if (prior !== undefined && at <= prior) continue;

    seenAt.set(hash, at);
    out.set(hash, row.rssRuleId);
  }
  return out;
}

/**
 * Both hex casings of each hash.
 *
 * Prisma's `in` has no case-insensitive mode, and an info-hash is hex — so it
 * is written either all-lower or all-upper and never mixed. Querying both
 * covers every real case without falling back to a raw statement.
 */
export function hashCaseVariants(hashes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const h of hashes) {
    out.add(h.toLowerCase());
    out.add(h.toUpperCase());
  }
  return [...out];
}
