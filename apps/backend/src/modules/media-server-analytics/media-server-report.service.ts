import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * Analytics reports computed on demand from the watch-history captured by the
 * session poller (and, later, Tautulli imports) plus the Media Manager library.
 * Snapshot persistence (for long-range trends) is a later optimization.
 */
@Injectable()
export class MediaServerReportService {
  constructor(private readonly prisma: PrismaService) {}

  /** Overall usage: totals + a per-day play count for the last 30 days. */
  async usage() {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [agg, rows, users] = await Promise.all([
      this.prisma.mediaServerWatchHistory.aggregate({ _count: { _all: true }, _sum: { watchedSeconds: true } }),
      this.prisma.mediaServerWatchHistory.findMany({ where: { startedAt: { gte: since } }, select: { startedAt: true } }),
      this.prisma.mediaServerWatchHistory.groupBy({ by: ['userName'], _count: { _all: true } }),
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
  async users() {
    const grouped = await this.prisma.mediaServerWatchHistory.groupBy({
      by: ['userName'],
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
  async libraries() {
    const grouped = await this.prisma.mediaServerWatchHistory.groupBy({
      by: ['libraryName'],
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
  async playback() {
    const [byMethod, byType] = await Promise.all([
      this.prisma.mediaServerWatchHistory.groupBy({ by: ['playbackMethod'], _count: { _all: true } }),
      this.prisma.mediaServerWatchHistory.groupBy({ by: ['mediaType'], _count: { _all: true } }),
    ]);
    return {
      byMethod: byMethod.map((g) => ({ method: g.playbackMethod ?? 'unknown', plays: g._count._all })).sort((a, b) => b.plays - a.plays),
      byType: byType.map((g) => ({ type: g.mediaType ?? 'unknown', plays: g._count._all })).sort((a, b) => b.plays - a.plays),
    };
  }

  /**
   * Recently added — sourced from the Media Manager library (the primary source
   * of truth), grouped by media type.
   */
  async recentlyAdded(limit = 50) {
    const items = await this.prisma.mediaItem.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      select: { id: true, title: true, mediaType: true, year: true, season: true, episode: true, createdAt: true },
    });
    return items.map((i) => ({
      id: i.id,
      title: i.title,
      mediaType: i.mediaType,
      year: i.year,
      season: i.season,
      episode: i.episode,
      addedAt: i.createdAt,
    }));
  }
}
