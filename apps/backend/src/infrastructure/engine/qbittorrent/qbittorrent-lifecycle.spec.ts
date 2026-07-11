import { QbittorrentProvider, compareApiVersion } from './qbittorrent.provider';

/** Build a provider with its HTTP client stubbed out. */
function build(webapiVersion: string | Error) {
  const client = {
    getText: jest.fn(() =>
      webapiVersion instanceof Error ? Promise.reject(webapiVersion) : Promise.resolve(webapiVersion),
    ),
    postForm: jest.fn().mockResolvedValue(undefined),
  };
  const provider = new QbittorrentProvider({ kind: 'qbittorrent', engineId: 'e1', baseUrl: 'http://q:8080' } as any);
  (provider as any).client = client;
  return { provider, client };
}

const paths = (client: any) => client.postForm.mock.calls.map((c: any[]) => c[0]);

describe('compareApiVersion', () => {
  it('orders versions numerically, not lexically', () => {
    expect(compareApiVersion('2.15.1', '2.11.0')).toBeGreaterThan(0); // 15 > 11, not "1" < "1"
    expect(compareApiVersion('2.9.0', '2.11.0')).toBeLessThan(0); // 9 < 11
    expect(compareApiVersion('2.11.0', '2.11.0')).toBe(0);
  });

  it('treats a missing component as zero', () => {
    expect(compareApiVersion('2.11', '2.11.0')).toBe(0);
  });

  it('does not throw on junk', () => {
    expect(compareApiVersion('', '2.11.0')).toBeLessThan(0);
    expect(compareApiVersion('not-a-version', '2.11.0')).toBeLessThan(0);
  });
});

describe('QbittorrentProvider lifecycle — qBittorrent 5 renamed pause/resume to stop/start', () => {
  it('uses stop/start on a 5.x server (WebAPI >= 2.11), where pause/resume 404', async () => {
    const { provider, client } = build('2.15.1'); // the version on ehr-qnap

    await provider.pauseTorrent('ABC');
    await provider.resumeTorrent('ABC');
    await provider.stopTorrent('ABC');
    await provider.startTorrent('ABC');

    expect(paths(client)).toEqual([
      '/torrents/stop',
      '/torrents/start',
      '/torrents/stop',
      '/torrents/start',
    ]);
  });

  it('still uses pause/resume on an older server', async () => {
    const { provider, client } = build('2.8.3');

    await provider.pauseTorrent('ABC');
    await provider.resumeTorrent('ABC');

    expect(paths(client)).toEqual(['/torrents/pause', '/torrents/resume']);
  });

  it('falls back to the legacy pair when the version cannot be read', async () => {
    const { provider, client } = build(new Error('connection refused'));

    await provider.pauseTorrent('ABC');

    expect(paths(client)).toEqual(['/torrents/pause']);
  });

  it('lowercases the hash and reads the version only once', async () => {
    const { provider, client } = build('2.15.1');

    await provider.pauseTorrent('ABC');
    await provider.pauseTorrent('DEF');

    expect(client.getText).toHaveBeenCalledTimes(1); // cached per provider instance
    expect(client.postForm.mock.calls[0][1]).toEqual({ hashes: 'abc' });
  });
});
