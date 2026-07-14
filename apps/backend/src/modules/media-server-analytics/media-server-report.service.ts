import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * Analytics reports computed on demand from the watch-history captured by the
 * session poller (and, later, Tautulli imports) plus the Media Manager library.
 * Snapshot persistence (for long-range trends) is a later optimization.
 */
/** Optional analytics filters, applied to the watch-history queries. */
export interface ReportFilter {
  days?: number; // rolling window; undefined = all-time
  mediaType?: string;
  connectionId?: string; // filter to one media server
  libraryName?: string; // filter to one library
  userName?: string; // filter to one viewer
}

/**
 * The chart bucket a play was counted in has no value: a chart's *label* is
 * derived, not stored. `1080p` is what `normalizeResolution` makes of the raw
 * `1080p`, `1080` and even the junk `p` that Tautulli emits; `Unknown` is what it
 * makes of NULL. So a drill-down cannot filter `resolution = '1080p'` — it has to
 * resolve the label back to every raw value that folds into it. Same for the
 * playback-method buckets, and for the `Unknown` user/device bar, which is NULL.
 */
export const UNKNOWN_LABEL = 'Unknown';

/** Which slice of a chart the operator clicked. */
export interface PlayDrill {
  /** `userName`s exactly as charted; {@link UNKNOWN_LABEL} also matches NULL. Several = a folded "Other". */
  users?: string[];
  /** `device`s exactly as charted; {@link UNKNOWN_LABEL} also matches NULL. */
  devices?: string[];
  /** A canonical quality LABEL as charted ("1080p", "SD", "Unknown"). */
  resolution?: string;
  /** A canonical playback-method bucket as charted ("transcode", "directplay", …). */
  playbackMethod?: string;
  /** Heatmap cell: day-of-week 0-6 (Sun-Sat) and hour 0-23. */
  dow?: number;
  hour?: number;
  title?: string;
}

/** The columns a drill-down row shows. */
const PLAY_SELECT = {
  id: true,
  title: true,
  mediaType: true,
  libraryName: true,
  userName: true,
  device: true,
  client: true,
  resolution: true,
  videoCodec: true,
  bitrateKbps: true,
  playbackMethod: true,
  startedAt: true,
  watchedSeconds: true,
  percentComplete: true,
} as const;

/** The subset of Prisma's watch-history `where` the reports build. */
interface HistoryWhere {
  startedAt?: { gte: Date };
  mediaType?: string;
  connectionId?: string;
  libraryName?: string;
  userName?: string;
}

@Injectable()
export class MediaServerReportService {
  constructor(private readonly prisma: PrismaService) {}

  /** Build the shared watch-history `where` clause from the filter. */
  private where(f?: ReportFilter): HistoryWhere {
    const w: HistoryWhere = {};
    if (f?.days && f.days > 0) w.startedAt = { gte: new Date(Date.now() - f.days * 24 * 3600 * 1000) };
    if (f?.mediaType) w.mediaType = f.mediaType;
    if (f?.connectionId) w.connectionId = f.connectionId;
    if (f?.libraryName) w.libraryName = f.libraryName;
    if (f?.userName) w.userName = f.userName;
    return w;
  }

  /** Normalize the many provider spellings of a playback method into four buckets. */
  private normalizeMethod(m?: string | null): 'directplay' | 'directstream' | 'transcode' | 'other' {
    const v = (m ?? '').toLowerCase().replace(/[\s_-]/g, '');
    if (v.includes('transcode')) return 'transcode';
    if (v.includes('directstream') || v.includes('copy')) return 'directstream';
    if (v.includes('directplay') || v === 'direct') return 'directplay';
    return 'other';
  }

  /** Normalize a resolution string into a canonical quality label. */
  private normalizeResolution(r?: string | null): string {
    if (!r) return 'Unknown';
    const v = r.toLowerCase();
    if (v.includes('4k') || v.includes('2160')) return '4K';
    if (v.includes('1080')) return '1080p';
    if (v.includes('720')) return '720p';
    if (v.includes('480')) return '480p';
    if (v.includes('sd')) return 'SD';
    return r; // unrecognized — surface verbatim
  }

  /** Overall usage: totals + a per-day play count over the window. */
  async usage(f?: ReportFilter) {
    const where = this.where(f);
    const daySpan = f?.days && f.days > 0 ? f.days : 30;
    const since = new Date(Date.now() - daySpan * 24 * 3600 * 1000);
    const [agg, rows, users] = await Promise.all([
      this.prisma.mediaServerWatchHistory.aggregate({ where, _count: { _all: true }, _sum: { watchedSeconds: true } }),
      this.prisma.mediaServerWatchHistory.findMany({ where: { ...where, startedAt: { gte: since } }, select: { startedAt: true } }),
      this.prisma.mediaServerWatchHistory.groupBy({ by: ['userName'], where, _count: { _all: true } }),
    ]);
    const byDay = new Map<string, number>();
    for (const r of rows) {
      const key = r.startedAt.toISOString().slice(0, 10);
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }
    return {
      totalPlays: agg._count._all,
      totalWatchSeconds: agg._sum.watchedSeconds ?? 0,
      uniqueUsers: users.length,
      byDay: [...byDay.entries()].sort().map(([date, plays]) => ({ date, plays })),
    };
  }

  /** Per-user activity, most active first. */
  async users(f?: ReportFilter) {
    const grouped = await this.prisma.mediaServerWatchHistory.groupBy({
      by: ['userName'],
      where: this.where(f),
      _count: { _all: true },
      _sum: { watchedSeconds: true },
      _max: { startedAt: true },
    });
    // Fold by LABEL, not by raw value: `groupBy` returns NULL and a viewer literally
    // named "Unknown" as two groups, and mapping both to "Unknown" without merging
    // renders two identically-named bars — which a drill-down could never tell apart.
    const merged = new Map<string, { plays: number; watchSeconds: number; lastSeen: Date | null }>();
    for (const g of grouped) {
      const label = g.userName ?? UNKNOWN_LABEL;
      const cur = merged.get(label) ?? { plays: 0, watchSeconds: 0, lastSeen: null };
      cur.plays += g._count._all;
      cur.watchSeconds += g._sum.watchedSeconds ?? 0;
      const seen = g._max.startedAt;
      if (seen && (!cur.lastSeen || seen > cur.lastSeen)) cur.lastSeen = seen;
      merged.set(label, cur);
    }
    return [...merged.entries()]
      .map(([userName, v]) => ({ userName, plays: v.plays, watchSeconds: v.watchSeconds, lastSeen: v.lastSeen }))
      .sort((a, b) => b.plays - a.plays);
  }

  /** Per-library activity. */
  async libraries(f?: ReportFilter) {
    const grouped = await this.prisma.mediaServerWatchHistory.groupBy({
      by: ['libraryName'],
      where: this.where(f),
      _count: { _all: true },
      _sum: { watchedSeconds: true },
    });
    return grouped
      .map((g) => ({
        libraryName: g.libraryName ?? 'Unknown',
        plays: g._count._all,
        watchSeconds: g._sum.watchedSeconds ?? 0,
      }))
      .sort((a, b) => b.plays - a.plays);
  }

  /** Playback method + media-type distributions. */
  async playback(f?: ReportFilter) {
    const where = this.where(f);
    const [byMethod, byType] = await Promise.all([
      this.prisma.mediaServerWatchHistory.groupBy({ by: ['playbackMethod'], where, _count: { _all: true } }),
      this.prisma.mediaServerWatchHistory.groupBy({ by: ['mediaType'], where, _count: { _all: true } }),
    ]);
    return {
      byMethod: byMethod.map((g) => ({ method: g.playbackMethod ?? 'unknown', plays: g._count._all })).sort((a, b) => b.plays - a.plays),
      byType: byType.map((g) => ({ type: g.mediaType ?? 'unknown', plays: g._count._all })).sort((a, b) => b.plays - a.plays),
    };
  }

  /** Most-watched titles. */
  async topMedia(limit = 10, f?: ReportFilter) {
    const grouped = await this.prisma.mediaServerWatchHistory.groupBy({
      by: ['title', 'mediaType'],
      where: this.where(f),
      _count: { _all: true },
      _sum: { watchedSeconds: true },
    });
    return grouped
      .map((g) => ({ title: g.title, mediaType: g.mediaType ?? 'other', plays: g._count._all, watchSeconds: g._sum.watchedSeconds ?? 0 }))
      .sort((a, b) => b.plays - a.plays)
      .slice(0, limit);
  }

  /** Device/client distribution. */
  async devices(f?: ReportFilter) {
    const grouped = await this.prisma.mediaServerWatchHistory.groupBy({ by: ['device'], where: this.where(f), _count: { _all: true } });
    // Fold by label — NULL and a device literally named "Unknown" are one bar.
    const merged = new Map<string, number>();
    for (const g of grouped) {
      const label = g.device ?? UNKNOWN_LABEL;
      merged.set(label, (merged.get(label) ?? 0) + g._count._all);
    }
    return [...merged.entries()]
      .map(([device, plays]) => ({ device, plays }))
      .sort((a, b) => b.plays - a.plays);
  }

  /**
   * Recently added — sourced from the Media Manager library (the primary source
   * of truth), grouped by media type.
   */
  async recentlyAdded(limit = 50) {
    const items = await this.prisma.mediaItem.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      select: {
        id: true, title: true, mediaType: true, year: true, season: true, episode: true, createdAt: true,
        // Poster artwork (selected first) for the artwork-rich UI.
        artwork: {
          where: { type: 'poster' },
          orderBy: { selected: 'desc' },
          take: 1,
          select: { id: true, url: true, localPath: true, type: true, selected: true },
        },
      },
    });
    return items.map((i) => ({
      id: i.id,
      title: i.title,
      mediaType: i.mediaType,
      year: i.year,
      season: i.season,
      episode: i.episode,
      addedAt: i.createdAt,
      poster: i.artwork[0] ?? null,
    }));
  }

  /**
   * Viewing-activity heatmap: play counts bucketed by day-of-week (0=Sunday)
   * and hour (0-23), in server-local time. Returns a flat cell list plus the
   * peak value so the UI can scale a single-hue sequential ramp.
   */
  async heatmap(f?: ReportFilter) {
    const rows = await this.prisma.mediaServerWatchHistory.findMany({
      where: this.where(f),
      select: { startedAt: true },
    });
    const grid: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const r of rows) grid[r.startedAt.getDay()][r.startedAt.getHours()] += 1;
    let max = 0;
    const cells: { dow: number; hour: number; plays: number }[] = [];
    for (let dow = 0; dow < 7; dow++) {
      for (let hour = 0; hour < 24; hour++) {
        const plays = grid[dow][hour];
        if (plays > max) max = plays;
        cells.push({ dow, hour, plays });
      }
    }
    return { cells, max, total: rows.length };
  }

  /** Playback-method load per day (transcode vs direct-play trend over time). */
  async trends(f?: ReportFilter) {
    const rows = await this.prisma.mediaServerWatchHistory.findMany({
      where: this.where(f),
      select: { startedAt: true, playbackMethod: true },
    });
    type Bucket = { directplay: number; directstream: number; transcode: number; other: number; total: number };
    const byDay = new Map<string, Bucket>();
    for (const r of rows) {
      const key = r.startedAt.toISOString().slice(0, 10);
      const b = byDay.get(key) ?? { directplay: 0, directstream: 0, transcode: 0, other: 0, total: 0 };
      b[this.normalizeMethod(r.playbackMethod)] += 1;
      b.total += 1;
      byDay.set(key, b);
    }
    return [...byDay.entries()].sort().map(([date, v]) => ({ date, ...v }));
  }

  /** Average stream bandwidth (kbps) per day, over plays that reported a bitrate. */
  async bandwidth(f?: ReportFilter) {
    const rows = await this.prisma.mediaServerWatchHistory.findMany({
      where: { ...this.where(f), bitrateKbps: { not: null } },
      select: { startedAt: true, bitrateKbps: true },
    });
    const byDay = new Map<string, { sum: number; count: number }>();
    for (const r of rows) {
      const key = r.startedAt.toISOString().slice(0, 10);
      const b = byDay.get(key) ?? { sum: 0, count: 0 };
      b.sum += r.bitrateKbps ?? 0;
      b.count += 1;
      byDay.set(key, b);
    }
    return [...byDay.entries()]
      .sort()
      .map(([date, v]) => ({ date, avgKbps: Math.round(v.sum / v.count), plays: v.count }));
  }

  /** Resolution/quality distribution, merged into canonical labels and ordered high→low. */
  /**
   * The individual plays behind one slice of a chart — what the operator gets when
   * they click a bar, a slice, or a heatmap cell.
   *
   * Two things make this more than a `where` clause:
   *
   * 1. **Chart labels are derived, so they cannot be filtered on.** `1080p` is what
   *    {@link normalizeResolution} makes of the raw `1080p`, `1080` *and* the junk
   *    `p` Tautulli emits; `Unknown` is what it makes of NULL. So the label is first
   *    resolved back to every raw value that folds into it
   *    ({@link bucketFilter}) — otherwise the `1080p` bar would open onto a list
   *    missing the 37 plays stored as `1080`.
   *
   * 2. **The heatmap is bucketed in JS, so its drill-down must be too.** `heatmap()`
   *    buckets with `Date.getDay()`/`getHours()`; reproducing that as SQL `EXTRACT`
   *    would be a second implementation that can silently disagree with the grid the
   *    operator is looking at. Instead we pull the (id, startedAt) pairs the filter
   *    matches, bucket them with the *same* calls, and paginate the ids — so the row
   *    count can never contradict the number printed in the cell.
   */
  async plays(f: ReportFilter | undefined, drill: PlayDrill, page: { page: number; pageSize: number }) {
    const base = this.where(f);
    const and: Record<string, unknown>[] = [];

    if (drill.users?.length) and.push(this.valuesOrNull('userName', drill.users));
    if (drill.devices?.length) and.push(this.valuesOrNull('device', drill.devices));
    if (drill.title) and.push({ title: drill.title });
    if (drill.resolution) {
      and.push(await this.bucketFilter('resolution', drill.resolution, base, (v) => this.normalizeResolution(v)));
    }
    if (drill.playbackMethod) {
      and.push(await this.bucketFilter('playbackMethod', drill.playbackMethod, base, (v) => this.normalizeMethod(v)));
    }

    const where = (and.length ? { ...base, AND: and } : base) as HistoryWhere;
    const skip = (page.page - 1) * page.pageSize;

    // Heatmap drill: bucket exactly as the grid does, then paginate the matched ids.
    if (drill.dow != null || drill.hour != null) {
      const rows = await this.prisma.mediaServerWatchHistory.findMany({
        where,
        select: { id: true, startedAt: true },
      });
      const matched = rows
        .filter(
          (r) =>
            (drill.dow == null || r.startedAt.getDay() === drill.dow) &&
            (drill.hour == null || r.startedAt.getHours() === drill.hour),
        )
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

      const ids = matched.slice(skip, skip + page.pageSize).map((r) => r.id);
      const found = ids.length
        ? await this.prisma.mediaServerWatchHistory.findMany({
            where: { id: { in: ids } },
            select: PLAY_SELECT,
          })
        : [];
      // `in` does not preserve order — restore the sort we just computed.
      const byId = new Map(found.map((r) => [r.id, r]));
      const items = ids
        .map((id) => byId.get(id))
        .filter((r): r is (typeof found)[number] => r != null);
      return { items, total: matched.length, page: page.page, pageSize: page.pageSize };
    }

    const [items, total] = await Promise.all([
      this.prisma.mediaServerWatchHistory.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip,
        take: page.pageSize,
        select: PLAY_SELECT,
      }),
      this.prisma.mediaServerWatchHistory.count({ where }),
    ]);
    return { items, total, page: page.page, pageSize: page.pageSize };
  }

  /**
   * Match a column against the values exactly as they were charted.
   *
   * `users()`/`devices()` fold NULL into the {@link UNKNOWN_LABEL} bar, so the drill
   * must fold it back — filtering `device = 'Unknown'` alone would return nothing for
   * a bar built entirely from rows with no device, and the operator would click a bar
   * reading "412 plays" and be shown an empty list.
   */
  private valuesOrNull(field: 'userName' | 'device', values: string[]): Record<string, unknown> {
    const or: Record<string, unknown>[] = [{ [field]: { in: values } }];
    if (values.includes(UNKNOWN_LABEL)) or.push({ [field]: null });
    return or.length === 1 ? or[0] : { OR: or };
  }

  /**
   * Resolve a canonical chart label back to the raw column values that fold into it.
   * The raw set is read from the data itself under the current filter, so a value the
   * normalizer has never seen (`p`, `4k`, a new provider spelling) still drills down
   * into whichever bucket the chart actually put it in.
   */
  private async bucketFilter(
    field: 'resolution' | 'playbackMethod',
    label: string,
    base: HistoryWhere,
    normalize: (v: string | null) => string,
  ): Promise<Record<string, unknown>> {
    const grouped = await this.prisma.mediaServerWatchHistory.groupBy({
      by: [field],
      where: base,
      _count: { _all: true },
    });
    const values = grouped
      .map((g) => (g as Record<string, unknown>)[field] as string | null)
      .filter((v) => normalize(v) === label);

    const real = values.filter((v): v is string => v != null);
    const or: Record<string, unknown>[] = [];
    if (real.length) or.push({ [field]: { in: real } });
    if (values.some((v) => v == null)) or.push({ [field]: null });
    // The label matched nothing under this filter — return an unsatisfiable clause
    // rather than silently dropping the constraint and listing every play.
    if (or.length === 0) return { [field]: { in: [] } };
    return or.length === 1 ? or[0] : { OR: or };
  }

  async resolutions(f?: ReportFilter) {
    const grouped = await this.prisma.mediaServerWatchHistory.groupBy({
      by: ['resolution'],
      where: this.where(f),
      _count: { _all: true },
    });
    const merged = new Map<string, number>();
    for (const g of grouped) {
      const label = this.normalizeResolution(g.resolution);
      merged.set(label, (merged.get(label) ?? 0) + g._count._all);
    }
    const order = ['4K', '1080p', '720p', '480p', 'SD', 'Unknown'];
    const rank = (x: string) => {
      const i = order.indexOf(x);
      return i === -1 ? order.length - 1 : i; // unrecognized sits just before Unknown
    };
    return [...merged.entries()]
      .map(([resolution, plays]) => ({ resolution, plays }))
      .sort((a, b) => rank(a.resolution) - rank(b.resolution) || b.plays - a.plays);
  }

  /**
   * Library growth over time — cumulative item count by month, sourced from the
   * Media Manager library. With a `days` window the cumulative line still starts
   * from the correct baseline (items that existed before the window).
   */
  async libraryGrowth(f?: ReportFilter) {
    const where: { mediaType?: string; createdAt?: { gte: Date } } = {};
    if (f?.mediaType) where.mediaType = f.mediaType;
    const since = f?.days && f.days > 0 ? new Date(Date.now() - f.days * 24 * 3600 * 1000) : null;
    if (since) where.createdAt = { gte: since };

    const [items, baseline] = await Promise.all([
      this.prisma.mediaItem.findMany({ where, select: { createdAt: true }, orderBy: { createdAt: 'asc' } }),
      since
        ? this.prisma.mediaItem.count({
            where: { createdAt: { lt: since }, ...(f?.mediaType ? { mediaType: f.mediaType } : {}) },
          })
        : Promise.resolve(0),
    ]);

    const byMonth = new Map<string, number>();
    for (const it of items) {
      const key = it.createdAt.toISOString().slice(0, 7); // YYYY-MM
      byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
    }
    let cumulative = baseline;
    return [...byMonth.entries()].sort().map(([month, added]) => {
      cumulative += added;
      return { month, added, total: cumulative };
    });
  }

  /** Watch-history as CSV (RFC 4180), honoring the shared report filter. */
  async exportWatchHistoryCsv(f?: ReportFilter): Promise<string> {
    const rows = await this.prisma.mediaServerWatchHistory.findMany({
      where: this.where(f),
      orderBy: { startedAt: 'desc' },
      take: 50000,
      select: {
        startedAt: true, stoppedAt: true, userName: true, title: true, mediaType: true,
        libraryName: true, device: true, client: true, playbackMethod: true,
        resolution: true, videoCodec: true, watchedSeconds: true, percentComplete: true, importSource: true,
      },
    });
    const headers = [
      'startedAt', 'stoppedAt', 'user', 'title', 'mediaType', 'library', 'device', 'client',
      'playbackMethod', 'resolution', 'videoCodec', 'watchedSeconds', 'percentComplete', 'source',
    ];
    const esc = (v: unknown): string => {
      const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push([
        r.startedAt, r.stoppedAt, r.userName, r.title, r.mediaType, r.libraryName, r.device, r.client,
        r.playbackMethod, r.resolution, r.videoCodec, r.watchedSeconds, r.percentComplete, r.importSource,
      ].map(esc).join(','));
    }
    return lines.join('\r\n');
  }
}
