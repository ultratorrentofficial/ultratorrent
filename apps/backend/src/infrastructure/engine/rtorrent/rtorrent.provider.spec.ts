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
    (provider as any).removeConfirmIntervalMs = 0;
    (provider as any).transport = {
      call: jest.fn(async (method: string, params: unknown[] = []) => {
        calls.push({ method, params });
        if (method === 'd.base_path')
          return '/downloads/movies/film.mkv'; // single torrent's own path
        if (method === 'd.multicall2') return []; // erase confirmed: gone
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
    (provider as any).removeConfirmIntervalMs = 0;
    (provider as any).transport = {
      call: jest.fn(async (method: string) => {
        calls.push(method);
        if (method === 'd.base_path') return '/'; // pathological
        if (method === 'd.multicall2') return []; // erase confirmed: gone
        return 0;
      }),
    };
    await provider.removeTorrentAndData('abc');
    expect(calls).toContain('d.erase');
    expect(calls).not.toContain('execute.throw'); // guard blocks the rm
  });

  describe('removeTorrent — reliable erase (rtorrent drops d.erase under load)', () => {
    const HASH = 'abcabcabcabcabcabcabcabcabcabcabcabcabca';
    const row = [HASH.toUpperCase()];

    it('retries d.erase until the torrent is actually gone', async () => {
      let erases = 0;
      let present = true;
      const provider = providerWithRows([]);
      (provider as any).removeConfirmIntervalMs = 0;
      (provider as any).transport = {
        call: jest.fn(async (method: string) => {
          if (method === 'd.erase') {
            erases++;
            if (erases >= 2) present = false; // first erase is silently dropped
            return 0;
          }
          if (method === 'd.multicall2') return present ? [row] : [];
          return 0;
        }),
      };
      await expect(provider.removeTorrent(HASH)).resolves.toBeUndefined();
      expect(erases).toBe(2); // one dropped, one that stuck
    });

    it('throws when the torrent never leaves (so the caller logs a real failure)', async () => {
      const provider = providerWithRows([]);
      (provider as any).removeConfirmAttempts = 3;
      (provider as any).removeConfirmIntervalMs = 0;
      (provider as any).transport = {
        call: jest.fn(async (method: string) => {
          if (method === 'd.multicall2') return [row]; // always still present
          return 0;
        }),
      };
      await expect(provider.removeTorrent(HASH)).rejects.toThrow(/still loaded/i);
    });

    it('succeeds on the first try when the erase takes immediately', async () => {
      let erases = 0;
      const provider = providerWithRows([]);
      (provider as any).removeConfirmIntervalMs = 0;
      (provider as any).transport = {
        call: jest.fn(async (method: string) => {
          if (method === 'd.erase') erases++;
          if (method === 'd.multicall2') return []; // gone right away
          return 0;
        }),
      };
      await provider.removeTorrent(HASH);
      expect(erases).toBe(1);
    });
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

    it('a magnet that is not yet registered resolves as accepted/pending (metadata still resolving), does NOT throw', async () => {
      // rtorrent doesn't list a magnet's hash until it fetches metadata from
      // DHT/peers (minutes, not the ~6s window), so a timeout must not be a
      // failure — the add was accepted and the info-hash is known.
      const provider = providerWithRows([]); // hash never appears within the window
      (provider as any).addConfirmAttempts = 2;
      (provider as any).addConfirmIntervalMs = 1;
      await expect(provider.addMagnet(MAGNET)).resolves.toBe(HASH);
    });

    it('a .torrent FILE that never registers still throws (real failure — metadata is present, so it should register fast)', async () => {
      const provider = providerWithRows([]); // load.* "succeeds" but nothing loads
      (provider as any).addConfirmAttempts = 2;
      (provider as any).addConfirmIntervalMs = 1;
      // Minimal valid bencoded torrent: d4:info<info>e, info keys sorted.
      const pieces = Buffer.alloc(20, 0);
      const info = Buffer.concat([
        Buffer.from('d6:lengthi1e4:name4:test12:piece lengthi16384e6:pieces20:'),
        pieces,
        Buffer.from('e'),
      ]);
      const torrent = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]);
      await expect(provider.addTorrentFile(torrent)).rejects.toThrow(/never registered/i);
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
