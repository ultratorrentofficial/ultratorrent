/**
 * The path mapping registry service — caching and validation.
 *
 * The translation maths lives in `packages/shared` and is tested there; what is
 * tested here is the part that can rot in a service: a cache that outlives a
 * correction, and validation that lets through a rule which cannot mean
 * anything.
 */
import { BadRequestException } from '@nestjs/common';
import { PathMappingRegistryService } from './path-mapping-registry.service';

const dbRow = (over: Record<string, unknown> = {}) => ({
  id: 'r1', space: 'container', fromPrefix: '/media', toPrefix: '/downloads',
  scopeId: null, priority: 0, isEnabled: true, createdAt: new Date(), updatedAt: new Date(),
  ...over,
});

function build(rows: Array<Record<string, unknown>> = [dbRow()]) {
  const prisma = {
    pathMappingRule: {
      findMany: jest.fn(async () => rows),
      findUnique: jest.fn(async () => rows[0] ?? null),
      create: jest.fn(async (a: { data: unknown }) => a.data),
      update: jest.fn(async (a: { data: unknown }) => a.data),
      delete: jest.fn(async () => ({})),
    },
  };
  return { svc: new PathMappingRegistryService(prisma as never), prisma };
}

describe('rule cache', () => {
  it('reads the rules once and serves the rest from cache', async () => {
    // Translation runs on every stage of every intake; a query per call would
    // put the database on the hot path of a file move.
    const { svc, prisma } = build();
    await svc.toSpace('/media/a', 'container');
    await svc.toSpace('/media/b', 'container');
    await svc.toSpace('/media/c', 'container');
    expect(prisma.pathMappingRule.findMany).toHaveBeenCalledTimes(1);
  });

  it('drops the cache on create, so a correction takes effect immediately', async () => {
    /*
     * A stale mapping does not fail — it silently points at the wrong tree. An
     * operator who fixes one must not have to wait out a TTL to find out
     * whether the fix worked.
     */
    const { svc, prisma } = build();
    await svc.toSpace('/media/a', 'container');
    await svc.create({ space: 'host', fromPrefix: '/media', toPrefix: '/mnt/media' });
    await svc.toSpace('/media/a', 'container');
    expect(prisma.pathMappingRule.findMany).toHaveBeenCalledTimes(2);
  });

  it('drops the cache on update and delete too', async () => {
    const { svc, prisma } = build();
    await svc.toSpace('/media/a', 'container');
    await svc.update('r1', { priority: 5 });
    await svc.toSpace('/media/a', 'container');
    await svc.remove('r1');
    await svc.toSpace('/media/a', 'container');
    expect(prisma.pathMappingRule.findMany).toHaveBeenCalledTimes(3);
  });

  it('translates through the cached rules', async () => {
    const { svc } = build();
    expect(await svc.toSpace('/media/Movies/x.mkv', 'container')).toBe('/downloads/Movies/x.mkv');
    expect(await svc.fromSpace('/downloads/Movies/x.mkv', 'container')).toBe('/media/Movies/x.mkv');
  });

  it('excludes a disabled rule from translation', async () => {
    const { svc } = build([dbRow({ isEnabled: false })]);
    expect(await svc.toSpace('/media/x', 'container')).toBe('/media/x');
  });
});

describe('rule validation', () => {
  const create = (over: Record<string, unknown>) =>
    build().svc.create({ space: 'container', fromPrefix: '/media', toPrefix: '/downloads', ...over } as never);

  it('rejects a relative prefix', async () => {
    /*
     * A mapping is a textual prefix rewrite. A relative prefix would match
     * somewhere in the middle of a path and rewrite an import into an unrelated
     * tree — which is indistinguishable from losing the file.
     */
    await expect(create({ fromPrefix: 'media' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(create({ toPrefix: 'downloads' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown space', async () => {
    await expect(create({ space: 'nonsense' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to make canonical a target', async () => {
    // Canonical is the source of truth every other space is rendered from.
    await expect(create({ space: 'canonical' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a rule that changes nothing', async () => {
    // An inert rule is worse than an error: the operator believes a mapping is
    // in place and it silently is not.
    await expect(create({ fromPrefix: '/media', toPrefix: '/media' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an empty prefix', async () => {
    await expect(create({ fromPrefix: '   ' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates the MERGED rule on update, not just the patch', async () => {
    /*
     * A patch that only changes `space` still has to produce a coherent rule.
     * Validating the patch alone would let an update create something that
     * `create` would have refused.
     */
    const { svc } = build([dbRow({ fromPrefix: '/media', toPrefix: '/media' })]);
    await expect(svc.update('r1', { priority: 1 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a valid rule', async () => {
    await expect(create({ fromPrefix: '/media', toPrefix: '/mnt/media' })).resolves.toBeDefined();
  });
});
