import { FilePriority, TorrentState } from '@ultratorrent/shared';
import { QbittorrentProvider } from './qbittorrent.provider';
import { QbittorrentApi } from '../../qbittorrent/qbittorrent-client';

/** Type a getJson stub against the generic `<T>() => Promise<T>` signature. */
function json(value: unknown): QbittorrentApi['getJson'] {
  return jest.fn(async () => value) as unknown as QbittorrentApi['getJson'];
}

function mockClient(overrides: Partial<QbittorrentApi> = {}): QbittorrentApi {
  return {
    login: jest.fn(async () => undefined),
    logout: jest.fn(async () => undefined),
    getText: jest.fn(async () => '4.6.5'),
    getJson: json([]),
    postForm: jest.fn(async () => 'Ok.'),
    postMultipart: jest.fn(async () => 'Ok.'),
    ...overrides,
  };
}

function provider(client: QbittorrentApi): QbittorrentProvider {
  const p = new QbittorrentProvider(client);
  (p as unknown as { addConfirmAttempts: number }).addConfirmAttempts = 2;
  (p as unknown as { addConfirmIntervalMs: number }).addConfirmIntervalMs = 1;
  return p;
}

const HASH = 'e6e045969cbd8d8744f3589cba20b2440a009380';

const infoRow = {
  hash: HASH.toUpperCase(),
  name: 'Ubuntu 24.04',
  state: 'stalledUP',
  progress: 1,
  size: 1000,
  downloaded: 1000,
  uploaded: 2500,
  ratio: 2.5,
  dlspeed: 0,
  upspeed: 50,
  eta: 8640000, // infinite sentinel
  num_seeds: 3,
  num_complete: 10,
  num_leechs: 1,
  num_incomplete: 4,
  category: 'linux',
  save_path: '/downloads',
  added_on: 1700000000,
  completion_on: 1700003600,
  private: true,
};

describe('QbittorrentProvider', () => {
  describe('mapping', () => {
    it('maps a seeding torrent, treating the infinite-eta sentinel as null', async () => {
      const client = mockClient({ getJson: json([infoRow]) });
      const [t] = await provider(client).listTorrents();
      expect(t.hash).toBe(HASH); // lowercased
      expect(t.state).toBe(TorrentState.SEEDING);
      expect(t.progress).toBe(1);
      expect(t.ratio).toBe(2.5);
      expect(t.eta).toBeNull();
      expect(t.label).toBe('linux');
      expect(t.isPrivate).toBe(true);
      expect(t.seedsConnected).toBe(3);
      expect(t.addedAt).toBe(new Date(1700000000 * 1000).toISOString());
      expect(t.completedAt).toBe(new Date(1700003600 * 1000).toISOString());
    });

    it('maps qBittorrent file priorities (0/1/6/7) to SKIP/NORMAL/HIGH', async () => {
      const client = mockClient({
        getJson: json([
          { index: 0, name: 'a', size: 100, progress: 1, priority: 0 },
          { index: 1, name: 'b', size: 100, progress: 0.5, priority: 1 },
          { index: 2, name: 'c', size: 100, progress: 0, priority: 6 },
          { index: 3, name: 'd', size: 100, progress: 0, priority: 7 },
        ]),
      });
      const files = await provider(client).getFiles(HASH);
      expect(files.map((f) => f.priority)).toEqual([
        FilePriority.SKIP,
        FilePriority.NORMAL,
        FilePriority.HIGH,
        FilePriority.HIGH,
      ]);
      expect(files[0].downloaded).toBe(100);
      expect(files[1].downloaded).toBe(50);
    });

    it('drops DHT/PeX/LSD pseudo-trackers and maps status codes', async () => {
      const client = mockClient({
        getJson: json([
          { url: '** [DHT] **', tier: -1, status: 2 },
          { url: 'http://tr.example/announce', tier: 0, status: 2, num_seeds: 5, num_leeches: 2 },
          { url: 'http://dead.example/announce', tier: 1, status: 4, msg: 'timed out' },
        ]),
      });
      const trackers = await provider(client).getTrackers(HASH);
      expect(trackers).toHaveLength(2);
      expect(trackers[0]).toMatchObject({ status: 'working', seeders: 5, leechers: 2 });
      expect(trackers[1]).toMatchObject({ status: 'error', message: 'timed out' });
    });
  });

  describe('adding', () => {
    it('addMagnet derives the hash, posts urls, and confirms', async () => {
      const post = jest.fn(async () => 'Ok.');
      const client = mockClient({
        postMultipart: post,
        getJson: json([infoRow]), // appears immediately
      });
      const magnet = `magnet:?xt=urn:btih:${HASH.toUpperCase()}`;
      await expect(provider(client).addMagnet(magnet)).resolves.toBe(HASH);
      expect(post).toHaveBeenCalledWith(
        '/torrents/add',
        expect.objectContaining({ urls: magnet }),
      );
    });

    it('a magnet that never registers resolves as accepted/pending (does NOT throw)', async () => {
      const client = mockClient({
        postMultipart: jest.fn(async () => 'Ok.'),
        getJson: json([]), // never appears within the window
      });
      const magnet = `magnet:?xt=urn:btih:${HASH.toUpperCase()}`;
      await expect(provider(client).addMagnet(magnet)).resolves.toBe(HASH);
    });

    it('a .torrent file that never registers throws (real failure)', async () => {
      const client = mockClient({
        postMultipart: jest.fn(async () => 'Ok.'),
        getJson: json([]),
      });
      const pieces = Buffer.alloc(20, 0);
      const info = Buffer.concat([
        Buffer.from('d6:lengthi1e4:name4:test12:piece lengthi16384e6:pieces20:'),
        pieces,
        Buffer.from('e'),
      ]);
      const torrent = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]);
      await expect(provider(client).addTorrentFile(torrent)).rejects.toThrow(
        /never registered/i,
      );
    });

    it('turns a "Fails." add response into an error', async () => {
      const client = mockClient({
        postMultipart: jest.fn(async () => 'Fails.'),
        getJson: json([infoRow]),
      });
      const magnet = `magnet:?xt=urn:btih:${HASH.toUpperCase()}`;
      await expect(provider(client).addMagnet(magnet)).rejects.toThrow(/Fails/i);
    });
  });

  describe('actions', () => {
    it('removeTorrentAndData deletes with deleteFiles=true', async () => {
      const post = jest.fn(async () => 'Ok.');
      const client = mockClient({ postForm: post });
      await provider(client).removeTorrentAndData(HASH.toUpperCase());
      expect(post).toHaveBeenCalledWith('/torrents/delete', {
        hashes: HASH,
        deleteFiles: 'true',
      });
    });

    it('setFilePriority maps HIGH to the qBittorrent scale (6)', async () => {
      const post = jest.fn(async () => 'Ok.');
      const client = mockClient({ postForm: post });
      await provider(client).setFilePriority(HASH, 2, FilePriority.HIGH);
      expect(post).toHaveBeenCalledWith('/torrents/filePrio', {
        hash: HASH,
        id: 2,
        priority: 6,
      });
    });

    it('healthCheck reports online with the version', async () => {
      const client = mockClient({ getText: jest.fn(async () => 'v4.6.5') });
      const health = await provider(client).healthCheck();
      expect(health.online).toBe(true);
      expect(health.version).toBe('4.6.5');
    });
  });
});
