import { RssService } from './rss.module';

/**
 * A superseded release has to lose its LIBRARY copy, not just its torrent.
 *
 * `removeTorrentAndData` was the whole of the old behaviour, and it cannot see
 * the library: Media Intake places by hardlink, so deleting the staging path
 * drops one link and the imported file survives. The next import of the better
 * release then found that orphan on the canonical name and moved it aside as
 * `[dupN]` — one upgrade, two copies of the episode.
 *
 * Which release wins is NOT decided here and is not tested here. The rule's
 * match preferences settle it in `grabWithDedup` before this is ever reached.
 */

const HASH = 'aaaabbbbccccddddeeeeffff0000111122223333';
const IMPORTED = '/downloads/TV Shows/Show (2021)/Season 6/Show - S06E11 - Title.mkv';

function build(opts: {
  jobs?: Array<{ importedPath: string | null; mediaItemId: string | null }>;
  locked?: boolean;
  sidecars?: string[];
  removeFails?: string | null;
  lookupThrows?: boolean;
} = {}) {
  const removed: string[] = [];
  const removeTorrentAndData = jest.fn(async () => undefined);

  const prisma = {
    mediaIntakeJob: {
      findMany: async () => {
        if (opts.lookupThrows) throw new Error('db down');
        return opts.jobs ?? [{ importedPath: IMPORTED, mediaItemId: 'item1' }];
      },
    },
    mediaItem: { findUnique: async () => ({ locked: !!opts.locked }) },
  };

  const files = {
    remove: jest.fn(async ({ path }: { path: string }) => {
      if (opts.removeFails && path === opts.removeFails) throw new Error('EPERM');
      removed.push(path);
      return {};
    }),
  };
  const filePath = {
    assertWithinHardRoots: (p: string) => p,
    storageSafety: { toRelative: (p: string) => p },
  };

  const svc = new RssService(
    prisma as never,
    { getDefault: async () => ({ removeTorrentAndData }) } as never,
    {} as never, {} as never, {} as never, {} as never,
    { get: async () => null, defaultProfile: async () => null } as never,
    files as never,
    filePath as never,
  ) as never as { removeSupersededRelease(hash: string): Promise<void> };

  // The file probes are the only real I/O in this path; stub them rather than
  // building a temp tree, so the test is about the DECISIONS not the disk.
  (svc as never as Record<string, unknown>).sidecarsOf = async () => opts.sidecars ?? [];

  return { svc, files, removed, removeTorrentAndData };
}

// `stat` decides "is the copy still there"; every case here says yes except
// where a test overrides it.
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual('node:fs/promises'),
  stat: jest.fn(async () => ({ size: 1 })),
  readdir: jest.fn(async () => []),
}));

describe('a superseded release loses its library copy before its torrent', () => {
  it('trashes the imported copy, then removes the torrent and its Intake data', async () => {
    const { svc, files, removed, removeTorrentAndData } = build();

    await svc.removeSupersededRelease(HASH);

    expect(removed).toEqual([IMPORTED]);
    // Trashed, never permanently deleted — a misjudged upgrade stays recoverable.
    expect(files.remove).toHaveBeenCalledWith(
      { path: IMPORTED, permanent: false },
      {},
      'storage',
    );
    expect(removeTorrentAndData).toHaveBeenCalledWith(HASH);
  });

  it('takes the sidecars with it, so no orphaned .srt is left behind', async () => {
    const srt = IMPORTED.replace(/\.mkv$/, '.eng.srt');
    const { svc, removed } = build({ sidecars: [srt] });

    await svc.removeSupersededRelease(HASH);

    // Sidecars first, then the video — a sidecar must never outlive its video.
    expect(removed).toEqual([srt, IMPORTED]);
  });

  it('still removes the torrent when the release was never imported', async () => {
    const { svc, files, removeTorrentAndData } = build({ jobs: [] });

    await svc.removeSupersededRelease(HASH);

    expect(files.remove).not.toHaveBeenCalled();
    // Nothing to trash is not a failure; the torrent is still retired.
    expect(removeTorrentAndData).toHaveBeenCalledWith(HASH);
  });

  it('leaves a locked item alone but still retires the torrent', async () => {
    const { svc, files, removeTorrentAndData } = build({ locked: true });

    await svc.removeSupersededRelease(HASH);

    // `locked` takes an item out of every automated path; the lock protects the
    // file, not the torrent. The deliberate duplicate is the Duplicate Center's.
    expect(files.remove).not.toHaveBeenCalled();
    expect(removeTorrentAndData).toHaveBeenCalledWith(HASH);
  });

  it('keeps BOTH when the library copy cannot be trashed', async () => {
    const { svc, removeTorrentAndData } = build({ removeFails: IMPORTED });

    await svc.removeSupersededRelease(HASH);

    // The half-applied retirement — torrent gone, orphan left on the canonical
    // name — is the exact bug this method exists to prevent.
    expect(removeTorrentAndData).not.toHaveBeenCalled();
  });

  it('keeps BOTH when the library copy cannot even be looked up', async () => {
    const { svc, removeTorrentAndData } = build({ lookupThrows: true });

    await svc.removeSupersededRelease(HASH);

    expect(removeTorrentAndData).not.toHaveBeenCalled();
  });
});
