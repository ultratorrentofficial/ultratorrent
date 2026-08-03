/**
 * Remove, delete-files and move — the three operations a Library Browser
 * selection had no way to perform.
 *
 * These pin the properties that make them safe rather than merely working:
 * which one touches the disk, what order the row and the file go in, and that
 * a cross-device move does not lose the source.
 */
import { BadRequestException } from '@nestjs/common';
import { MediaBulkService } from './media-bulk.service';

const fs = { unlinked: [] as string[], renamed: [] as string[][], copied: [] as string[][] };
let unlinkErr: NodeJS.ErrnoException | null = null;
let renameErr: NodeJS.ErrnoException | null = null;
/** Destinations that already hold a file — `moveFile` must refuse these. */
let occupied = new Set<string>();

jest.mock('node:fs/promises', () => ({
  unlink: jest.fn(async (p: string) => {
    if (unlinkErr) throw unlinkErr;
    fs.unlinked.push(p);
  }),
  rename: jest.fn(async (a: string, b: string) => {
    if (renameErr) throw renameErr;
    fs.renamed.push([a, b]);
  }),
  copyFile: jest.fn(async (a: string, b: string) => {
    fs.copied.push([a, b]);
  }),
  mkdir: jest.fn(async () => undefined),
  // The move path now asks whether the destination is free before touching it.
  // Default is ENOENT — free — which is what every pre-existing case here means.
  lstat: jest.fn(async (p: string) => {
    if (occupied.has(p)) return { isFile: () => true } as never;
    const err = new Error(`ENOENT: no such file, lstat '${p}'`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }),
}));

const ctx = { userId: 'u1', ipAddress: null, userAgent: null } as never;

function build(items: Array<Record<string, unknown>>, library?: Record<string, unknown> | null) {
  const order: string[] = [];
  const prisma = {
    mediaItem: {
      findMany: jest.fn(async ({ where }: never) =>
        (where as { id?: { in?: string[] } })?.id?.in
          ? items.filter((i) => (where as { id: { in: string[] } }).id.in.includes(i.id as string))
          : items,
      ),
      count: jest.fn(async () => 0),
      deleteMany: jest.fn(async () => ({ count: items.length })),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        order.push(`row:${where.id}`);
        return {};
      }),
      update: jest.fn(async () => ({})),
    },
    mediaFile: { update: jest.fn(async () => ({})) },
    mediaLibrary: { findUnique: jest.fn(async () => library ?? null) },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  };
  // runDetached executes the body inline so the assertions see the real work.
  const jobs = {
    runDetached: jest.fn(async (_t: string, _o: unknown, fn: never) => {
      const report = () => undefined;
      const signal = { isCancelled: () => false };
      await (fn as unknown as (r: unknown, s: unknown) => Promise<unknown>)(report, signal);
      return { jobId: 'job-1' };
    }),
  };
  const audit = { record: jest.fn(async (_r: Record<string, unknown>) => undefined) };
  const svc = new MediaBulkService(prisma as never, jobs as never, audit as never);
  return { svc, prisma, audit, jobs, order };
}

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id, path: `/media/${id}.mkv`, libraryId: 'lib-old', files: [{ id: `f-${id}`, path: `/media/${id}.mkv` }],
  subtitles: [], artwork: [],
  // The file sits directly in the library root, so it owns no folder of its own
  // and moves flat — which is the case these tests were written for. Moving a
  // folder is covered in move-to-library-folder.spec.ts.
  library: { path: '/media' },
  ...over,
});

beforeEach(() => {
  fs.unlinked = []; fs.renamed = []; fs.copied = [];
  unlinkErr = null; renameErr = null;
  occupied = new Set();
});

describe('removeFromLibrary', () => {
  it('drops the rows and touches no file', async () => {
    // This is the whole distinction from delete-files; if it ever unlinks, the
    // "safe" action stopped being safe.
    const { svc, prisma } = build([item('a'), item('b')]);
    const res = await svc.removeFromLibrary(['a', 'b'], ctx);
    expect(prisma.mediaItem.deleteMany).toHaveBeenCalled();
    expect(fs.unlinked).toEqual([]);
    expect(res.accepted).toBe(2);
  });

  it('reports ids that resolved to nothing', async () => {
    const { svc } = build([item('a')]);
    const res = await svc.removeFromLibrary(['a', 'ghost'], ctx);
    expect(res.missing).toEqual(['ghost']);
  });

  it('rejects an empty selection rather than deleting everything', async () => {
    const { svc } = build([]);
    await expect(svc.removeFromLibrary([], ctx)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('audits once for the whole selection', async () => {
    const { svc, audit } = build([item('a'), item('b')]);
    await svc.removeFromLibrary(['a', 'b'], ctx);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'media.bulk.remove' }));
  });
});

describe('deleteFiles', () => {
  it('unlinks the media and then drops the row', async () => {
    const { svc, prisma } = build([item('a')]);
    await svc.deleteFiles(['a'], ctx);
    expect(fs.unlinked).toContain('/media/a.mkv');
    expect(prisma.mediaItem.delete).toHaveBeenCalledWith({ where: { id: 'a' } });
  });

  it('keeps the row when the file could not be deleted', async () => {
    /*
     * The ordering property. Dropping the row first would lose the path on any
     * failure and strand media nothing points at.
     */
    unlinkErr = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const { svc, prisma } = build([item('a')]);
    await svc.deleteFiles(['a'], ctx);
    expect(prisma.mediaItem.delete).not.toHaveBeenCalled();
  });

  it('treats an already-missing file as success', async () => {
    // The desired end state is "not on disk", and it already is.
    unlinkErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const { svc, prisma } = build([item('a')]);
    await svc.deleteFiles(['a'], ctx);
    expect(prisma.mediaItem.delete).toHaveBeenCalledWith({ where: { id: 'a' } });
  });

  it('does not unlink the same path twice when files repeats it', async () => {
    const { svc } = build([item('a')]);
    await svc.deleteFiles(['a'], ctx);
    expect(fs.unlinked.filter((p) => p === '/media/a.mkv')).toHaveLength(1);
  });
});

describe('moveToLibrary', () => {
  const target = { id: 'lib-new', path: '/library/new', name: 'New' };

  it('moves the file under the target root and rewrites the paths', async () => {
    const { svc, prisma } = build([item('a')], target);
    await svc.moveToLibrary(['a'], 'lib-new', ctx);
    expect(fs.renamed).toEqual([['/media/a.mkv', '/library/new/a.mkv']]);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('falls back to copy+unlink across filesystems', async () => {
    /*
     * A library root is very often a different mount from the source, so EXDEV
     * is the ordinary case. Copy-then-unlink also means an interruption leaves
     * the original, not a truncated destination and no source.
     */
    renameErr = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    const { svc } = build([item('a')], target);
    await svc.moveToLibrary(['a'], 'lib-new', ctx);
    expect(fs.copied).toEqual([['/media/a.mkv', '/library/new/a.mkv']]);
    expect(fs.unlinked).toEqual(['/media/a.mkv']);
  });

  it('skips items already in the target rather than failing the batch', async () => {
    const { svc } = build([item('a'), item('b', { libraryId: 'lib-new' })], target);
    const res = await svc.moveToLibrary(['a', 'b'], 'lib-new', ctx);
    expect(res.accepted).toBe(1);
    expect(fs.renamed).toHaveLength(1);
  });

  it('rejects an unknown destination', async () => {
    const { svc } = build([item('a')], null);
    await expect(svc.moveToLibrary(['a'], 'nope', ctx)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('leaves the row alone when the file move failed', async () => {
    renameErr = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const { svc, prisma } = build([item('a')], target);
    await svc.moveToLibrary(['a'], 'lib-new', ctx);
    // copyFile is not stubbed to fail, so only a non-EXDEV error reaches here.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses to move onto a file that is already there', async () => {
    // Both branches of moveFile would destroy the occupant — `rename` replaces
    // it, and the EXDEV fallback copies over it and THEN unlinks the source,
    // losing one file and moving the other. Nothing may touch the disk.
    occupied.add('/library/new/a.mkv');
    const { svc, prisma } = build([item('a')], target);
    await svc.moveToLibrary(['a'], 'lib-new', ctx);
    expect(fs.renamed).toEqual([]);
    expect(fs.copied).toEqual([]);
    expect(fs.unlinked).toEqual([]);
    // …and the row still points at the source, because the file never moved.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
