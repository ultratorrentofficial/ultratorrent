import { EngineService } from './engine.service';

describe('EngineService', () => {
  const makeEngineRow = (over: Record<string, unknown> = {}) => ({
    id: 'e1',
    name: 'Local rTorrent',
    kind: 'rtorrent',
    isDefault: true,
    isEnabled: true,
    config: { mode: 'scgi-tcp', host: 'rtorrent', port: 5000, timeoutMs: 10000 },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  describe('list', () => {
    it('exposes non-secret transport fields for prefilling the edit form', async () => {
      const prisma = {
        torrentEngine: { findMany: jest.fn().mockResolvedValue([makeEngineRow()]) },
      } as any;
      const svc = new EngineService(prisma, {} as any, {} as any);

      const [row] = await svc.list();

      expect(row).toEqual({
        id: 'e1',
        name: 'Local rTorrent',
        kind: 'rtorrent',
        isDefault: true,
        isEnabled: true,
        mode: 'scgi-tcp',
        host: 'rtorrent',
        port: 5000,
        socketPath: undefined,
        url: undefined,
        timeoutMs: 10000,
      });
    });
  });

  describe('test', () => {
    it('returns the provider health when the connection succeeds', async () => {
      const health = {
        online: true,
        latencyMs: 12,
        version: '0.9.8',
        error: null,
        checkedAt: '2026-07-01T00:00:00.000Z',
      };
      const factory = {
        create: jest.fn().mockReturnValue({ healthCheck: jest.fn().mockResolvedValue(health) }),
      } as any;
      const svc = new EngineService({} as any, {} as any, factory);

      const res = await svc.test({
        kind: 'rtorrent',
        config: { mode: 'scgi-tcp', host: 'rtorrent', port: 5000 },
      });

      expect(res).toBe(health);
      expect(factory.create).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'rtorrent', host: 'rtorrent', port: 5000 }),
      );
    });

    it('degrades to an offline result when the engine kind is unimplemented', async () => {
      const factory = {
        create: jest.fn(() => {
          throw new Error('Engine "qbittorrent" is planned but not yet implemented');
        }),
      } as any;
      const svc = new EngineService({} as any, {} as any, factory);

      const res = await svc.test({
        kind: 'qbittorrent',
        config: { mode: 'http', url: 'http://x' },
      });

      expect(res.online).toBe(false);
      expect(res.error).toMatch(/not yet implemented/);
      expect(res.latencyMs).toBeNull();
    });
  });
});
