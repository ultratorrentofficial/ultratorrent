import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { QuarantineService, QUARANTINE_DIR_NAME } from './quarantine.service';

jest.mock('../../files/file-fs.util', () => ({
  pathExists: jest.fn(async () => true),
  moveRecursive: jest.fn(async () => undefined),
  computeSize: jest.fn(async () => 4096),
}));
jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(async () => undefined),
  rm: jest.fn(async () => undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fsUtil = require('../../files/file-fs.util') as {
  pathExists: jest.Mock; moveRecursive: jest.Mock; computeSize: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fsp = require('node:fs/promises') as { rm: jest.Mock };

const user = { id: 'u1', username: 'op', roles: [], permissions: [] } as never;
const ROOT = '/media';
/** Where ITEM would be restored to — kept distinct from the paths quarantine tests use. */
const RESTORE_DEST = `${ROOT}/Movies/Film/film.mkv`;
const SOURCE = `${ROOT}/Movies/Fresh/fresh.mkv`;

const ITEM = {
  id: 'q1', status: 'quarantined',
  originalPath: '/Movies/Film/film.mkv',
  quarantinePath: `${ROOT}/${QUARANTINE_DIR_NAME}/q1__film.mkv`,
  storageRoot: ROOT,
  fileSizeBytes: 4096n, fingerprint: 'fp1',
  mediaItemId: 'i1', mediaFileId: 'f1',
};

function makeService(over: {
  item?: Record<string, unknown> | null;
  hardRoots?: string[];
  isProtected?: boolean;
  hasLegalHold?: boolean;
  destExists?: boolean;
  payloadExists?: boolean;
  sourceExists?: boolean;
  createThrows?: boolean;
} = {}) {
  const updates: Record<string, unknown>[] = [];
  let row: Record<string, unknown> | null = over.item === undefined ? { ...ITEM } : over.item;

  // Reset rather than clear, so a `…Once` queued by an earlier test cannot leak.
  fsUtil.pathExists.mockReset();
  fsUtil.moveRecursive.mockReset();
  fsUtil.computeSize.mockReset();
  fsUtil.computeSize.mockImplementation(async () => 4096);
  fsUtil.pathExists.mockImplementation(async (p: string) => {
    if (p.includes(QUARANTINE_DIR_NAME)) return over.payloadExists ?? true;      // the payload
    if (p === RESTORE_DEST) return over.destExists ?? false;                     // where it goes back to
    return over.sourceExists ?? true;                                            // a file being quarantined
  });
  fsUtil.moveRecursive.mockImplementation(async () => undefined);

  const prisma = {
    mediaCleanupQuarantineItem: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (over.createThrows) throw new Error('db down');
        return data;
      }),
      findUnique: jest.fn(async () => row),
      findMany: jest.fn(async () => []),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data); row = { ...(row ?? {}), ...data }; return row;
      }),
      updateMany: jest.fn(async () => ({ count: 2 })),
      delete: jest.fn(async () => ({})),
    },
  };
  const audit = { record: jest.fn(async (_e: { action: string }) => undefined) };
  const paths = {
    hardRoots: over.hardRoots ?? [ROOT],
    assertWithinHardRoots: jest.fn((p: string) => p),
    storageSafety: {
      assertDeletable: jest.fn(),
      rootFor: jest.fn(() => ROOT),
      toRelative: jest.fn(() => '/Movies/Film/film.mkv'),
    },
  };
  const protections = {
    evaluate: jest.fn(async () => ({
      isProtected: over.isProtected ?? false,
      hasLegalHold: over.hasLegalHold ?? false,
      matches: [],
    })),
  };

  const service = new QuarantineService(prisma as never, audit as never, paths as never, protections as never);
  return { service, prisma, audit, updates, get row() { return row; } };
}

afterEach(() => jest.clearAllMocks());

describe('quarantining is a move, not a deletion', () => {
  it('moves the file into the reserved directory in its own root', async () => {
    const h = makeService();
    const result = await h.service.quarantine({
      absPath: SOURCE, fingerprint: 'fp1', planId: 'p1',
    });
    expect(result.quarantinePath).toContain(QUARANTINE_DIR_NAME);
    expect(fsUtil.moveRecursive).toHaveBeenCalled();
    // Nothing is ever removed here.
    expect(fsp.rm).not.toHaveBeenCalled();
  });

  // A crash between the row and the move leaves a row pointing at a file that is
  // still in place, which is recoverable. The reverse is not.
  it('journals the row BEFORE moving the file', async () => {
    const h = makeService();
    await h.service.quarantine({ absPath: SOURCE, fingerprint: 'fp1' });
    expect(h.prisma.mediaCleanupQuarantineItem.create.mock.invocationCallOrder[0]!)
      .toBeLessThan(fsUtil.moveRecursive.mock.invocationCallOrder[0]!);
  });

  it('drops the row when the move fails, rather than claiming a quarantine that never happened', async () => {
    const h = makeService();
    fsUtil.moveRecursive.mockRejectedValueOnce(new Error('cross-device link'));
    await expect(h.service.quarantine({ absPath: SOURCE, fingerprint: 'fp1' }))
      .rejects.toThrow(/cross-device/);
    expect(h.prisma.mediaCleanupQuarantineItem.delete).toHaveBeenCalled();
  });

  it('refuses a file that is no longer there', async () => {
    const h = makeService({ sourceExists: false });
    await expect(h.service.quarantine({ absPath: SOURCE, fingerprint: 'fp1' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('gives every item a unique on-disk name so basenames cannot collide', async () => {
    const h = makeService();
    const a = await h.service.quarantine({ absPath: `${ROOT}/A/film.mkv`, fingerprint: 'fp1' });
    const b = await h.service.quarantine({ absPath: `${ROOT}/B/film.mkv`, fingerprint: 'fp2' });
    expect(a.quarantinePath).not.toBe(b.quarantinePath);
  });
});

describe('restore puts it back where it came from', () => {
  it('resolves against the item\'s OWN recorded root', async () => {
    const h = makeService();
    await h.service.restore('q1', user);
    expect(fsUtil.moveRecursive).toHaveBeenCalledWith(
      ITEM.quarantinePath, RESTORE_DEST, false,
    );
    expect(h.row!.status).toBe('restored');
  });

  // Very often the thing at the original path is the replacement that justified
  // the cleanup, so overwriting it has to be asked for.
  it('refuses to overwrite whatever now occupies the original path', async () => {
    const h = makeService({ destExists: true });
    await expect(h.service.restore('q1', user)).rejects.toBeInstanceOf(ConflictException);
    expect(fsUtil.moveRecursive).not.toHaveBeenCalled();
  });

  it('overwrites only when told to', async () => {
    const h = makeService({ destExists: true });
    await h.service.restore('q1', user, true);
    expect(fsp.rm).toHaveBeenCalled();
    expect(fsUtil.moveRecursive).toHaveBeenCalled();
  });

  it('refuses when the recorded root is no longer configured', async () => {
    const h = makeService({ hardRoots: ['/somewhere/else'] });
    await expect(h.service.restore('q1', user)).rejects.toThrow(/no longer configured/);
  });

  it('refuses a recorded path that would escape its own root', async () => {
    const h = makeService({ item: { ...ITEM, originalPath: '/../../etc/passwd' } });
    await expect(h.service.restore('q1', user)).rejects.toThrow(/outside/);
  });

  it('marks a vanished payload purged rather than pretending it can be restored', async () => {
    const h = makeService({ payloadExists: false });
    await expect(h.service.restore('q1', user)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.row!.status).toBe('purged');
  });

  it('will not restore something already restored', async () => {
    const h = makeService({ item: { ...ITEM, status: 'restored' } });
    await expect(h.service.restore('q1', user)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('purge is the one irreversible step', () => {
  it('removes the payload and records it', async () => {
    const h = makeService();
    await h.service.purge('q1', user);
    expect(fsp.rm).toHaveBeenCalledWith(ITEM.quarantinePath, { recursive: true, force: true });
    expect(h.row!.status).toBe('purged');
  });

  // A protection placed while the item sat in quarantine must save it.
  it('refuses to purge something protected since it was quarantined', async () => {
    const h = makeService({ isProtected: true });
    await expect(h.service.purge('q1', user)).rejects.toThrow(/protected/);
    expect(fsp.rm).not.toHaveBeenCalled();
    const actions = h.audit.record.mock.calls.map((c) => c[0].action);
    expect(actions).toContain('library_cleanup.quarantine.purge_refused');
  });

  it('names a legal hold as the reason when that is what stopped it', async () => {
    const h = makeService({ isProtected: true, hasLegalHold: true });
    await expect(h.service.purge('q1', user)).rejects.toThrow(/legal hold/);
  });

  // A corrupted row must never be able to aim `rm` at live library content.
  it('refuses to unlink a path outside a quarantine directory', async () => {
    const h = makeService({ item: { ...ITEM, quarantinePath: `${ROOT}/Movies/Film/film.mkv` } });
    await expect(h.service.purge('q1', user)).rejects.toThrow(/outside a quarantine directory/);
    expect(fsp.rm).not.toHaveBeenCalled();
  });

  it('refuses when the recorded root is not configured', async () => {
    const h = makeService({ hardRoots: ['/elsewhere'] });
    await expect(h.service.purge('q1', user)).rejects.toThrow(/outside a quarantine directory/);
    expect(fsp.rm).not.toHaveBeenCalled();
  });
});

describe('the expiry sweep', () => {
  // Reaching a deadline means "no longer promised", not "destroy now".
  it('marks items expired but deletes nothing', async () => {
    const h = makeService();
    await h.service.sweepExpired();
    expect(h.prisma.mediaCleanupQuarantineItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'expired' } }),
    );
    expect(fsp.rm).not.toHaveBeenCalled();
  });

  it('never throws out of the scheduler', async () => {
    const h = makeService();
    h.prisma.mediaCleanupQuarantineItem.updateMany.mockRejectedValueOnce(new Error('db gone'));
    await expect(h.service.sweepExpired()).resolves.toBeUndefined();
  });
});
