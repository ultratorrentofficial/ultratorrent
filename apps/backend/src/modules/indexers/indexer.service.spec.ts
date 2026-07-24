import { IndexerService } from './indexer.service';
import type { IndexerCandidate } from './torznab-client';

function build() {
  const store: any[] = [];
  const prisma = {
    indexer: {
      findMany: jest.fn(async ({ where }: any = {}) =>
        store.filter((r) => (where?.enabled === undefined ? true : r.enabled === where.enabled)),
      ),
      findUnique: jest.fn(async ({ where }: any) => store.find((r) => r.id === where.id) ?? null),
      create: jest.fn(async ({ data }: any) => { const row = { id: 'ix_' + store.length, capabilities: null, ...data }; store.push(row); return row; }),
      update: jest.fn(async ({ where, data }: any) => { const row = store.find((r) => r.id === where.id); Object.assign(row, data); return row; }),
      delete: jest.fn(async ({ where }: any) => { const i = store.findIndex((r) => r.id === where.id); return store.splice(i, 1)[0]; }),
    },
  };
  const cipher = { encrypt: jest.fn((s: string) => `enc:${s}`), decrypt: jest.fn((s: string) => s.replace(/^enc:/, '')) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const client = { search: jest.fn(), fetchCaps: jest.fn() };
  const svc = new IndexerService(prisma as any, cipher as any, audit as any, client as any);
  return { svc, prisma, cipher, audit, client, store };
}

const candidate = (over: Partial<IndexerCandidate>): IndexerCandidate => ({
  indexerId: 'ix', indexerName: 'ix', title: 'The Show S01E01 1080p', downloadUrl: 'magnet:?xt=urn:btih:aaa',
  infoHash: null, sizeBytes: null, seeders: null, categories: [], ...over,
});

describe('IndexerService — secret handling', () => {
  it('encrypts the apiKey on create and masks it in the response', async () => {
    const { svc, cipher } = build();
    const res = await svc.create({ name: 'A', baseUrl: 'https://a/api', apiKey: 'topsecret' } as any);
    expect(cipher.encrypt).toHaveBeenCalledWith('topsecret');
    expect(res.apiKey).toBe('••••••••'); // never the plaintext or ciphertext
  });

  it('reports an empty apiKey mask when none is stored', async () => {
    const { svc } = build();
    const res = await svc.create({ name: 'B', baseUrl: 'https://b/api' } as any);
    expect(res.apiKey).toBe('');
  });

  it('keeps the existing apiKey when update sends the mask placeholder', async () => {
    const { svc, cipher } = build();
    const created = await svc.create({ name: 'C', baseUrl: 'https://c/api', apiKey: 'orig' } as any);
    cipher.encrypt.mockClear();
    await svc.update(created.id, { apiKey: '••••••••', name: 'C2' } as any);
    expect(cipher.encrypt).not.toHaveBeenCalled(); // secret untouched
  });

  it('re-encrypts when update sends a new apiKey', async () => {
    const { svc, cipher } = build();
    const created = await svc.create({ name: 'D', baseUrl: 'https://d/api', apiKey: 'orig' } as any);
    cipher.encrypt.mockClear();
    await svc.update(created.id, { apiKey: 'rotated' } as any);
    expect(cipher.encrypt).toHaveBeenCalledWith('rotated');
  });
});

describe('IndexerService.searchAll', () => {
  it('dedups across indexers by infoHash, keeps priority order, filters minSeeders, isolates failures', async () => {
    const { svc, client, store } = build();
    // Two enabled indexers, ix-hi (priority 10) and ix-lo (priority 50), one disabled, one that throws.
    store.push(
      { id: 'hi', name: 'hi', enabled: true, priority: 10, categories: [5000], timeoutMs: 15000, minSeeders: 5, capabilities: null, config: {} },
      { id: 'lo', name: 'lo', enabled: true, priority: 50, categories: [5000], timeoutMs: 15000, minSeeders: null, capabilities: null, config: {} },
      { id: 'boom', name: 'boom', enabled: true, priority: 60, categories: [5000], timeoutMs: 15000, minSeeders: null, capabilities: null, config: {} },
    );
    client.search.mockImplementation(async (c: any) => {
      if (c.id === 'hi') return [
        candidate({ title: 'The Show S01E01 1080p-GRP', infoHash: 'dup', seeders: 100 }),
        candidate({ title: 'The Show S01E01 720p-GRP', infoHash: 'lowseed', seeders: 2 }), // filtered: < minSeeders 5
      ];
      if (c.id === 'lo') return [
        candidate({ title: 'The Show S01E01 1080p-GRP', infoHash: 'dup', seeders: 100 }), // duplicate of hi's, dropped
        candidate({ title: 'The Show S01E01 2160p-GRP', infoHash: 'unique', seeders: 40 }),
      ];
      throw new Error('indexer down');
    });
    const results = await svc.searchAll({ q: 'The Show', season: 1, ep: 1 });
    const hashes = results.map((r) => r.infoHash);
    expect(hashes).toContain('dup');
    expect(hashes).toContain('unique');
    expect(hashes).not.toContain('lowseed'); // minSeeders filter
    expect(hashes.filter((h) => h === 'dup')).toHaveLength(1); // cross-indexer dedup
    // sorted by seeders desc
    expect(results[0].seeders).toBe(100);
  });

  it('reports run health so a total outage is distinguishable from an empty catalogue', async () => {
    // The 9-1-1 case: every enabled indexer is in failure backoff. searchAll returns
    // [] either way, so only queried/failed can tell "nothing could look" from
    // "nothing exists" — and the caller records a different state for each.
    const { svc, client, store } = build();
    store.push(
      { id: 'a', name: 'EZTV', enabled: true, priority: 10, categories: [5000], timeoutMs: 15000, minSeeders: null, capabilities: null, config: {} },
      { id: 'b', name: 'TPB', enabled: true, priority: 20, categories: [5000], timeoutMs: 15000, minSeeders: null, capabilities: null, config: {} },
    );
    client.search.mockRejectedValue(new Error('HTTP 429'));

    const run = await svc.searchAllDetailed({ q: '9-1-1', season: 9, ep: 1 });

    expect(run.candidates).toEqual([]);
    expect(run.queried).toBe(2);
    expect(run.failed).toBe(2); // every indexer down
    expect(run.failures.map((f) => f.name).sort()).toEqual(['EZTV', 'TPB']);
    expect(run.failures[0].message).toContain('429');
  });

  it('a genuinely empty answer is queried>0 with failed=0', async () => {
    const { svc, client, store } = build();
    store.push({ id: 'a', name: 'showRSS', enabled: true, priority: 10, categories: [5000], timeoutMs: 15000, minSeeders: null, capabilities: null, config: {} });
    client.search.mockResolvedValue([]);

    const run = await svc.searchAllDetailed({ q: '9-1-1', season: 1, ep: 1 });

    expect(run.candidates).toEqual([]);
    expect(run.queried).toBe(1);
    expect(run.failed).toBe(0); // the indexer answered — there is genuinely nothing
  });

  it('a partial outage still yields the surviving indexer’s candidates', async () => {
    const { svc, client, store } = build();
    store.push(
      { id: 'a', name: 'down', enabled: true, priority: 10, categories: [5000], timeoutMs: 15000, minSeeders: null, capabilities: null, config: {} },
      { id: 'b', name: 'up', enabled: true, priority: 20, categories: [5000], timeoutMs: 15000, minSeeders: null, capabilities: null, config: {} },
    );
    client.search.mockImplementation(async (c: any) => {
      if (c.id === 'a') throw new Error('HTTP 429');
      return [candidate({ title: 'The Show S01E01 1080p-GRP', infoHash: 'ok', seeders: 9 })];
    });

    const run = await svc.searchAllDetailed({ q: 'The Show', season: 1, ep: 1 });

    expect(run.candidates.map((c) => c.infoHash)).toEqual(['ok']);
    expect(run.queried).toBe(2);
    expect(run.failed).toBe(1); // NOT a total outage — the caller must not report failed
  });

  it('uses plain search when an indexer advertises tvSearch=false', async () => {
    const { svc, client, store } = build();
    store.push({ id: 'x', name: 'x', enabled: true, priority: 10, categories: [5000], timeoutMs: 15000, minSeeders: null, capabilities: { tvSearch: false }, config: {} });
    client.search.mockResolvedValue([]);
    await svc.searchAll({ q: 'The Show', season: 1, ep: 1 });
    expect(client.search).toHaveBeenCalledWith(expect.anything(), expect.anything(), false);
  });
});

describe('IndexerService.testConnection', () => {
  it('persists caps + ok status on success', async () => {
    const { svc, client, store } = build();
    store.push({ id: 't', name: 't', enabled: true, priority: 10, categories: [5000], timeoutMs: 15000, config: {}, capabilities: null });
    client.fetchCaps.mockResolvedValue({ tvSearch: true, movieSearch: false, supportedParams: [], categories: [] });
    const res = await svc.testConnection('t');
    expect(res.capabilities).toMatchObject({ tvSearch: true });
    expect(res.indexer.status).toBe('ok');
  });

  it('records error status on failure without throwing', async () => {
    const { svc, client, store } = build();
    store.push({ id: 't', name: 't', enabled: true, priority: 10, categories: [5000], timeoutMs: 15000, config: {}, capabilities: null });
    client.fetchCaps.mockRejectedValue(new Error('401 unauthorized'));
    const res = await svc.testConnection('t');
    expect(res.indexer.status).toBe('error');
    expect((res as any).error).toContain('401');
  });
});
