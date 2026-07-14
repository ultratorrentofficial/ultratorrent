import { MediaServerReportService } from './media-server-report.service';

/** In-memory watch-history table supporting the aggregate/groupBy the report uses. */
class WatchHistoryTable {
  constructor(public rows: any[]) {}

  /**
   * A real matcher, not a list of hard-coded keys. The drill-down builds nested
   * `AND`/`OR`/`in`/`= null` clauses, and a harness that quietly ignored an unknown
   * key would let a filtered test pass while filtering nothing.
   */
  private matches(row: any, where: any): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where as Record<string, any>)) {
      if (k === 'AND') {
        if (!(v as any[]).every((c) => this.matches(row, c))) return false;
        continue;
      }
      if (k === 'OR') {
        if (!(v as any[]).some((c) => this.matches(row, c))) return false;
        continue;
      }
      const val = row[k];
      if (v === null) {
        if (val != null) return false;
        continue;
      }
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('gte' in v && !(val >= v.gte)) return false;
        if ('lt' in v && !(val < v.lt)) return false;
        if ('in' in v && !(v.in as any[]).includes(val)) return false;
        if ('not' in v && v.not === null && val == null) return false;
        continue;
      }
      if (val !== v) return false;
    }
    return true;
  }

  private applyWhere(where: any): any[] {
    return this.rows.filter((r) => this.matches(r, where));
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
  async count({ where }: any = {}) {
    return this.applyWhere(where).length;
  }
  async findMany({ where, orderBy, skip, take }: any = {}) {
    let r = this.applyWhere(where);
    if (orderBy?.startedAt) {
      r = [...r].sort((a, b) =>
        orderBy.startedAt === 'desc' ? +b.startedAt - +a.startedAt : +a.startedAt - +b.startedAt,
      );
    }
    if (skip) r = r.slice(skip);
    if (take != null) r = r.slice(0, take);
    return r;
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

    it('connectionId / libraryName / userName narrow the reports (Phase 6e)', async () => {
      const rows = [
        { connectionId: 'srv-a', libraryName: 'Movies', userName: 'alice', mediaType: 'movie', playbackMethod: 'directplay', watchedSeconds: 10, startedAt: new Date() },
        { connectionId: 'srv-a', libraryName: 'TV', userName: 'bob', mediaType: 'episode', playbackMethod: 'transcode', watchedSeconds: 20, startedAt: new Date() },
        { connectionId: 'srv-b', libraryName: 'Movies', userName: 'alice', mediaType: 'movie', playbackMethod: 'directplay', watchedSeconds: 30, startedAt: new Date() },
      ];
      const svc = makeService(rows);
      expect((await svc.usage({ connectionId: 'srv-a' })).totalPlays).toBe(2);
      expect((await svc.usage({ libraryName: 'Movies' })).totalPlays).toBe(2);
      expect((await svc.usage({ userName: 'bob' })).totalPlays).toBe(1);
      // Combined dimensions intersect.
      expect((await svc.usage({ connectionId: 'srv-a', userName: 'alice' })).totalPlays).toBe(1);
    });
  });

  describe('bandwidth', () => {
    it('averages bitrate per day over plays that reported one', async () => {
      const rows = [
        { mediaType: 'movie', bitrateKbps: 4000, startedAt: new Date('2026-07-01T10:00:00Z') },
        { mediaType: 'movie', bitrateKbps: 6000, startedAt: new Date('2026-07-01T20:00:00Z') },
        { mediaType: 'movie', bitrateKbps: null, startedAt: new Date('2026-07-01T21:00:00Z') }, // excluded
        { mediaType: 'movie', bitrateKbps: 8000, startedAt: new Date('2026-07-02T10:00:00Z') },
      ];
      const bw = await makeService(rows).bandwidth();
      expect(bw).toEqual([
        { date: '2026-07-01', avgKbps: 5000, plays: 2 },
        { date: '2026-07-02', avgKbps: 8000, plays: 1 },
      ]);
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

/**
 * Clicking a chart must open onto exactly the plays that chart counted. The traps:
 * a bar's LABEL is derived (`1080p` folds the raw `1080p`, `1080` and the junk `p`
 * Tautulli emits), the `Unknown` bar is NULL rather than the string "Unknown", and
 * the heatmap is bucketed in JS — so a SQL re-implementation could disagree with the
 * number printed in the cell.
 */
describe('MediaServerReportService.plays — chart drill-down', () => {
  const at = (iso: string) => new Date(iso);
  const play = (over: any = {}) => ({
    id: over.id ?? Math.random().toString(36).slice(2),
    title: 'Show',
    mediaType: 'episode',
    libraryName: 'TV Shows',
    userName: 'Dennis',
    device: 'Roku',
    client: 'Plex',
    resolution: '1080p',
    playbackMethod: 'directplay',
    bitrateKbps: 4000,
    // A Wednesday, 20:00 local.
    startedAt: at('2026-07-08T20:00:00'),
    watchedSeconds: 100,
    percentComplete: 90,
    ...over,
  });
  const page = { page: 1, pageSize: 50 };

  it('drills a Top Users bar into that user’s plays', async () => {
    const svc = makeService([
      play({ id: 'a', userName: 'Dennis' }),
      play({ id: 'b', userName: 'Madeline' }),
      play({ id: 'c', userName: 'Dennis' }),
    ]);
    const res = await svc.plays(undefined, { users: ['Dennis'] }, page);
    expect(res.total).toBe(2);
    expect(res.items.map((r: any) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('drills a folded "Other" bar into ALL the users it folded', async () => {
    const svc = makeService([
      play({ id: 'a', userName: 'Rafael' }),
      play({ id: 'b', userName: 'Maria' }),
      play({ id: 'c', userName: 'Dennis' }),
    ]);
    const res = await svc.plays(undefined, { users: ['Rafael', 'Maria'] }, page);
    expect(res.total).toBe(2);
    expect(res.items.map((r: any) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('drills the "Unknown" user bar into the NULL rows the bar was built from', async () => {
    // The bar exists because rows have no userName. Filtering `userName = 'Unknown'`
    // would return zero and the operator would click a populated bar to see nothing.
    const svc = makeService([
      play({ id: 'a', userName: null }),
      play({ id: 'b', userName: null }),
      play({ id: 'c', userName: 'Dennis' }),
    ]);
    const bar = (await svc.users()).find((u: any) => u.userName === 'Unknown')!;
    expect(bar.plays).toBe(2);

    const res = await svc.plays(undefined, { users: ['Unknown'] }, page);
    expect(res.total).toBe(bar.plays);
    expect(res.items.map((r: any) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('the Unknown bar merges NULL with a viewer literally named "Unknown" — and so does its drill', async () => {
    // groupBy returns these as two groups; charting both as "Unknown" without merging
    // renders two identically-named bars that no drill-down could tell apart.
    const svc = makeService([
      play({ id: 'a', userName: null }),
      play({ id: 'b', userName: 'Unknown' }),
      play({ id: 'c', userName: 'Dennis' }),
    ]);
    const unknownBars = (await svc.users()).filter((u: any) => u.userName === 'Unknown');
    expect(unknownBars).toHaveLength(1); // one bar, not two
    expect(unknownBars[0].plays).toBe(2);

    const res = await svc.plays(undefined, { users: ['Unknown'] }, page);
    expect(res.total).toBe(2); // the drill agrees with the bar
    expect(res.items.map((r: any) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('drills a device bar into that device', async () => {
    const svc = makeService([
      play({ id: 'a', device: 'Roku' }),
      play({ id: 'b', device: 'Tizen' }),
    ]);
    const res = await svc.plays(undefined, { devices: ['Roku'] }, page);
    expect(res.total).toBe(1);
    expect(res.items[0].id).toBe('a');
  });

  it('drills the 1080p bar into EVERY raw value that folds into it', async () => {
    // The chart's 1080p bar counts all three. Filtering resolution = '1080p' would
    // silently drop two of them — on the live library that is 37 plays stored as
    // "1080" plus 33 stored as the junk "p".
    const svc = makeService([
      play({ id: 'a', resolution: '1080p' }),
      play({ id: 'b', resolution: '1080' }),
      play({ id: 'c', resolution: '1080P' }),
      play({ id: 'd', resolution: '720p' }),
    ]);
    const chart = await svc.resolutions();
    expect(chart.find((r: any) => r.resolution === '1080p')!.plays).toBe(3);

    const res = await svc.plays(undefined, { resolution: '1080p' }, page);
    expect(res.total).toBe(3); // matches the bar exactly
    expect(res.items.map((r: any) => r.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('drills the Unknown quality bar into rows with no resolution', async () => {
    const svc = makeService([play({ id: 'a', resolution: null }), play({ id: 'b', resolution: '720p' })]);
    const res = await svc.plays(undefined, { resolution: 'Unknown' }, page);
    expect(res.total).toBe(1);
    expect(res.items[0].id).toBe('a');
  });

  it('drills a playback-method slice across its provider spellings', async () => {
    const svc = makeService([
      play({ id: 'a', playbackMethod: 'transcode' }),
      play({ id: 'b', playbackMethod: 'Transcode (HW)' }),
      play({ id: 'c', playbackMethod: 'directplay' }),
    ]);
    const res = await svc.plays(undefined, { playbackMethod: 'transcode' }, page);
    expect(res.total).toBe(2);
    expect(res.items.map((r: any) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('drills a heatmap cell into exactly the plays that cell counted', async () => {
    const svc = makeService([
      play({ id: 'a', startedAt: at('2026-07-08T20:15:00') }), // Wed 20h
      play({ id: 'b', startedAt: at('2026-07-08T20:55:00') }), // Wed 20h
      play({ id: 'c', startedAt: at('2026-07-08T21:00:00') }), // Wed 21h
      play({ id: 'd', startedAt: at('2026-07-09T20:00:00') }), // Thu 20h
    ]);
    const grid = await svc.heatmap();
    const wed20 = grid.cells.find((c: any) => c.dow === 3 && c.hour === 20)!;
    expect(wed20.plays).toBe(2);

    const res = await svc.plays(undefined, { dow: 3, hour: 20 }, page);
    // The drill-down count can never contradict the number printed in the cell.
    expect(res.total).toBe(wed20.plays);
    expect(res.items.map((r: any) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('honours the dashboard filter alongside the clicked slice', async () => {
    const svc = makeService([
      play({ id: 'a', userName: 'Dennis', libraryName: 'TV Shows' }),
      play({ id: 'b', userName: 'Dennis', libraryName: 'Movies' }),
    ]);
    const res = await svc.plays({ libraryName: 'Movies' }, { users: ['Dennis'] }, page);
    expect(res.total).toBe(1);
    expect(res.items[0].id).toBe('b');
  });

  it('paginates, newest first', async () => {
    const svc = makeService([
      play({ id: 'old', startedAt: at('2026-07-01T10:00:00') }),
      play({ id: 'new', startedAt: at('2026-07-09T10:00:00') }),
      play({ id: 'mid', startedAt: at('2026-07-05T10:00:00') }),
    ]);
    const p1 = await svc.plays(undefined, {}, { page: 1, pageSize: 2 });
    expect(p1.total).toBe(3);
    expect(p1.items.map((r: any) => r.id)).toEqual(['new', 'mid']);
    const p2 = await svc.plays(undefined, {}, { page: 2, pageSize: 2 });
    expect(p2.items.map((r: any) => r.id)).toEqual(['old']);
  });

  it('returns nothing for a label that matches no rows (never the whole table)', async () => {
    const svc = makeService([play({ id: 'a', resolution: '720p' })]);
    const res = await svc.plays(undefined, { resolution: '4K' }, page);
    expect(res.total).toBe(0);
    expect(res.items).toEqual([]);
  });
});
