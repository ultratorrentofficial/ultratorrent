import { ConflictException } from '@nestjs/common';
import { MediaIdentificationService } from './media-identification.service';
import { MediaItemService } from './media-item.service';
import { MediaNfoService } from './media-nfo.service';
import { MediaAutomationActions } from './media-automation.actions';

/**
 * The lock's contract, stated once: a locked item is NEVER re-identified,
 * re-enriched, renamed, moved, or have its NFO rewritten by any path.
 *
 * The split that matters is *how* each path refuses:
 *   - automated/bulk paths skip silently (a lock is a state, not a failure), and
 *   - explicit requests throw, because a silent no-op would report success for
 *     work that never happened.
 *
 * This exists because UltraTorrent shares a tree with tinyMediaManager: two
 * renamers and two NFO writers over one library, where a hand-corrected item is
 * exactly the thing neither tool should "fix" again.
 */
describe('the media item lock', () => {
  const lockedItem = {
    id: 'i1',
    libraryId: 'lib1',
    locked: true,
    mediaType: 'tv',
    title: 'The Librarians',
    year: 2014,
    season: 1,
    episode: 2,
    path: '/m/TV/The Librarians (2014)/Season 01/ep.mkv',
    matchStatus: 'manual',
  };

  describe('identification', () => {
    it('returns a locked item untouched from the automated path — no write at all', async () => {
      const prisma = {
        mediaItem: {
          findUnique: jest.fn().mockResolvedValue(lockedItem),
          update: jest.fn(),
        },
      };
      const svc = new MediaIdentificationService(prisma as any);

      await expect(svc.identify('i1')).resolves.toBe(lockedItem);
      // The point of the whole feature: nothing was written.
      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('excludes locked items from a bulk re-identify, whatever matchStatus is asked for', async () => {
      const prisma = {
        mediaItem: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
        mediaLibrary: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const svc = new MediaIdentificationService(prisma as any);

      await svc.identifyBulk({ matchStatus: 'manual' });

      // `locked: false` must survive even an explicit matchStatus filter —
      // otherwise "re-identify all manual items" would sweep locked ones back in.
      expect(prisma.mediaItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ locked: false }) }),
      );
    });

    it.each([
      ['reidentify', (s: MediaIdentificationService) => s.reidentify('i1')],
      ['matchManually', (s: MediaIdentificationService) => s.matchManually('i1', { title: 'X' })],
      ['unmatch', (s: MediaIdentificationService) => s.unmatch('i1')],
    ])('refuses an explicit %s on a locked item rather than no-oping', async (_name, call) => {
      const prisma = {
        mediaItem: {
          findUnique: jest.fn().mockResolvedValue(lockedItem),
          update: jest.fn(),
        },
      };
      const svc = new MediaIdentificationService(prisma as any);

      await expect(call(svc)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    });
  });

  describe('the renamer', () => {
    it('refuses to rename or move a locked item, at the choke point every caller passes through', async () => {
      const prisma = {
        mediaItem: {
          findUnique: jest.fn().mockResolvedValue({
            ...lockedItem,
            library: { id: 'lib1', mode: 'rename_move' },
            files: [{ path: lockedItem.path }],
          }),
        },
      };
      const media = { apply: jest.fn() };
      const actions = new MediaAutomationActions(
        prisma as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        media as any,
        {} as any,
        {} as any,
      );

      await expect(actions.renameItem('i1', undefined)).rejects.toBeInstanceOf(ConflictException);
      // No plan was even built — the file was never touched.
      expect(media.apply).not.toHaveBeenCalled();
    });

    it('leaves locked items out of a library-wide organize', async () => {
      const prisma = {
        mediaLibrary: {
          findUnique: jest.fn().mockResolvedValue({ id: 'lib1', mode: 'rename_move', path: '/m/TV' }),
        },
        mediaItem: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const actions = new MediaAutomationActions(
        prisma as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      await actions.organizeLibrary('lib1', { dryRun: true });

      expect(prisma.mediaItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ locked: false }) }),
      );
    });
  });

  describe('the NFO writer', () => {
    it('refuses to overwrite a locked item’s NFO — the sidecar another tool may own', async () => {
      const prisma = {
        mediaItem: {
          findUnique: jest.fn().mockResolvedValue({
            ...lockedItem,
            library: { id: 'lib1', nfoEnabled: true },
          }),
        },
      };
      const svc = new MediaNfoService(prisma as any, {} as any, {} as any);

      await expect(svc.generate({ itemId: 'i1' })).rejects.toBeInstanceOf(ConflictException);
    });

    it('skips locked items when generating NFOs across a library', async () => {
      const prisma = {
        mediaLibrary: { findUnique: jest.fn().mockResolvedValue({ id: 'lib1', nfoEnabled: true }) },
        mediaItem: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const svc = new MediaNfoService(prisma as any, {} as any, {} as any);

      await svc.generate({ libraryId: 'lib1' });

      expect(prisma.mediaItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ locked: false }) }),
      );
    });
  });

  describe('the lock itself', () => {
    it('locks and unlocks an item', async () => {
      const prisma = {
        mediaItem: {
          findUnique: jest.fn().mockResolvedValue({ ...lockedItem, locked: false }),
          update: jest.fn().mockResolvedValue({}),
        },
      };
      const svc = new MediaItemService(prisma as any);

      await svc.setLocked('i1', true);
      expect(prisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: { locked: true },
      });

      await svc.setLocked('i1', false);
      expect(prisma.mediaItem.update).toHaveBeenLastCalledWith({
        where: { id: 'i1' },
        data: { locked: false },
      });
    });

    it('refuses a field edit on a locked item', async () => {
      const prisma = {
        mediaItem: {
          findUnique: jest.fn().mockResolvedValue(lockedItem),
          update: jest.fn(),
        },
      };
      const svc = new MediaItemService(prisma as any);

      await expect(svc.update('i1', { title: 'Renamed' })).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    });
  });
});
