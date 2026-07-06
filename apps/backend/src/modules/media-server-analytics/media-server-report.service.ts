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
}

@Injectable()
export class MediaServerReportService {
  constructor(private readonly prisma: PrismaService) {}

  /** Build the shared watch-history `where` clause from the filter. */
  private where(f?: ReportFilter): { startedAt?: { gte: Date }; mediaType?: string } {
    const w: { startedAt?: { gte: Date }; mediaType?: string } = {};
    if (f?.days && f.days > 0) w.startedAt = { gte: new Date(Date.now() - f.days * 24 * 3600 * 1000) };
    if (f?.mediaType) w.mediaType = f.mediaType;
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
    return grouped
      .map((g) => ({
        userName: g.userName ?? 'Unknown',
        plays: g._count._all,
        watchSeconds: g._sum.watchedSeconds ?? 0,
        lastSeen: g._max.startedAt,
      }))
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
    return grouped
      .map((g) => ({ device: g.device ?? 'Unknown', plays: g._count._all }))
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

  /** Resolution/quality distribution, merged into canonical labels and ordered high→low. */
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
