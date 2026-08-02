import { TorrentsService } from './torrents.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/**
 * Deleting a torrent's data does not, on its own, delete what it imported.
 *
 * Media Intake imports by HARDLINK: the library holds its own name for the same
 * bytes, so unlinking the download's name frees nothing and leaves a complete,
 * playable file. Live, "Time and Water" and "Maddie's Secret" both survived a
 * delete-with-data and had to be removed again through Library Browser, after
 * Plex had gone on offering them.
 *
 * The mapping to do better already existed — intake records
 * `torrentHash → mediaItemId` on every import — it was simply never consulted.
 * These pin what the delete path now does with it, and just as importantly what
 * it still refuses to do on its own.
 */
const user = (): AuthenticatedUser => ({
  id: 'u1', username: 'u', roles: ['SUPER_ADMIN'], permissions: [],
});

function build(jobs: Array<{ torrentHash: string; mediaItemId: string }>, items: any[]) {
  const provider = {
    removeTorrent: jest.fn().mockResolvedValue(undefined),
    removeTorrentAndData: jest.fn().mockResolvedValue(undefined),
  };
  const registry = { resolve: jest.fn().mockResolvedValue(provider) } as any;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;
  const filePath = {} as any;
  const prisma = {
    mediaIntakeJob: { findMany: jest.fn(async () => jobs) },
    mediaItem: { findMany: jest.fn(async () => items) },
  } as any;
  const mediaBulk = { deleteFiles: jest.fn().mockResolvedValue({ jobId: 'job-1' }) } as any;
  // Resolved lazily through ModuleRef rather than constructor-injected: importing
  // MediaModule into TorrentsModule closes a module cycle that kills the app at
  // bootstrap. See the `mediaBulk` getter.
  const moduleRef = { get: jest.fn(() => mediaBulk) } as any;
  return { svc: new TorrentsService(registry, audit, filePath, prisma, moduleRef), provider, mediaBulk };
}

const JOBS = [{ torrentHash: 'h1', mediaItemId: 'item-1' }];
const ITEMS = [{ id: 'item-1', title: "Maddie's Secret", path: '/downloads/Movies/HD Movies/x.mp4', library: { name: 'Movies' } }];

describe('deleting a torrent with data', () => {
  it('does NOT touch the library unless asked', async () => {
    // The default has to stay hands-off: a hardlink import exists precisely so a
    // library copy can outlive the torrent, and seeding-and-keeping depends on it.
    const { svc, provider, mediaBulk } = build(JOBS, ITEMS);
    await svc.removeData('h1', undefined, user(), {});
    expect(provider.removeTorrentAndData).toHaveBeenCalledWith('h1');
    expect(mediaBulk.deleteFiles).not.toHaveBeenCalled();
  });

  it('removes the imported item when asked', async () => {
    const { svc, provider, mediaBulk } = build(JOBS, ITEMS);
    await svc.removeData('h1', undefined, user(), {}, { removeLibraryItems: true });
    expect(provider.removeTorrentAndData).toHaveBeenCalledWith('h1');
    expect(mediaBulk.deleteFiles).toHaveBeenCalledWith(['item-1'], expect.anything());
  });

  it('runs the engine BEFORE the library, so a failed delete cannot empty it first', async () => {
    // The library copy is the one thing nothing else can reproduce.
    const { svc, mediaBulk, provider } = build(JOBS, ITEMS);
    provider.removeTorrentAndData.mockRejectedValueOnce(new Error('engine down'));
    await expect(
      svc.removeData('h1', undefined, user(), {}, { removeLibraryItems: true }),
    ).rejects.toThrow('engine down');
    expect(mediaBulk.deleteFiles).not.toHaveBeenCalled();
  });

  it('is a no-op on the library when the torrent imported nothing', async () => {
    const { svc, mediaBulk } = build([], []);
    await svc.removeData('h1', undefined, user(), {}, { removeLibraryItems: true });
    expect(mediaBulk.deleteFiles).not.toHaveBeenCalled();
  });

  it('ignores an intake job whose item no longer exists', async () => {
    // A job can outlive what it imported; offering to delete a row that is
    // already gone would put a phantom in the dialog.
    const { svc, mediaBulk } = build(JOBS, []);
    await svc.removeData('h1', undefined, user(), {}, { removeLibraryItems: true });
    expect(mediaBulk.deleteFiles).not.toHaveBeenCalled();
  });
});

describe('importedLibraryItems — what the dialog asks about', () => {
  it('names the item and its library so the question is answerable', async () => {
    const { svc } = build(JOBS, ITEMS);
    expect(await svc.importedLibraryItems(['h1'])).toEqual([
      { torrentHash: 'h1', itemId: 'item-1', title: "Maddie's Secret",
        path: '/downloads/Movies/HD Movies/x.mp4', library: 'Movies' },
    ]);
  });

  it('asks nothing of the database for an empty selection', async () => {
    const { svc } = build(JOBS, ITEMS);
    expect(await svc.importedLibraryItems([])).toEqual([]);
  });
});
