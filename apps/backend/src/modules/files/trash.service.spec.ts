import { ConflictException } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
      findMany: jest.fn(async () => [...store.values()]),
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
