import {
  evaluateProtections,
  isPathInside,
  isInactive,
  type ProtectionRecord,
  type ProtectionTarget,
} from './protection-matcher';

const NOW = new Date('2026-06-01T00:00:00Z');

const prot = (over: Partial<ProtectionRecord>): ProtectionRecord => ({
  id: 'p1',
  targetType: 'media_file',
  protectionType: 'permanent',
  reason: 'keeper',
  ...over,
});

const target = (over: Partial<ProtectionTarget> = {}): ProtectionTarget => ({
  mediaItemId: 'item1',
  mediaFileId: 'file1',
  mediaShowId: 'show1',
  mediaLibraryId: 'lib1',
  seasonNumber: 1,
  episodeNumber: 2,
  externalIdentityKeys: ['imdb:tt0944947'],
  path: '/media/TV/Show/Season 01/ep.mkv',
  tags: ['favourite'],
  collectionIds: ['col1'],
  onWatchlist: false,
  torrentHash: 'ABC123',
  ...over,
});

describe('scope matching — stable identity', () => {
  const cases: Array<[string, ProtectionRecord]> = [
    ['media_file', prot({ targetType: 'media_file', mediaFileId: 'file1' })],
    ['media_item', prot({ targetType: 'media_item', mediaItemId: 'item1' })],
    ['show', prot({ targetType: 'show', mediaShowId: 'show1' })],
    ['season', prot({ targetType: 'season', mediaShowId: 'show1', seasonNumber: 1 })],
    ['episode', prot({ targetType: 'episode', mediaShowId: 'show1', seasonNumber: 1, episodeNumber: 2 })],
    ['library', prot({ targetType: 'library', mediaLibraryId: 'lib1' })],
    ['path_prefix', prot({ targetType: 'path_prefix', pathPrefix: '/media/TV/Show' })],
    ['tag', prot({ targetType: 'tag', tagValue: 'favourite' })],
    ['collection', prot({ targetType: 'collection', collectionId: 'col1' })],
    ['torrent', prot({ targetType: 'torrent', torrentHash: 'abc123' })],
    ['external_identity', prot({ targetType: 'external_identity', externalIdentityKey: 'imdb:tt0944947' })],
  ];

  it.each(cases)('protects via %s scope', (_label, p) => {
    expect(evaluateProtections(target(), [p], NOW).isProtected).toBe(true);
  });

  it('does not match a different id', () => {
    const p = prot({ targetType: 'media_file', mediaFileId: 'other' });
    expect(evaluateProtections(target(), [p], NOW).isProtected).toBe(false);
  });

  it('a season protection does not leak across shows or seasons', () => {
    const p = prot({ targetType: 'season', mediaShowId: 'show1', seasonNumber: 1 });
    expect(evaluateProtections(target({ seasonNumber: 2 }), [p], NOW).isProtected).toBe(false);
    expect(evaluateProtections(target({ mediaShowId: 'show2' }), [p], NOW).isProtected).toBe(false);
  });

  it('watchlist scope only matches when the target is on a watchlist', () => {
    const p = prot({ targetType: 'watchlist' });
    expect(evaluateProtections(target({ onWatchlist: false }), [p], NOW).isProtected).toBe(false);
    expect(evaluateProtections(target({ onWatchlist: true }), [p], NOW).isProtected).toBe(true);
  });

  it('reports every matching rule, not just the first', () => {
    const v = evaluateProtections(target(), [
      prot({ id: 'a', targetType: 'media_file', mediaFileId: 'file1' }),
      prot({ id: 'b', targetType: 'library', mediaLibraryId: 'lib1' }),
    ], NOW);
    expect(v.matches.map((m) => m.id).sort()).toEqual(['a', 'b']);
  });
});

describe('path prefix boundaries', () => {
  // /media/Movies must never protect /media/Movies2 — a sibling whose name merely
  // starts with the same characters is a different tree.
  it('respects path-segment boundaries', () => {
    expect(isPathInside('/media/Movies/a.mkv', '/media/Movies')).toBe(true);
    expect(isPathInside('/media/Movies', '/media/Movies')).toBe(true);
    expect(isPathInside('/media/Movies2/a.mkv', '/media/Movies')).toBe(false);
    expect(isPathInside('/media/MoviesOld/a.mkv', '/media/Movies')).toBe(false);
  });

  it('normalises traversal before comparing', () => {
    expect(isPathInside('/media/TV/../Movies/a.mkv', '/media/Movies')).toBe(true);
    expect(isPathInside('/media/Movies/../TV/a.mkv', '/media/Movies')).toBe(false);
  });

  it('a sibling directory is not protected by a prefix rule', () => {
    const p = prot({ targetType: 'path_prefix', pathPrefix: '/media/TV/Show' });
    expect(evaluateProtections(target({ path: '/media/TV/Show2/ep.mkv' }), [p], NOW).isProtected).toBe(false);
  });
});

describe('lifecycle — revocation and expiry', () => {
  it('a revoked protection stops protecting', () => {
    const p = prot({ mediaFileId: 'file1', revokedAt: new Date('2026-05-01T00:00:00Z') });
    expect(isInactive(p, NOW)).toBe(true);
    expect(evaluateProtections(target(), [p], NOW).isProtected).toBe(false);
  });

  it('a temporary protection lapses at its deadline', () => {
    const expired = prot({ mediaFileId: 'file1', protectionType: 'temporary', protectedUntil: new Date('2026-05-31T23:59:59Z') });
    const live = prot({ mediaFileId: 'file1', protectionType: 'temporary', protectedUntil: new Date('2026-06-02T00:00:00Z') });
    expect(evaluateProtections(target(), [expired], NOW).isProtected).toBe(false);
    expect(evaluateProtections(target(), [live], NOW).isProtected).toBe(true);
  });

  it('a permanent protection has no deadline to lapse', () => {
    const p = prot({ mediaFileId: 'file1', protectionType: 'permanent', protectedUntil: null });
    expect(evaluateProtections(target(), [p], new Date('2099-01-01T00:00:00Z')).isProtected).toBe(true);
  });
});

describe('legal hold', () => {
  it('is surfaced distinctly so an ordinary operator cannot lift it', () => {
    const v = evaluateProtections(target(), [
      prot({ mediaFileId: 'file1', protectionType: 'legal_hold', reason: 'litigation' }),
    ], NOW);
    expect(v.isProtected).toBe(true);
    expect(v.hasLegalHold).toBe(true);
  });

  it('an ordinary protection does not set the legal-hold flag', () => {
    const v = evaluateProtections(target(), [prot({ mediaFileId: 'file1' })], NOW);
    expect(v.isProtected).toBe(true);
    expect(v.hasLegalHold).toBe(false);
  });
});

describe('conditional protections fail closed', () => {
  const cond = (kind: string, cfg: Record<string, unknown> = {}) =>
    prot({ targetType: 'media_item', mediaItemId: 'item1', protectionType: 'conditional', conditionKind: kind, conditionConfig: cfg });

  it('partially_watched holds while progress is above the floor', () => {
    const p = cond('partially_watched', { minProgressPercent: 5 });
    expect(evaluateProtections(target({ maximumProgressPercent: 40 }), [p], NOW).isProtected).toBe(true);
    expect(evaluateProtections(target({ maximumProgressPercent: 0 }), [p], NOW).isProtected).toBe(false);
  });

  // Unknown facts must not become permission to delete.
  it('stays protective when the fact it depends on is unknown', () => {
    const p = cond('partially_watched', { minProgressPercent: 5 });
    expect(evaluateProtections(target({ maximumProgressPercent: null }), [p], NOW).isProtected).toBe(true);
  });

  it('recently_added lapses once the window passes', () => {
    const p = cond('recently_added', { days: 30 });
    expect(evaluateProtections(target({ addedAt: new Date('2026-05-25T00:00:00Z') }), [p], NOW).isProtected).toBe(true);
    expect(evaluateProtections(target({ addedAt: new Date('2026-01-01T00:00:00Z') }), [p], NOW).isProtected).toBe(false);
  });

  it('torrent_ratio_below holds while the ratio is under the limit', () => {
    const p = cond('torrent_ratio_below', { ratio: 2 });
    expect(evaluateProtections(target({ torrentRatio: 0.5 }), [p], NOW).isProtected).toBe(true);
    expect(evaluateProtections(target({ torrentRatio: 3 }), [p], NOW).isProtected).toBe(false);
  });

  it('an unrecognised condition is not permission to delete', () => {
    const p = cond('some_future_condition');
    expect(evaluateProtections(target(), [p], NOW).isProtected).toBe(true);
  });
});

describe('the empty case', () => {
  it('no protections means not protected', () => {
    const v = evaluateProtections(target(), [], NOW);
    expect(v.isProtected).toBe(false);
    expect(v.hasLegalHold).toBe(false);
    expect(v.matches).toEqual([]);
  });
});
