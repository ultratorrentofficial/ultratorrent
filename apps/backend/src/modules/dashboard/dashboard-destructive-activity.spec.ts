import { toActivityItem, type AuditRow } from './dashboard.module';

/**
 * A destructive line has to answer what, who and how.
 *
 * It answered none of them: `file.deleted` fell through to the default branch,
 * which looks for a subject in METADATA while a delete records its path in
 * `objectId`. The feed read "File deleted" and nothing else — for an
 * irreversible action, on a live host, 901 times.
 */
const row = (over: Partial<AuditRow>): AuditRow => ({
  id: 'a1',
  action: 'file.deleted',
  objectType: 'file',
  objectId: null,
  result: 'success',
  metadata: {},
  createdAt: new Date('2026-09-02T07:52:05Z'),
  user: null,
  ...over,
});

describe('destructive activity lines', () => {
  it('names the file, its size and the full path', () => {
    const item = toActivityItem(row({
      objectId: '/TV Shows/Reacher (2022)/Season 4/Reacher - S04E06.mkv',
      metadata: { mode: 'trash', bytes: 398772003, isDirectory: false },
    }));
    expect(item.message).toContain('Reacher - S04E06.mkv');
    expect(item.detail).toContain('/TV Shows/Reacher (2022)/Season 4/Reacher - S04E06.mkv');
    expect(item.detail).toContain('380 MB');
  });

  /** Recoverable and irreversible must not read the same. */
  it('distinguishes trash from a permanent delete', () => {
    expect(toActivityItem(row({ objectId: '/a/b.mkv', metadata: { mode: 'trash' } })).message)
      .toContain('Moved to trash');
    expect(toActivityItem(row({ objectId: '/a/b.mkv', metadata: { mode: 'permanent' } })).message)
      .toContain('Deleted permanently');
  });

  it('names the person when one is recorded', () => {
    const item = toActivityItem(row({
      objectId: '/a/b.mkv',
      metadata: { mode: 'permanent' },
      user: { username: 'dennis', displayName: 'Dennis Ayala' },
    }));
    expect(item.message).toContain('Dennis Ayala');
    expect(item.message).not.toContain('automatic');
  });

  /**
   * Most removals on the live host carry no user — the scheduler did them.
   * Saying nothing makes them look like something a person did.
   */
  it('says "automatic" when nothing did it on a person\'s behalf', () => {
    expect(toActivityItem(row({ objectId: '/a/b.mkv', metadata: { mode: 'trash' } })).message)
      .toContain('automatic');
  });

  it('gives a torrent removal the reason that caused it', () => {
    const item = toActivityItem(row({
      action: 'torrents.remove',
      metadata: { name: 'Lioness.2023.S03E04.1080p.mkv', reason: 'scheduler: seed target met' },
    }));
    expect(item.message).toContain('Lioness.2023.S03E04.1080p.mkv');
    expect(item.detail).toContain('scheduler: seed target met');
  });

  it('separates removing a torrent from removing its data', () => {
    expect(toActivityItem(row({ action: 'torrents.remove', metadata: { name: 'x' } })).message)
      .toBe('Removed torrent: x · automatic');
    expect(toActivityItem(row({ action: 'torrents.delete_data', metadata: { name: 'x' } })).message)
      .toContain('Removed torrent and data');
  });

  it('reports what a bulk removal actually touched', () => {
    const item = toActivityItem(row({
      action: 'torrents.bulk.removeData',
      metadata: { count: 5, libraryItemsRemoved: 4 },
      user: { username: 'd', displayName: 'Dennis' },
    }));
    expect(item.message).toContain('5 torrents');
    expect(item.detail).toContain('4 library items removed');
  });

  it('still produces a line when almost nothing was recorded', () => {
    const item = toActivityItem(row({ objectId: null, metadata: {} }));
    expect(item.message).toContain('Moved to trash');
    expect(item.detail).toBeNull();
  });

  it('leaves non-destructive actions unattributed as before', () => {
    const item = toActivityItem(row({ action: 'media.rename', metadata: {} }));
    expect(item.message).not.toContain('automatic');
  });
});
