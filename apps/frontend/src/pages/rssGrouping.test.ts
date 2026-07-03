import { describe, expect, it } from 'vitest';
import type { RssRule } from '@/lib/api';
import { rulesForFeed } from './rssGrouping';

const rule = (id: string, name: string, feedId: string, feedIds?: string[]): RssRule => ({
  id,
  feedId,
  feedIds: feedIds ?? [feedId],
  name,
  includeRegex: null,
  excludeRegex: null,
  categoryId: null,
  savePath: null,
  autoDownload: true,
  isEnabled: true,
  createdAt: '2026-07-02T00:00:00.000Z',
});

describe('rulesForFeed', () => {
  const owned = rule('1', 'Zeta', 'A');
  const alsoScoped = rule('2', 'Alpha', 'B', ['B', 'A']); // owned by B, scoped to A too
  const other = rule('3', 'Mu', 'C');
  const all = [owned, alsoScoped, other];

  it('includes owner rules and rules scoped to the feed, sorted by name', () => {
    // Feed A: its own rule (Zeta) + the B-owned rule scoped to A (Alpha) → sorted.
    expect(rulesForFeed(all, 'A').map((r) => r.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('lists a multi-feed rule under each feed it targets', () => {
    expect(rulesForFeed(all, 'A').map((r) => r.id)).toContain('2');
    expect(rulesForFeed(all, 'B').map((r) => r.id)).toContain('2');
  });

  it('excludes rules that neither own nor scope to the feed', () => {
    expect(rulesForFeed(all, 'C').map((r) => r.id)).toEqual(['3']);
  });

  it('falls back to the owner feed when feedIds is absent', () => {
    const legacy = { ...owned, feedIds: undefined } as unknown as RssRule;
    expect(rulesForFeed([legacy], 'A').map((r) => r.id)).toEqual(['1']);
    expect(rulesForFeed([legacy], 'B')).toEqual([]);
  });
});
