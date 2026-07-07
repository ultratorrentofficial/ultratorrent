import { IndexerConnection, TorznabClient } from './torznab-client';

const conn: IndexerConnection = {
  id: 'ix1',
  name: 'Test',
  implementation: 'torznab',
  baseUrl: 'https://indexer.example/api',
  apiKey: 'secret',
  categories: [5000, 5030, 5040],
  timeoutMs: 15000,
};

function mockFetch(xml: string) {
  (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => xml });
}

const feed = (items: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
   <rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
   <channel><title>results</title>${items}</channel></rss>`;

describe('TorznabClient.search', () => {
  const client = new TorznabClient();

  it('normalizes a magnet-only item (magnet, size, seeders, infohash)', async () => {
    mockFetch(feed(`
      <item>
        <title>The Show S01E02 1080p WEB-DL x265-GRP</title>
        <link>magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12&amp;dn=x</link>
        <torznab:attr name="seeders" value="120"/>
        <torznab:attr name="size" value="1500000000"/>
        <torznab:attr name="category" value="5030"/>
      </item>`));
    const [c] = await client.search(conn, { q: 'The Show', season: 1, ep: 2 });
    expect(c.title).toBe('The Show S01E02 1080p WEB-DL x265-GRP');
    expect(c.downloadUrl?.startsWith('magnet:')).toBe(true);
    expect(c.infoHash).toBe('abcdef1234567890abcdef1234567890abcdef12');
    expect(c.sizeBytes).toBe(1500000000);
    expect(c.seeders).toBe(120);
    expect(c.categories).toContain(5030);
  });

  it('parses a Prowlarr/Jackett feed advertised as <rss version="1.0"> (rss-parser would otherwise reject it)', async () => {
    // Prowlarr and Jackett always emit version="1.0"; rss-parser only accepts
    // "2.x" and throws "Feed not recognized as RSS 1 or 2" without normalization.
    mockFetch(`<?xml version="1.0" encoding="UTF-8"?>
      <rss version="1.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed">
      <channel><title>Prowlarr</title>
        <item>
          <title>The Show S01E05 1080p WEB-DL x265-GRP</title>
          <link>magnet:?xt=urn:btih:1234567890ABCDEF1234567890ABCDEF12345678&amp;dn=x</link>
          <torznab:attr name="seeders" value="42"/>
        </item>
      </channel></rss>`);
    const results = await client.search(conn, { q: 'The Show', season: 1, ep: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('The Show S01E05 1080p WEB-DL x265-GRP');
    expect(results[0].seeders).toBe(42);
  });

  it('normalizes a .torrent enclosure item (size from enclosure length)', async () => {
    mockFetch(feed(`
      <item>
        <title>The Show S01E03 720p HDTV x264-GRP</title>
        <enclosure url="https://tracker.example/dl/abc.torrent" length="800000000" type="application/x-bittorrent"/>
        <torznab:attr name="seeders" value="4"/>
      </item>`));
    const [c] = await client.search(conn, { q: 'The Show', season: 1, ep: 3 });
    expect(c.downloadUrl).toBe('https://tracker.example/dl/abc.torrent');
    expect(c.sizeBytes).toBe(800000000);
    expect(c.seeders).toBe(4);
    expect(c.infoHash).toBeNull();
  });

  it('treats a missing seeders attr as null (not 0)', async () => {
    mockFetch(feed(`
      <item>
        <title>The Show S01E04 1080p</title>
        <enclosure url="https://x/y.torrent" length="1" type="application/x-bittorrent"/>
      </item>`));
    const [c] = await client.search(conn, { q: 'The Show', season: 1, ep: 4 });
    expect(c.seeders).toBeNull();
  });

  it('reads newznab:attr namespace attributes', async () => {
    mockFetch(feed(`
      <item>
        <title>The Show S02E01 2160p</title>
        <enclosure url="https://x/z.torrent" length="1" type="application/x-bittorrent"/>
        <newznab:attr name="seeders" value="55"/>
      </item>`));
    const [c] = await client.search(conn, { q: 'The Show', season: 2, ep: 1 });
    expect(c.seeders).toBe(55);
  });

  it('builds the tvsearch URL with apikey, cat, season and ep', async () => {
    mockFetch(feed('<item><title>x</title></item>'));
    await client.search(conn, { q: 'The Show', season: 3, ep: 7 });
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('t=tvsearch');
    expect(url).toContain('apikey=secret');
    expect(url).toContain('season=3');
    expect(url).toContain('ep=7');
    expect(url).toContain('cat=5000%2C5030%2C5040');
  });

  it('falls back to t=search with a padded SxxEyy query when tvsearch is off', async () => {
    mockFetch(feed('<item><title>x</title></item>'));
    await client.search(conn, { q: 'The Show', season: 1, ep: 2 }, false);
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('t=search');
    // URLSearchParams encodes spaces as '+'; normalize before asserting.
    expect(decodeURIComponent(url).replace(/\+/g, ' ')).toContain('The Show S01E02');
  });
});

describe('TorznabClient.fetchCaps', () => {
  const client = new TorznabClient();

  it('parses categories and tv/movie search availability', async () => {
    mockFetch(`<?xml version="1.0"?>
      <caps>
        <server title="Test Indexer"/>
        <limits max="100" default="50"/>
        <searching>
          <tv-search available="yes" supportedParams="q,season,ep"/>
          <movie-search available="no"/>
        </searching>
        <categories>
          <category id="5000" name="TV"/>
          <category id="5030" name="TV/SD"/>
        </categories>
      </caps>`);
    const caps = await client.fetchCaps(conn);
    expect(caps.tvSearch).toBe(true);
    expect(caps.movieSearch).toBe(false);
    expect(caps.supportedParams).toEqual(['q', 'season', 'ep']);
    expect(caps.categories).toEqual([
      { id: 5000, name: 'TV' },
      { id: 5030, name: 'TV/SD' },
    ]);
    expect(caps.limits).toEqual({ default: 50, max: 100 });
  });
});
