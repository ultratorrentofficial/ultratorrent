import { MediaServerReportService } from './media-server-report.service';

/** In-memory watch-history table supporting the aggregate/groupBy the report uses. */
class WatchHistoryTable {
  constructor(public rows: any[]) {}
  /** Apply the subset of Prisma `where` the report builds (startedAt.gte + mediaType). */
  private applyWhere(where: any): any[] {
    let r = this.rows;
    if (where?.startedAt?.gte) r = r.filter((x) => x.startedAt >= where.startedAt.gte);
    if (where?.mediaType) r = r.filter((x) => x.mediaType === where.mediaType);
    return r;
  }
  async aggregate({ where, _count, _sum }: any) {
    const rows = this.applyWhere(where);
    const out: any = {};
    if (_count?._all) out._count = { _all: rows.length };
    if (_sum) {
      out._sum = {};
      for (const f of Object.keys(_sum)) out._sum[f] = rows.reduce((s, r) => s + (r[f] ?? 0), 0);
    }
    return out;
  }
  async findMany({ where }: any = {}) {
    return this.applyWhere(where);
  }
  async groupBy({ by, where, _count, _sum, _max }: any) {
    const key = (r: any) => by.map((k: string) => r[k]).join(' ');
    const groups = new Map<string, any[]>();
    for (const r of this.applyWhere(where)) {
      const k = key(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    return [...groups.values()].map((gr) => {
      const out: any = {};
      by.forEach((k: string) => (out[k] = gr[0][k]));
      if (_count?._all) out._count = { _all: gr.length };
      if (_sum) { out._sum = {}; for (const f of Object.keys(_sum)) out._sum[f] = gr.reduce((s, r) => s + (r[f] ?? 0), 0); }
      if (_max) { out._max = {}; for (const f of Object.keys(_max)) out._max[f] = gr.reduce((m, r) => (!m || r[f] > m ? r[f] : m), null); }
      return out;
    });
  }
}

/** In-memory media-item table supporting the findMany/count the library-growth report uses. */
class MediaItemTable {
  constructor(public rows: any[]) {}
  private applyWhere(where: any): any[] {
    let r = this.rows;
    if (where?.mediaType) r = r.filter((x) => x.mediaType === where.mediaType);
    if (where?.createdAt?.gte) r = r.filter((x) => x.createdAt >= where.createdAt.gte);
    if (where?.createdAt?.lt) r = r.filter((x) => x.createdAt < where.createdAt.lt);
    return r;
  }
  async findMany({ where }: any = {}) {
    return [...this.applyWhere(where)].sort((a, b) => +a.createdAt - +b.createdAt);
  }
  async count({ where }: any = {}) {
    return this.applyWhere(where).length;
  }
}

function makeService(rows: any[], items: any[] = []) {
  const prisma = { mediaServerWatchHistory: new WatchHistoryTable(rows), mediaItem: new MediaItemTable(items) };
  return new MediaServerReportService(prisma as any);
}

const HISTORY = [
  { userName: 'alice', libraryName: 'Movies', mediaType: 'movie', playbackMethod: 'directplay', watchedSeconds: 100, startedAt: new Date('2026-07-01') },
  { userName: 'alice', libraryName: 'TV', mediaType: 'episode', playbackMethod: 'transcode', watchedSeconds: 200, startedAt: new Date('2026-07-03') },
  { userName: 'bob', libraryName: 'Movies', mediaType: 'movie', playbackMethod: 'directplay', watchedSeconds: 50, startedAt: new Date('2026-07-03') },
];

describe('MediaServerReportService', () => {
  it('usage aggregates totals, unique users, and per-day plays', async () => {
    const u = await makeService(HISTORY).usage();
    expect(u.totalPlays).toBe(3);
    expect(u.totalWatchSeconds).toBe(350);
    expect(u.uniqueUsers).toBe(2);
    // Only recent (last 30 days) rows count for byDay; fixtures are old, so this
    // asserts the shape rather than exact buckets.
    expect(Array.isArray(u.byDay)).toBe(true);
  });

  it('users ranks by plays with watch time + last seen', async () => {
    const users = await makeService(HISTORY).users();
    expect(users[0]).toMatchObject({ userName: 'alice', plays: 2, watchSeconds: 300 });
    expect(users[1]).toMatchObject({ userName: 'bob', plays: 1, watchSeconds: 50 });
  });

  it('libraries ranks by plays', async () => {
    const libs = await makeService(HISTORY).libraries();
    expect(libs.find((l) => l.libraryName === 'Movies')).toMatchObject({ plays: 2 });
    expect(libs.find((l) => l.libraryName === 'TV')).toMatchObject({ plays: 1 });
  });

  it('playback splits by method and type', async () => {
    const pb = await makeService(HISTORY).playback();
    expect(pb.byMethod.find((m) => m.method === 'directplay')?.plays).toBe(2);
    expect(pb.byMethod.find((m) => m.method === 'transcode')?.plays).toBe(1);
    expect(pb.byType.find((t) => t.type === 'movie')?.plays).toBe(2);
  });

  describe('filters', () => {
    it('mediaType filter restricts every report to the chosen type', async () => {
      const svc = makeService(HISTORY);
      const u = await svc.usage({ mediaType: 'movie' });
      expect(u.totalPlays).toBe(2);
      expect(u.totalWatchSeconds).toBe(150);

      const pb = await svc.playback({ mediaType: 'movie' });
      expect(pb.byType.every((t) => t.type === 'movie')).toBe(true);
      expect(pb.byMethod.find((m) => m.method === 'transcode')).toBeUndefined();

      const users = await svc.users({ mediaType: 'episode' });
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ userName: 'alice', plays: 1 });
    });

    it('days filter excludes rows older than the rolling window', async () => {
      // A fresh row within the window and a stale row well outside it.
      const now = new Date();
      const recent = new Date(now.getTime() - 1 * 24 * 3600 * 1000);
      const old = new Date(now.getTime() - 400 * 24 * 3600 * 1000);
      const svc = makeService([
        { userName: 'alice', mediaType: 'movie', playbackMethod: 'directplay', watchedSeconds: 10, startedAt: recent },
        { userName: 'bob', mediaType: 'movie', playbackMethod: 'directplay', watchedSeconds: 20, startedAt: old },
      ]);
      const u = await svc.usage({ days: 7 });
      expect(u.totalPlays).toBe(1);
      expect(u.uniqueUsers).toBe(1);
    });

    it('no filter counts all-time rows regardless of age', async () => {
      const svc = makeService(HISTORY);
      const u = await svc.usage();
      expect(u.totalPlays).toBe(3);
    });
  });

  describe('heatmap', () => {
    it('buckets plays by day-of-week and hour with a peak', async () => {
      // Two plays Wed 14:00, one Fri 09:00 (local time).
      const rows = [
        { mediaType: 'movie', startedAt: new Date(2026, 6, 1, 14, 5) }, // Wed
        { mediaType: 'movie', startedAt: new Date(2026, 6, 1, 14, 40) }, // Wed
        { mediaType: 'movie', startedAt: new Date(2026, 6, 3, 9, 0) }, // Fri
      ];
      const hm = await makeService(rows).heatmap();
      expect(hm.total).toBe(3);
      expect(hm.max).toBe(2);
      expect(hm.cells).toHaveLength(7 * 24);
      const wed14 = hm.cells.find((c) => c.dow === 3 && c.hour === 14);
      expect(wed14?.plays).toBe(2);
      const fri9 = hm.cells.find((c) => c.dow === 5 && c.hour === 9);
      expect(fri9?.plays).toBe(1);
    });
  });

  describe('trends', () => {
    it('splits playback methods per day and normalizes spellings', async () => {
      const rows = [
        { playbackMethod: 'Direct Play', startedAt: new Date('2026-07-01T10:00:00Z') },
        { playbackMethod: 'transcode', startedAt: new Date('2026-07-01T12:00:00Z') },
        { playbackMethod: 'directstream', startedAt: new Date('2026-07-02T12:00:00Z') },
      ];
      const tr = await makeService(rows).trends();
      const d1 = tr.find((d) => d.date === '2026-07-01');
      expect(d1).toMatchObject({ directplay: 1, transcode: 1, total: 2 });
      const d2 = tr.find((d) => d.date === '2026-07-02');
      expect(d2).toMatchObject({ directstream: 1, total: 1 });
    });
  });

  describe('resolutions', () => {
    it('merges resolution spellings into canonical labels ordered high→low', async () => {
      const rows = [
        { mediaType: 'movie', resolution: '1920x1080', startedAt: new Date() },
        { mediaType: 'movie', resolution: '1080p', startedAt: new Date() },
        { mediaType: 'movie', resolution: '4K', startedAt: new Date() },
        { mediaType: 'movie', resolution: null, startedAt: new Date() },
      ];
      const res = await makeService(rows).resolutions();
      expect(res.find((r) => r.resolution === '1080p')?.plays).toBe(2);
      expect(res.find((r) => r.resolution === '4K')?.plays).toBe(1);
      expect(res.find((r) => r.resolution === 'Unknown')?.plays).toBe(1);
      // 4K sorts before 1080p; Unknown last.
      expect(res[0].resolution).toBe('4K');
      expect(res[res.length - 1].resolution).toBe('Unknown');
    });
  });

  describe('libraryGrowth', () => {
    it('produces cumulative monthly totals from a zero baseline', async () => {
      const items = [
        { mediaType: 'movie', createdAt: new Date('2026-05-10') },
        { mediaType: 'movie', createdAt: new Date('2026-06-02') },
        { mediaType: 'movie', createdAt: new Date('2026-06-20') },
      ];
      const g = await makeService([], items).libraryGrowth();
      expect(g).toEqual([
        { month: '2026-05', added: 1, total: 1 },
        { month: '2026-06', added: 2, total: 3 },
      ]);
    });
  });

  describe('exportWatchHistoryCsv', () => {
    it('emits a header row and escapes commas/quotes', async () => {
      const rows = [
        { startedAt: new Date('2026-07-01T00:00:00Z'), stoppedAt: null, userName: 'alice', title: 'Movie, The "Best"', mediaType: 'movie', libraryName: 'Movies', device: 'TV', client: 'Plex', playbackMethod: 'directplay', resolution: '1080p', videoCodec: 'h264', watchedSeconds: 100, percentComplete: 90, importSource: 'live' },
      ];
      const csv = await makeService(rows).exportWatchHistoryCsv();
      const lines = csv.split('\r\n');
      expect(lines[0]).toBe('startedAt,stoppedAt,user,title,mediaType,library,device,client,playbackMethod,resolution,videoCodec,watchedSeconds,percentComplete,source');
      expect(lines[1]).toContain('"Movie, The ""Best"""');
      expect(lines[1]).toContain('2026-07-01T00:00:00.000Z');
    });
  });

  describe('recentlyAdded artwork', () => {
    it('returns the selected poster, or null when the item has no artwork', async () => {
      const items = [
        { id: '1', title: 'Movie A', mediaType: 'movie', year: 2020, season: null, episode: null, createdAt: new Date(), artwork: [{ id: 'a1', url: 'http://x/p.jpg', localPath: null, type: 'poster', selected: true }] },
        { id: '2', title: 'Movie B', mediaType: 'movie', year: 2021, season: null, episode: null, createdAt: new Date(), artwork: [] },
      ];
      const out = await makeService([], items).recentlyAdded();
      expect(out[0]).toMatchObject({ id: '1', title: 'Movie A', poster: { id: 'a1', type: 'poster' } });
      expect(out[1].poster).toBeNull();
    });
  });
});
