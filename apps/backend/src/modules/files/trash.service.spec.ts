import { ConflictException } from '@nestjs/common';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrashService } from './trash.service';
import { FilePathService } from './file-path.service';
import { pathExists } from './file-fs.util';

function configFor(root: string): any {
  return { get: (k: string) => (k === 'fileManager.roots' ? [root] : undefined) };
}

/** Minimal in-memory stand-in for the trashItem Prisma model. */
function fakePrisma() {
  const store = new Map<string, any>();
  return {
    store,
    trashItem: {
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data, deletedAt: new Date() };
        store.set(data.id, row);
        return row;
      }),
      // Honours the `deletedAt: { lt }` filter the retention sweep relies on —
      // ignoring it would let a broken sweep "pass" by deleting everything.
      findMany: jest.fn(async (args?: any) => {
        const lt = args?.where?.deletedAt?.lt as Date | undefined;
        const rows = [...store.values()];
        return lt ? rows.filter((r) => r.deletedAt.getTime() < lt.getTime()) : rows;
      }),
      findUnique: jest.fn(async ({ where }: any) => store.get(where.id) ?? null),
      delete: jest.fn(async ({ where }: any) => {
        store.delete(where.id);
        return {};
      }),
      deleteMany: jest.fn(async () => {
        const count = store.size;
        store.clear();
        return { count };
      }),
    },
  };
}

describe('TrashService', () => {
  let root: string;
  let svc: TrashService;
  let prisma: ReturnType<typeof fakePrisma>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ut-trash-'));
    prisma = fakePrisma();
    const paths = new FilePathService(configFor(root), { get: async () => undefined, set: async () => {} } as any);
    svc = new TrashService(
      prisma as any,
      paths as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      { broadcast: jest.fn() } as any,
      // Unset retention setting → the 30-day default, so items stay listed.
      { get: async () => undefined, set: async () => {} } as any,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('moves an item to trash and lists it', async () => {
    await writeFile(join(root, 'a.txt'), 'data');
    const item = await svc.moveToTrash(join(root, 'a.txt'), { userId: 'u1' });
    expect(item.originalPath).toBe('/a.txt');
    expect(await pathExists(join(root, 'a.txt'))).toBe(false);
    expect(await pathExists(join(root, '.ultratorrent-trash', `${item.id}__a.txt`))).toBe(true);
    const list = await svc.list();
    expect(list).toHaveLength(1);
  });

  it('restores an item to its original location', async () => {
    await writeFile(join(root, 'b.txt'), 'data');
    const item = await svc.moveToTrash(join(root, 'b.txt'));
    await svc.restore(item.id, false);
    expect(await pathExists(join(root, 'b.txt'))).toBe(true);
    expect(await svc.list()).toHaveLength(0);
  });

  it('refuses to restore over an existing item without overwrite', async () => {
    await writeFile(join(root, 'c.txt'), 'one');
    const item = await svc.moveToTrash(join(root, 'c.txt'));
    await writeFile(join(root, 'c.txt'), 'two'); // recreate at original path
    await expect(svc.restore(item.id, false)).rejects.toThrow(ConflictException);
  });

  it('empties the trash', async () => {
    await writeFile(join(root, 'd.txt'), 'data');
    await svc.moveToTrash(join(root, 'd.txt'));
    const res = await svc.empty();
    expect(res.removed).toBe(1);
    expect(await svc.list()).toHaveLength(0);
  });
});

/**
 * Retention. Trash is a live view of what can still be recovered, so an entry has
 * to carry its own deadline and has to actually disappear once that deadline
 * passes — otherwise the surface degrades into the history log it must not be.
 */
describe('TrashService — retention', () => {
  let root: string;
  let prisma: ReturnType<typeof fakePrisma>;

  /** Build a service whose retention setting returns `days` (undefined → default). */
  function build(days?: number) {
    const paths = new FilePathService(configFor(root), {
      get: async () => undefined,
      set: async () => {},
    } as any);
    return new TrashService(
      prisma as any,
      paths as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      { broadcast: jest.fn() } as any,
      { get: async () => days, set: async () => {} } as any,
    );
  }

  /** Backdate a stored row so it looks older than the retention window. */
  function ageRow(id: string, days: number) {
    const row = prisma.store.get(id);
    row.deletedAt = new Date(Date.now() - days * 86400000);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ut-trash-ret-'));
    prisma = fakePrisma();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stamps expiresAt 30 days out when the setting is unset', async () => {
    const svc = build(undefined);
    await writeFile(join(root, 'a.txt'), 'data');
    const item = await svc.moveToTrash(join(root, 'a.txt'));
    const expected = new Date(prisma.store.get(item.id).deletedAt.getTime() + 30 * 86400000);
    expect(item.expiresAt).toBe(expected.toISOString());
  });

  it('honours a configured window', async () => {
    const svc = build(7);
    await writeFile(join(root, 'b.txt'), 'data');
    const item = await svc.moveToTrash(join(root, 'b.txt'));
    const expected = new Date(prisma.store.get(item.id).deletedAt.getTime() + 7 * 86400000);
    expect(item.expiresAt).toBe(expected.toISOString());
  });

  it('reports no expiry and never prunes when retention is disabled', async () => {
    const svc = build(0);
    await writeFile(join(root, 'c.txt'), 'data');
    const item = await svc.moveToTrash(join(root, 'c.txt'));
    expect(item.expiresAt).toBeNull();

    ageRow(item.id, 999);
    expect(await svc.pruneExpired()).toEqual({ removed: 0, bytes: 0 });
    expect(await svc.list()).toHaveLength(1);
  });

  it('falls back to the default window on a garbage setting rather than skipping the sweep', async () => {
    const svc = build('nonsense' as any);
    expect(await svc.retentionDays()).toBe(30);
  });

  it('prunes an expired item off disk and out of the listing, keeping fresh ones', async () => {
    const svc = build(30);
    await writeFile(join(root, 'old.txt'), 'data');
    await writeFile(join(root, 'new.txt'), 'data');
    const stale = await svc.moveToTrash(join(root, 'old.txt'));
    const fresh = await svc.moveToTrash(join(root, 'new.txt'));
    const stalePayload = join(root, '.ultratorrent-trash', `${stale.id}__old.txt`);

    ageRow(stale.id, 31);

    const res = await svc.pruneExpired();
    expect(res.removed).toBe(1);
    expect(await pathExists(stalePayload)).toBe(false);

    const listed = await svc.list();
    expect(listed.map((i) => i.id)).toEqual([fresh.id]);
  });

  it('withholds an item the moment its countdown elapses, before the sweep runs', async () => {
    const svc = build(30);
    await writeFile(join(root, 'e.txt'), 'data');
    const item = await svc.moveToTrash(join(root, 'e.txt'));

    // Past the window but the hourly sweep has not fired: the row is still in the
    // table, and list() must not offer it as restorable.
    ageRow(item.id, 31);
    expect(prisma.store.has(item.id)).toBe(true);
    expect(await svc.list()).toHaveLength(0);
  });
});

/**
 * G12: system-initiated maintenance (duplicate cleanup, Library Cleanup) removes
 * files in `storage` scope, which is pinned to the ops hard roots and never
 * narrowed by the DB-configured Default Root Path. Restore, however, resolved the
 * original path through the NARROWED browse boundary — so anything trashed from
 * outside that subtree either could not be restored, or worse, was silently put
 * back in the wrong place.
 */
describe('restoring something trashed in storage scope (G12)', () => {
  let root: string;
  let svc: TrashService;
  let paths: FilePathService;
  let prisma: ReturnType<typeof fakePrisma>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ut-trash-g12-'));
    await mkdir(join(root, 'complete'), { recursive: true });
    await mkdir(join(root, 'TV', 'Show'), { recursive: true });
    prisma = fakePrisma();
    // The narrowed browse root is a SUBTREE of the hard root — the live shape that
    // broke duplicate cleanup on synoplex.
    paths = new FilePathService(configFor(root), {
      get: async () => join(root, 'complete'),
      set: async () => {},
    } as any);
    svc = new TrashService(
      prisma as any, paths as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      { broadcast: jest.fn() } as any,
      { get: async () => undefined, set: async () => {} } as any,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('restores to the real original path, not one rebased on the narrowed root', async () => {
    const original = join(root, 'TV', 'Show', 'ep.mkv');
    await writeFile(original, 'data');

    const item = await svc.moveToTrash(original, { userId: 'u1' }, paths.storageSafety);
    expect(await pathExists(original)).toBe(false);

    await svc.restore(item.id, false);

    expect(await pathExists(original)).toBe(true);
    // The bug put it here instead, inside the narrowed browse root.
    expect(await pathExists(join(root, 'complete', 'TV', 'Show', 'ep.mkv'))).toBe(false);
  });

  it('purges the payload of a storage-scope item instead of leaking it', async () => {
    const original = join(root, 'TV', 'Show', 'leak.mkv');
    await writeFile(original, 'data');
    const item = await svc.moveToTrash(original, {}, paths.storageSafety);
    const payload = join(root, '.ultratorrent-trash', `${item.id}__leak.mkv`);
    expect(await pathExists(payload)).toBe(true);

    await svc.purge(item.id);

    // Previously the row went and the bytes stayed, so reclaimed-space was a lie.
    expect(await pathExists(payload)).toBe(false);
    expect(await svc.list()).toHaveLength(0);
  });

  it('refuses to restore when the recorded storage root is no longer configured', async () => {
    const original = join(root, 'TV', 'Show', 'orphan.mkv');
    await writeFile(original, 'data');
    const item = await svc.moveToTrash(original, {}, paths.storageSafety);
    // Simulate the operator removing that root from FILE_MANAGER_ROOTS entirely.
    // (A root that merely MOVED inside the hard roots still resolves, and safely:
    // the destination is still contained by the recorded root.)
    prisma.store.get(item.id).storageRoot = join(tmpdir(), 'ut-not-a-configured-root');
    await expect(svc.restore(item.id, false)).rejects.toThrow(/no longer configured/);
  });
});
