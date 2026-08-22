import { readdir } from 'node:fs/promises';
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


/**
 * The sidecar matcher, on its own.
 *
 * The tests above stub `sidecarsOf` so they can be about the DECISIONS. This is
 * about the matching itself, which is the subtlest thing on a destructive path:
 * it decides which files die alongside a video, and every mistake it can make is
 * silent. Two failures matter in opposite directions — sweeping up a file that
 * merely shares a prefix (deleting someone else's episode), and leaving a
 * sidecar behind (an orphaned `.srt` that makes a later duplicate scan
 * unreadable). Both are covered below.
 */
describe('sidecarsOf — what travels with the video, and what must not', () => {
  const DIR = '/downloads/TV Shows/Show (2021)/Season 6';
  const VIDEO = `${DIR}/Show - S06E11 - Title.mkv`;

  /** A service with nothing stubbed — the real matcher. */
  function matcher(): { sidecarsOf(videoPath: string): Promise<string[]> } {
    return new RssService(
      {} as never,
      {} as never,
      {} as never, {} as never, {} as never, {} as never,
      { get: async () => null, defaultProfile: async () => null } as never,
      {} as never,
      {} as never,
    ) as never as { sidecarsOf(videoPath: string): Promise<string[]> };
  }

  const listing = (...entries: string[]) =>
    (readdir as unknown as jest.Mock).mockResolvedValue(entries);

  afterEach(() => {
    (readdir as unknown as jest.Mock).mockResolvedValue([]);
  });

  it('takes the files named after the video', async () => {
    listing(
      'Show - S06E11 - Title.srt',
      'Show - S06E11 - Title.eng.srt',
      'Show - S06E11 - Title-thumb.jpg',
      'Show - S06E11 - Title.nfo',
    );

    expect(await matcher().sidecarsOf(VIDEO)).toEqual([
      `${DIR}/Show - S06E11 - Title.srt`,
      `${DIR}/Show - S06E11 - Title.eng.srt`,
      `${DIR}/Show - S06E11 - Title-thumb.jpg`,
      `${DIR}/Show - S06E11 - Title.nfo`,
    ]);
  });

  it('leaves show-level files alone — they are named after the FOLDER', async () => {
    // The whole reason the match is structural. `poster.jpg` belongs to the
    // series; trashing it because one episode was superseded would strip the
    // artwork off a show that is otherwise untouched.
    listing('poster.jpg', 'tvshow.nfo', 'theme.mp3', 'Season06-poster.jpg', 'banner.jpg');

    expect(await matcher().sidecarsOf(VIDEO)).toEqual([]);
  });

  it('never takes another video, even one named after this one', async () => {
    listing(
      'Show - S06E11 - Title-proper.mkv',
      'Show - S06E11 - Title.mp4',
      'Show - S06E11 - Title-alt.MKV',
      'Show - S06E11 - Title.srt',
    );

    // A video is a release, not a sidecar. Uppercase counts too.
    expect(await matcher().sidecarsOf(VIDEO)).toEqual([`${DIR}/Show - S06E11 - Title.srt`]);
  });

  it('never takes the video it was asked about', async () => {
    listing('Show - S06E11 - Title.mkv');
    expect(await matcher().sidecarsOf(VIDEO)).toEqual([]);
  });

  it('does not let "Episode 2" sweep up "Episode 20"', async () => {
    // The case the marker rule exists for: a bare extra character means a
    // DIFFERENT file, and getting this wrong deletes an episode nobody touched.
    listing(
      'Episode 2.srt',
      'Episode 20.srt',
      'Episode 2.eng.srt',
      'Episode 20-thumb.jpg',
      'Episode 2-thumb.jpg',
      'Episode 21.nfo',
    );

    expect(await matcher().sidecarsOf(`${DIR}/Episode 2.mkv`)).toEqual([
      `${DIR}/Episode 2.srt`,
      `${DIR}/Episode 2.eng.srt`,
      `${DIR}/Episode 2-thumb.jpg`,
    ]);
  });

  it('takes nothing, rather than throwing, when the folder cannot be read', async () => {
    // A permission error here must not fail the retirement; the caller decides
    // on the VIDEO, and a sidecar that cannot be listed is not worth a throw.
    (readdir as unknown as jest.Mock).mockRejectedValueOnce(new Error('EACCES'));

    await expect(matcher().sidecarsOf(VIDEO)).resolves.toEqual([]);
  });
});
