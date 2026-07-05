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
}
