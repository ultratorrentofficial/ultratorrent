import type { RssRule } from '@/lib/api';

/**
 * Rules that should be listed under a given feed, sorted alphabetically.
 *
 * A rule is owned by one feed but, via its match candidates' feed scope, can
 * target several (`rule.feedIds`). It therefore appears under every feed it
 * targets — not just its owner. `feedIds` falls back to the owner feed for any
 * older payload that predates the field.
 */
export function rulesForFeed(allRules: RssRule[], feedId: string): RssRule[] {
  return allRules
    .filter((rule) => (rule.feedIds ?? [rule.feedId]).includes(feedId))
    .sort((a, b) => a.name.localeCompare(b.name));
}
