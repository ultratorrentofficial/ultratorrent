import { hashCaseVariants, rulesByTorrentHash } from './rss-scope';

/**
 * Which RSS rule downloaded a torrent.
 *
 * `rss_rule` was the last scheduler scope that matched nothing — the resolver
 * required `ctx.rssRuleId` and the preview never populated it, so a policy
 * scoped to a rule saved successfully and then governed no torrent. The
 * association exists in `RssRuleMatchEvaluation`, but that table logs every
 * evaluation every rule ever made, so picking the right row is the whole job.
 */
const row = (
  torrentHash: string | null,
  rssRuleId: string,
  actionTaken: string | null,
  iso: string,
) => ({ torrentHash, rssRuleId, actionTaken, createdAt: new Date(iso) });

const HASH = 'abc123';

describe('attributing a torrent to the rule that downloaded it', () => {
  it('maps a downloading evaluation to its rule', () => {
    const map = rulesByTorrentHash([row(HASH, 'rule-1', 'download', '2026-08-01T00:00:00Z')]);
    expect(map.get(HASH)).toBe('rule-1');
  });

  it('ignores an evaluation that did not download', () => {
    /*
     * The rule that matters is the one that PUT the torrent in the queue. Every
     * rule watching a busy feed logs a row per item it looks at, so counting
     * declines would attribute a torrent to whichever rule glanced at it last.
     */
    const map = rulesByTorrentHash([
      row(HASH, 'looked-but-declined', 'none', '2026-08-02T00:00:00Z'),
      row(HASH, 'skipped-as-dupe', 'skipped_duplicate', '2026-08-03T00:00:00Z'),
      row(HASH, 'actually-downloaded', 'download', '2026-08-01T00:00:00Z'),
    ]);
    expect(map.get(HASH)).toBe('actually-downloaded');
  });

  it('takes the most recent download when a torrent was re-grabbed', () => {
    // Removed and downloaded again: the rule that put the CURRENT copy there is
    // the later one.
    const map = rulesByTorrentHash([
      row(HASH, 'old-rule', 'download', '2026-01-01T00:00:00Z'),
      row(HASH, 'new-rule', 'download', '2026-08-01T00:00:00Z'),
    ]);
    expect(map.get(HASH)).toBe('new-rule');
  });

  it('does not depend on the order rows arrive in', () => {
    const rows = [
      row(HASH, 'new-rule', 'download', '2026-08-01T00:00:00Z'),
      row(HASH, 'old-rule', 'download', '2026-01-01T00:00:00Z'),
    ];
    expect(rulesByTorrentHash(rows).get(HASH)).toBe('new-rule');
    expect(rulesByTorrentHash([...rows].reverse()).get(HASH)).toBe('new-rule');
  });

  it('matches regardless of hash casing', () => {
    // The engine and the RSS pipeline each record the hash in whatever case
    // their source used; the single-torrent lookup has always compared
    // case-insensitively for the same reason.
    const map = rulesByTorrentHash([row('ABC123', 'rule-1', 'download', '2026-08-01T00:00:00Z')]);
    expect(map.get('abc123')).toBe('rule-1');
  });

  it('skips a row with no torrent hash', () => {
    // An evaluation that declined never recorded one.
    const map = rulesByTorrentHash([row(null, 'rule-1', 'download', '2026-08-01T00:00:00Z')]);
    expect(map.size).toBe(0);
  });

  it('keeps torrents separate', () => {
    const map = rulesByTorrentHash([
      row('aaa', 'rule-a', 'download', '2026-08-01T00:00:00Z'),
      row('bbb', 'rule-b', 'download', '2026-08-01T00:00:00Z'),
    ]);
    expect(map.get('aaa')).toBe('rule-a');
    expect(map.get('bbb')).toBe('rule-b');
  });

  it('returns an empty map for no rows', () => {
    expect(rulesByTorrentHash([]).size).toBe(0);
  });
});

describe('querying for both hash casings', () => {
  it('emits the lower and upper form of each hash', () => {
    // Prisma's `in` has no case-insensitive mode, and an info-hash is hex — so
    // it is written all-lower or all-upper and never mixed.
    expect(hashCaseVariants(['AbC']).sort()).toEqual(['ABC', 'abc']);
  });

  it('does not repeat a hash that is already single-case', () => {
    expect(hashCaseVariants(['abc', 'abc'])).toEqual(['abc', 'ABC']);
  });

  it('handles an empty list', () => {
    expect(hashCaseVariants([])).toEqual([]);
  });
});
