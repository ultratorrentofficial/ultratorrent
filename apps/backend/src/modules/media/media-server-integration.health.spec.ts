import { MediaServerIntegrationService } from './media-server-integration.service';
import * as providers from './media-server-provider';

/**
 * Regression for the "dead server still reported online" bug.
 *
 * A Plex server was down for four days. The library refresh runs from the download
 * pipeline, so it fired on every completed torrent and failed 479 times in a row —
 * but nothing on that path wrote `status`, so the row stayed at `online` and the
 * dashboard showed a healthy server the entire time. Every path that actually talks
 * to the server must now record what it learned.
 */
describe('MediaServerIntegrationService health persistence', () => {
  const cipher = { encrypt: (v: string) => v, decrypt: (v: string) => v } as any;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;

  const row = {
    id: 'i1',
    name: 'Plex',
    kind: 'plex',
    isEnabled: true,
    config: { baseUrl: 'http://plex.local:32400', token: 't' },
    lastRefreshAt: null,
    status: 'online', // the stale value the bug left standing
    lastHealthCheckAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const makePrisma = () => ({
    mediaServerIntegration: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue({ ...row, lastRefreshAt: new Date() }),
    },
  });

  const stubProvider = (impl: Partial<providers.MediaServerProvider>) =>
    jest.spyOn(providers, 'getMediaServerProvider').mockReturnValue({
      kind: 'plex',
      capabilities: () => ({
        libraries: true, recentlyAdded: true, sessions: true, watchHistory: true, refresh: true,
      }),
      testConnection: jest.fn(),
      refreshLibrary: jest.fn(),
      getServerInfo: jest.fn(),
      getLibraries: jest.fn(),
      getSessions: jest.fn(),
      getRecentlyAdded: jest.fn(),
      getWatchHistory: jest.fn(),
      ...impl,
    } as any);

  afterEach(() => jest.restoreAllMocks());

  const dataOf = (prisma: any) => prisma.mediaServerIntegration.update.mock.calls.at(-1)[0].data;

  it('marks the server OFFLINE when a refresh cannot reach it (the 479-failure case)', async () => {
    const prisma = makePrisma();
    stubProvider({ refreshLibrary: jest.fn().mockRejectedValue(new Error('fetch failed')) });
    const svc = new MediaServerIntegrationService(prisma as any, cipher, audit);

    await expect(svc.refresh('i1')).rejects.toThrow(/fetch failed/);

    const data = dataOf(prisma);
    expect(data.status).toBe('offline');
    expect(data.lastHealthCheckAt).toBeInstanceOf(Date);
  });

  it('marks the server ONLINE again when a refresh succeeds', async () => {
    const prisma = makePrisma();
    stubProvider({ refreshLibrary: jest.fn().mockResolvedValue(undefined) });
    const svc = new MediaServerIntegrationService(prisma as any, cipher, audit);

    await svc.refresh('i1');

    const data = dataOf(prisma);
    expect(data.status).toBe('online');
    expect(data.lastRefreshAt).toBeInstanceOf(Date);
    expect(data.lastHealthCheckAt).toBeInstanceOf(Date);
  });

  it('records health from a connection test, both ways', async () => {
    for (const ok of [true, false]) {
      const prisma = makePrisma();
      stubProvider({ testConnection: jest.fn().mockResolvedValue({ ok, message: 'm' }) });
      const svc = new MediaServerIntegrationService(prisma as any, cipher, audit);

      await svc.test('i1');
      expect(dataOf(prisma).status).toBe(ok ? 'online' : 'offline');
    }
  });

  it('healthCheck records offline when the provider THROWS, instead of leaving the stale status', async () => {
    const prisma = makePrisma();
    stubProvider({ getServerInfo: jest.fn().mockRejectedValue(new Error('bad baseUrl')) });
    const svc = new MediaServerIntegrationService(prisma as any, cipher, audit);

    const info = await svc.healthCheck('i1'); // must NOT throw
    expect(info.reachable).toBe(false);
    expect(info.message).toMatch(/bad baseUrl/);
    expect(dataOf(prisma).status).toBe('offline');
  });

  it('a failed probe does not wipe the version/platform we last learned', async () => {
    const prisma = makePrisma();
    stubProvider({
      getServerInfo: jest.fn().mockResolvedValue({
        kind: 'plex', reachable: false, capabilities: {}, message: 'down',
      }),
    });
    const svc = new MediaServerIntegrationService(prisma as any, cipher, audit);

    await svc.healthCheck('i1');

    const data = dataOf(prisma);
    expect(data.status).toBe('offline');
    expect(data).not.toHaveProperty('serverVersion');
    expect(data).not.toHaveProperty('platform');
  });

  it('a bookkeeping failure never masks the real refresh error', async () => {
    const prisma = makePrisma();
    prisma.mediaServerIntegration.update.mockRejectedValue(new Error('db down'));
    stubProvider({ refreshLibrary: jest.fn().mockRejectedValue(new Error('fetch failed')) });
    const svc = new MediaServerIntegrationService(prisma as any, cipher, audit);

    // The caller must still see "fetch failed", not "db down".
    await expect(svc.refresh('i1')).rejects.toThrow(/fetch failed/);
  });
});
