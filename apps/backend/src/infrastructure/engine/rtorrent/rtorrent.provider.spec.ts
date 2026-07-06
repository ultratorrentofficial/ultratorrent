import { TorrentState, TorrentPriority } from '@ultratorrent/shared';
import { RTorrentProvider } from './rtorrent.provider';

describe('RTorrentProvider mapping', () => {
  function providerWithRows(rows: unknown[]) {
    const provider = new RTorrentProvider({
      kind: 'rtorrent',
      engineId: 'engine-1',
      mode: 'scgi-tcp',
      host: '127.0.0.1',
      port: 5000,
    });
    // Replace the transport with a deterministic stub.
    (provider as any).transport = {
      call: jest.fn(async (method: string) => {
        if (method === 'd.multicall2') return rows;
        if (method === 'system.client_version') return '0.9.8';
        return 0;
      }),
    };
    return provider;
  }

  const downloadingRow = [
    'ABC123', 'Ubuntu ISO', 1000, 500, 200, 100, 50, 400, 500,
    1, 1, 0, 1, 0, '', 2, '/downloads', 'linux', 1700000000, 0, 5, 3, 8, 0,
  ];

  it('normalizes a downloading torrent', async () => {
    const provider = providerWithRows([downloadingRow]);
    const [t] = await provider.listTorrents();
    expect(t.hash).toBe('abc123'); // lowercased
    expect(t.name).toBe('Ubuntu ISO');
    expect(t.progress).toBeCloseTo(0.5);
    expect(t.ratio).toBeCloseTo(0.4); // per-mille / 1000
    expect(t.eta).toBe(5); // 500 left / 100 B/s
    expect(t.state).toBe(TorrentState.DOWNLOADING);
    expect(t.priority).toBe(TorrentPriority.NORMAL);
    expect(t.engineId).toBe('engine-1');
    expect(t.isPrivate).toBe(false);
  });

  it('classifies a completed, active torrent as seeding', async () => {
    const seedingRow = [
      'DEF456', 'Debian', 1000, 1000, 1000, 0, 80, 2500, 0,
      1, 1, 1, 1, 0, '', 2, '/downloads', '', 1700000000, 1700000100, 2, 10, 12, 1,
    ];
    const provider = providerWithRows([seedingRow]);
    const [t] = await provider.listTorrents();
    expect(t.state).toBe(TorrentState.SEEDING);
    expect(t.progress).toBe(1);
    expect(t.eta).toBe(0);
    expect(t.isPrivate).toBe(true);
    expect(t.completedAt).not.toBeNull();
  });

  it('scopes removeTorrentAndData to d.base_path, never d.directory', async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const provider = providerWithRows([]);
    (provider as any).transport = {
      call: jest.fn(async (method: string, params: unknown[] = []) => {
        calls.push({ method, params });
        if (method === 'd.base_path')
          return '/downloads/movies/film.mkv'; // single torrent's own path
        return 0;
      }),
    };

    await provider.removeTorrentAndData('abc');

    // Must read base_path, NOT directory (which could be the shared root).
    expect(calls.some((c) => c.method === 'd.base_path')).toBe(true);
    expect(calls.some((c) => c.method === 'd.directory')).toBe(false);
    // Erases from session and rm -rf's exactly the torrent's base_path.
    expect(calls.some((c) => c.method === 'd.erase')).toBe(true);
    const rm = calls.find((c) => c.method === 'execute.throw');
    expect(rm?.params).toEqual(['', 'rm', '-rf', '/downloads/movies/film.mkv']);
  });

  it('refuses to delete a filesystem-root-level base_path', async () => {
    const calls: string[] = [];
    const provider = providerWithRows([]);
    (provider as any).transport = {
      call: jest.fn(async (method: string) => {
        calls.push(method);
        if (method === 'd.base_path') return '/'; // pathological
        return 0;
      }),
    };
    await provider.removeTorrentAndData('abc');
    expect(calls).toContain('d.erase');
    expect(calls).not.toContain('execute.throw'); // guard blocks the rm
  });

  describe('add confirmation (no phantom downloads)', () => {
    const HASH = 'e6e045969cbd8d8744f3589cba20b2440a009380';
    const MAGNET = `magnet:?xt=urn:btih:${HASH.toUpperCase()}`;
    // A well-formed d.multicall2 row whose d.hash (index 0) is our target.
    const row = [
      HASH.toUpperCase(), 'Interview.With.The.Vampire.S03E05', 1000, 0, 0, 0, 0, 0, 1000,
      1, 1, 0, 1, 0, '', 2, '/downloads', '', 1700000000, 0, 0, 0, 0, 0,
    ];

    it('resolves with the info-hash once rtorrent registers the torrent', async () => {
      const provider = providerWithRows([row]); // appears on first poll
      await expect(provider.addMagnet(MAGNET)).resolves.toBe(HASH);
    });

    it('throws when rtorrent never registers the torrent (was a false success)', async () => {
      const provider = providerWithRows([]); // load.* "succeeds" but nothing loads
      (provider as any).addConfirmAttempts = 2;
      (provider as any).addConfirmIntervalMs = 1;
      await expect(provider.addMagnet(MAGNET)).rejects.toThrow(/never registered/i);
    });

    it('waits for a slightly delayed registration', async () => {
      let polls = 0;
      const provider = providerWithRows([]);
      (provider as any).addConfirmAttempts = 5;
      (provider as any).addConfirmIntervalMs = 1;
      (provider as any).transport = {
        call: jest.fn(async (method: string) => {
          if (method === 'd.multicall2') return ++polls >= 2 ? [row] : [];
          return 0;
        }),
      };
      await expect(provider.addMagnet(MAGNET)).resolves.toBe(HASH);
      expect(polls).toBeGreaterThanOrEqual(2);
    });
  });

  it('classifies a stopped torrent', async () => {
    const stoppedRow = [
      'AAA', 'X', 100, 10, 0, 0, 0, 0, 90,
      0, 0, 0, 0, 0, '', 2, '/d', '', 0, 0, 0, 0, 0, 0,
    ];
    const provider = providerWithRows([stoppedRow]);
    const [t] = await provider.listTorrents();
    expect(t.state).toBe(TorrentState.STOPPED);
    expect(t.eta).toBeNull(); // no download rate
  });
});
