/**
 * Feed-scope resolution shared by RSS polling and the feed listing.
 *
 * A rule is created under one "owner" feed (`RssRule.feedId`), but each of its
 * match candidates carries a `feedScope` (`{ feedIds: string[] }`, empty = the
 * candidate applies to every feed the rule runs against). An enabled candidate
 * that names other feeds *extends* the rule to those feeds: the rule is then
 * polled against — and shown under — each of them.
 *
 * The set of feeds a rule targets is therefore its owner feed plus every feed
 * named by an enabled candidate's scope. A disabled rule targets nothing beyond
 * its owner (it is never polled), matching how it renders on the RSS page.
 */

/** Minimal shape needed to resolve a rule's target feeds. */
export interface FeedScopeRule {
  feedId: string;
  isEnabled: boolean;
}

/** Minimal candidate shape: only its enabled flag and JSON feed scope matter. */
export interface FeedScopeCandidate {
  enabled: boolean;
  feedScope: unknown;
}

/** Extract a `{ feedIds: string[] }` JSON blob into a clean string array. */
function scopeFeedIds(feedScope: unknown): string[] {
  const ids = (feedScope as { feedIds?: unknown } | null | undefined)?.feedIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * The distinct feeds a rule targets: its owner feed, plus (for an enabled rule)
 * every feed named by an enabled candidate's scope. Owner feed is always first.
 */
export function ruleTargetFeedIds(
  rule: FeedScopeRule,
  candidates: readonly FeedScopeCandidate[],
): string[] {
  const ids = new Set<string>([rule.feedId]);
  if (rule.isEnabled) {
    for (const candidate of candidates) {
      if (!candidate.enabled) continue; // disabled candidates never match → don't extend scope
      for (const id of scopeFeedIds(candidate.feedScope)) ids.add(id);
    }
  }
  return [...ids];
}
