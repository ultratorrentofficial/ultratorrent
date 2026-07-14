import { MediaMetadataService } from './media-metadata.service';

/**
 * What the chain buys us, at the level a user would notice.
 *
 * Before the registry, exactly one provider was consulted: a TMDB miss was the
 * end of the story, and a TMDB outage meant every item in a scan came back bare.
 * These tests pin the two behaviours that fix:
 *
 *   - a MISS falls through to the next provider, and
 *   - a THROW does too. One sick provider must not deny an item the metadata a
 *     healthy provider two lines down would have given it.
 *
 * They drive the real service (not the registry) because the fall-through lives
 * in `fetchFromChain`, and that is what the enrichment pipeline calls.
 */
describe('MediaMetadataService — the provider chain', () => {
  const item = {
    id: 'i1',
    title: 'Silo',
    year: 2023,
    season: 1,
    episode: 2,
    mediaType: 'tv',
    files: [],
  };

  const details = (providerName: string) => ({
    title: 'Silo',
    providerName,
    externalIds: { [providerName]: '123' },
  });

  const build = (chain: any[]) => {
    const prisma = {
      mediaItem: { findUnique: jest.fn().mockResolvedValue(item), findMany: jest.fn().mockResolvedValue([]) },
      mediaMetadata: { upsert: jest.fn().mockResolvedValue({}) },
      mediaExternalId: { upsert: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    };
    const audit = { record: jest.fn(async () => undefined) };
    const registry = {
      chain: jest.fn(async () => chain),
      offline: () => ({ name: 'local', lookup: async () => ({}), fetchDetails: async () => null }),
    };
    const imdb = { enrichCrossProvider: jest.fn(async () => undefined) };
    const svc = new MediaMetadataService(
      prisma as any,
      { get: jest.fn(async () => undefined) } as any,
      { assertWithinHardRoots: (p: string) => p } as any,
      audit as any,
      imdb as any,
      registry as any,
    );
    return { svc, prisma, audit, registry };
  };

  const provider = (name: string, impl: () => Promise<any>) => ({
    name,
    lookup: jest.fn(async () => ({})),
    fetchDetails: jest.fn(impl),
  });

  it('takes the first provider that answers, and does not call the rest', async () => {
    const tvdb = provider('tvdb', async () => details('tvdb'));
    const tmdb = provider('tmdb', async () => details('tmdb'));
    const { svc, prisma } = build([tvdb, tmdb]);

    await svc.fetchMetadata('i1');

    expect(tvdb.fetchDetails).toHaveBeenCalled();
    expect(tmdb.fetchDetails).not.toHaveBeenCalled(); // no wasted API call
    expect(prisma.mediaMetadata.upsert.mock.calls[0][0].create.providerName).toBe('tvdb');
  });

  it('falls through to the next provider when the first has never heard of the title', async () => {
    const tvdb = provider('tvdb', async () => null); // a miss
    const tmdb = provider('tmdb', async () => details('tmdb'));
    const { svc, prisma } = build([tvdb, tmdb]);

    await svc.fetchMetadata('i1');

    expect(tmdb.fetchDetails).toHaveBeenCalled();
    expect(prisma.mediaMetadata.upsert.mock.calls[0][0].create.providerName).toBe('tmdb');
  });

  it('falls through when a provider THROWS, and audits the failure without killing the fetch', async () => {
    const tvdb = provider('tvdb', async () => {
      throw new Error('TVDB is down');
    });
    const tmdb = provider('tmdb', async () => details('tmdb'));
    const { svc, prisma, audit } = build([tvdb, tmdb]);

    await svc.fetchMetadata('i1');

    // The item still gets its metadata from the healthy provider...
    expect(prisma.mediaMetadata.upsert.mock.calls[0][0].create.providerName).toBe('tmdb');
    // ...and the outage is recorded rather than swallowed.
    const failure = audit.record.mock.calls.find(
      (c: any[]) => c[0].action === 'media.metadata.fetch_failed',
    ) as any[] | undefined;
    expect(failure).toBeDefined();
    expect(failure![0].metadata).toMatchObject({ provider: 'tvdb' });
    // The audit must never carry the key or provider config.
    expect(JSON.stringify(failure![0])).not.toContain('apiKey');
  });

  it('persists the answering provider’s external ids', async () => {
    const tvdb = provider('tvdb', async () => ({
      title: 'Silo',
      providerName: 'tvdb',
      externalIds: { tvdb: '121361', imdb: 'tt0944947' },
    }));
    const { svc, prisma } = build([tvdb]);

    await svc.fetchMetadata('i1');

    const saved = prisma.mediaExternalId.upsert.mock.calls.map((c: any[]) => c[0].create.provider);
    expect(saved).toEqual(expect.arrayContaining(['tvdb', 'imdb']));
  });

  it('runs fully offline when no provider is configured — the local NFO still carries the item', async () => {
    const { svc, prisma } = build([]); // empty chain

    await expect(svc.fetchMetadata('i1')).resolves.toBeDefined();

    // Falls back to the parsed title rather than throwing or writing nothing.
    expect(prisma.mediaMetadata.upsert.mock.calls[0][0].create.title).toBe('Silo');
  });
});
