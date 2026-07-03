import { ruleTargetFeedIds } from './rss-feed-scope';

const rule = (feedId: string, isEnabled = true) => ({ feedId, isEnabled });
const cand = (enabled: boolean, feedIds?: string[]) => ({
  enabled,
  feedScope: feedIds ? { feedIds } : {},
});

describe('ruleTargetFeedIds', () => {
  it('returns just the owner feed when there are no candidates', () => {
    expect(ruleTargetFeedIds(rule('A'), [])).toEqual(['A']);
  });

  it('returns just the owner feed when candidates have empty (all-feeds) scope', () => {
    // Empty scope = "every feed the rule already runs against" — it must not
    // expand the rule to new feeds.
    expect(ruleTargetFeedIds(rule('A'), [cand(true), cand(true, [])])).toEqual(['A']);
  });

  it('extends the rule to feeds named by enabled candidates, owner first', () => {
    expect(ruleTargetFeedIds(rule('A'), [cand(true, ['B', 'C'])])).toEqual(['A', 'B', 'C']);
  });

  it('unions and de-duplicates across candidates (incl. the owner)', () => {
    const ids = ruleTargetFeedIds(rule('A'), [cand(true, ['B', 'A']), cand(true, ['B', 'C'])]);
    expect(ids).toEqual(['A', 'B', 'C']);
  });

  it('ignores disabled candidates', () => {
    expect(ruleTargetFeedIds(rule('A'), [cand(false, ['B']), cand(true, ['C'])])).toEqual(['A', 'C']);
  });

  it('a disabled rule targets only its owner feed, ignoring scopes', () => {
    expect(ruleTargetFeedIds(rule('A', false), [cand(true, ['B', 'C'])])).toEqual(['A']);
  });

  it('tolerates malformed scope JSON', () => {
    expect(ruleTargetFeedIds(rule('A'), [{ enabled: true, feedScope: null }])).toEqual(['A']);
    expect(ruleTargetFeedIds(rule('A'), [{ enabled: true, feedScope: { feedIds: 'x' } }])).toEqual(['A']);
    expect(ruleTargetFeedIds(rule('A'), [{ enabled: true, feedScope: { feedIds: [1, 'B'] } }])).toEqual(['A', 'B']);
  });
});
