import { RssService } from './rss.module';

/**
 * Duplicate-rule guard: a rule name must be unique (case-insensitive) and a
 * non-empty savePath must not already belong to another rule. Covers both the
 * create path and the edit path (which excludes the rule being edited).
 */
function makeRss(findFirst: jest.Mock, existingRule: any = null) {
  const created: any[] = [];
  const updated: any[] = [];
  const prisma = {
    rssRule: {
      findFirst,
      findUnique: jest.fn(async () => existingRule),
      create: jest.fn(async ({ data }: any) => { created.push(data); return { id: 'r1', ...data }; }),
      update: jest.fn(async ({ data }: any) => { updated.push(data); return { id: existingRule?.id ?? 'r1', ...data }; }),
    },
    rssHistory: { findMany: jest.fn(async () => []) },
  };
  const svc = new RssService(
    prisma as never,
    {} as never,
    { resolveByProviderId: jest.fn() } as never,
    { record: jest.fn() } as never,
    { broadcast: jest.fn() } as never,
    { get: jest.fn() } as never,
    { emit() {} } as never,
  );
  return { svc, prisma, created, updated };
}

const baseDto = { feedId: 'f1', name: 'The Rookie', savePath: '/tv/The Rookie' };

describe('RssService — duplicate rule guard (createRule)', () => {
  it('rejects a name that already exists (case-insensitive)', async () => {
    const findFirst = jest.fn().mockResolvedValueOnce({ name: 'The Rookie' });
    const { svc, prisma } = makeRss(findFirst);
    await expect(svc.createRule({ ...baseDto } as never)).rejects.toThrow(/already exists/i);
    // The name match is queried case-insensitively and blocks before persisting.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: { equals: 'The Rookie', mode: 'insensitive' },
        }),
      }),
    );
    expect(prisma.rssRule.create).not.toHaveBeenCalled();
  });

  it('rejects a distinct name that reuses another rule\'s savePath', async () => {
    // name check clears, savePath check clashes.
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ name: 'Some Other Rule' });
    const { svc, prisma } = makeRss(findFirst);
    await expect(
      svc.createRule({ feedId: 'f1', name: 'Brand New', savePath: '/tv/The Rookie' } as never),
    ).rejects.toThrow(/path is already used/i);
    expect(prisma.rssRule.create).not.toHaveBeenCalled();
  });

  it('creates when both name and path are unique', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const { svc, created } = makeRss(findFirst);
    await svc.createRule({ ...baseDto } as never);
    expect(created[0]).toMatchObject({ name: 'The Rookie', savePath: '/tv/The Rookie' });
  });

  it('does not enforce path uniqueness when savePath is empty', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const { svc, created } = makeRss(findFirst);
    await svc.createRule({ feedId: 'f1', name: 'No Path Rule' } as never);
    // Only the name lookup runs; a null/empty savePath is never uniqueness-checked.
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(created[0].savePath).toBeNull();
  });
});

describe('RssService — duplicate rule guard (updateRule)', () => {
  it('excludes the edited rule from its own uniqueness check', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const { svc, prisma } = makeRss(findFirst, { id: 'r1', name: 'The Rookie' });
    await svc.updateRule('r1', { name: 'The Rookie Renamed' } as never);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { not: 'r1' } }) }),
    );
    expect(prisma.rssRule.update).toHaveBeenCalled();
  });

  it('rejects renaming onto another rule\'s name', async () => {
    const findFirst = jest.fn().mockResolvedValueOnce({ name: 'Taken' });
    const { svc, prisma } = makeRss(findFirst, { id: 'r1', name: 'Original' });
    await expect(svc.updateRule('r1', { name: 'Taken' } as never)).rejects.toThrow(/already exists/i);
    expect(prisma.rssRule.update).not.toHaveBeenCalled();
  });
});
