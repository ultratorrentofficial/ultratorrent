import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { WantedEpisode } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/** One episode from the local IMDb catalogue for a series. */
interface CatalogEpisode {
  episodeTconst: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  airYear: number | null;
}

/** Result of scanning one monitored series. */
export interface SeriesGap {
  watchlistItemId: string;
  title: string;
  seriesTconst: string;
  total: number;
  owned: number;
  missing: number;
  unaired: number;
  ignored: number;
  lastCheckedAt: Date;
}

/** Per-series summary row for the missing-episodes overview. */
export interface SeriesGapSummary {
  watchlistItemId: string;
  title: string;
  seriesTconst: string | null;
  monitorable: boolean; // false when the watchlist item has no IMDb id
  total: number;
  owned: number;
  missing: number;
  unaired: number;
  ignored: number;
  lastCheckedAt: Date | null;
}

const SPECIAL_SEASON = 0; // season 0 = specials, excluded from missing math (MVP)
const TITLE_CHUNK = 1000;

/**
 * Sonarr-style missing-episode detection. For a monitored series (a `series`/
 * `season` watchlist item carrying an IMDb id), it enumerates the local IMDb
 * episode catalogue, diffs it against what the library owns, and persists the
 * gaps as `WantedEpisode` rows. Detect + view only — no acquisition side effects.
 */
@Injectable()
export class MissingEpisodesService {
  private readonly logger = new Logger(MissingEpisodesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Scan every active `series` watchlist item. Skips ones without an IMDb id. */
  async scanAll(userId?: string): Promise<{ series: number; missing: number }> {
    const items = await this.prisma.mediaAcquisitionWatchlistItem.findMany({
      where: { type: 'series', status: 'active' },
    });
    let series = 0;
    let missing = 0;
    for (const item of items) {
      try {
        const result = await this.scanSeries(item.id, userId);
        series += 1;
        missing += result.missing;
        this.realtime.broadcast('media_acquisition.missing_episodes.scan.progress', {
          watchlistItemId: item.id,
          title: item.title,
          missing: result.missing,
        });
      } catch (err) {
        // A series with no IMDb id (or no catalogue) is skipped, not fatal.
        this.logger.debug(`Skipped series ${item.id}: ${(err as Error).message}`);
      }
    }
    return { series, missing };
  }

  /** Scan one monitored series and refresh its `WantedEpisode` rows. */
  async scanSeries(watchlistItemId: string, userId?: string): Promise<SeriesGap> {
    const item = await this.prisma.mediaAcquisitionWatchlistItem.findUnique({
      where: { id: watchlistItemId },
    });
    if (!item) throw new NotFoundException('Watchlist item not found');
    if (item.type !== 'series' && item.type !== 'season') {
      throw new BadRequestException('Watchlist item is not a monitorable series');
    }
    const seriesTconst = this.imdbId(item.externalIds);
    if (!seriesTconst) {
      throw new BadRequestException('Watchlist item has no IMDb id to scan');
    }

    const catalog = await this.listSeriesEpisodes(seriesTconst);
    const scoped =
      item.type === 'season' && item.seasonNumber != null
        ? catalog.filter((e) => e.seasonNumber === item.seasonNumber)
        : catalog;

    const owned = await this.ownedEpisodeSet(seriesTconst, item.title);

    // Preserve user "ignored" overrides across rescans; rebuild everything else.
    const existing = await this.prisma.wantedEpisode.findMany({ where: { watchlistItemId } });
    const ignoredKeys = new Set(
      existing.filter((w) => w.status === 'ignored').map((w) => this.key(w.seasonNumber, w.episodeNumber)),
    );
    await this.prisma.wantedEpisode.deleteMany({
      where: { watchlistItemId, status: { not: 'ignored' } },
    });

    const currentYear = new Date().getFullYear();
    const rows = scoped
      .filter((ep) => ep.seasonNumber !== SPECIAL_SEASON)
      .filter((ep) => !ignoredKeys.has(this.key(ep.seasonNumber, ep.episodeNumber)))
      .map((ep) => ({
        watchlistItemId,
        seriesTconst,
        episodeTconst: ep.episodeTconst,
        seasonNumber: ep.seasonNumber,
        episodeNumber: ep.episodeNumber,
        episodeTitle: ep.episodeTitle,
        airYear: ep.airYear,
        status: owned.has(this.key(ep.seasonNumber, ep.episodeNumber))
          ? 'owned'
          : ep.airYear == null || ep.airYear > currentYear
            ? 'unaired'
            : 'missing',
      }));

    if (rows.length) {
      await this.prisma.wantedEpisode.createMany({ data: rows, skipDuplicates: true });
    }

    const counts = await this.countByStatus(watchlistItemId);
    const gap: SeriesGap = {
      watchlistItemId,
      title: item.title,
      seriesTconst,
      lastCheckedAt: new Date(),
      ...counts,
    };

    await this.audit.record({
      userId,
      action: 'media_acquisition.missing_episodes.scan',
      objectType: 'media_acquisition_watchlist',
      objectId: watchlistItemId,
      metadata: { ...counts, seriesTconst },
    });
    this.realtime.broadcast('media_acquisition.missing_episodes.scan.completed', {
      watchlistItemId,
      ...counts,
    });
    return gap;
  }

  /** Per-series overview across all monitored (`series`/`season`) watchlist items. */
  async listGrouped(): Promise<SeriesGapSummary[]> {
    const items = await this.prisma.mediaAcquisitionWatchlistItem.findMany({
      where: { type: { in: ['series', 'season'] } },
      orderBy: [{ priority: 'asc' }, { title: 'asc' }],
    });
    const grouped = await this.prisma.wantedEpisode.groupBy({
      by: ['watchlistItemId', 'status'],
      _count: { _all: true },
    });
    const lastChecked = await this.prisma.wantedEpisode.groupBy({
      by: ['watchlistItemId'],
      _max: { lastCheckedAt: true },
    });
    const lastByItem = new Map(lastChecked.map((r) => [r.watchlistItemId, r._max.lastCheckedAt]));

    return items.map((item) => {
      const counts = { total: 0, owned: 0, missing: 0, unaired: 0, ignored: 0 };
      for (const g of grouped) {
        if (g.watchlistItemId !== item.id) continue;
        const n = g._count._all;
        counts.total += n;
        if (g.status in counts) (counts as Record<string, number>)[g.status] += n;
      }
      return {
        watchlistItemId: item.id,
        title: item.title,
        seriesTconst: this.imdbId(item.externalIds),
        monitorable: this.imdbId(item.externalIds) != null,
        ...counts,
        lastCheckedAt: lastByItem.get(item.id) ?? null,
      };
    });
  }

  /** All wanted-episode rows for one series, for the season/episode grid. */
  listForSeries(watchlistItemId: string): Promise<WantedEpisode[]> {
    return this.prisma.wantedEpisode.findMany({
      where: { watchlistItemId },
      orderBy: [{ seasonNumber: 'asc' }, { episodeNumber: 'asc' }],
    });
  }

  /** User opt-out for a single episode; survives future rescans. */
  async ignore(id: string, userId?: string): Promise<WantedEpisode> {
    await this.getOrThrow(id);
    const updated = await this.prisma.wantedEpisode.update({
      where: { id },
      data: { status: 'ignored' },
    });
    await this.audit.record({
      userId,
      action: 'media_acquisition.missing_episodes.ignored',
      objectType: 'wanted_episode',
      objectId: id,
    });
    return updated;
  }

  /** Revert an ignore back to missing/unaired (ownership corrects on next scan). */
  async unignore(id: string, userId?: string): Promise<WantedEpisode> {
    const row = await this.getOrThrow(id);
    const currentYear = new Date().getFullYear();
    const status = row.airYear == null || row.airYear > currentYear ? 'unaired' : 'missing';
    const updated = await this.prisma.wantedEpisode.update({
      where: { id },
      data: { status },
    });
    await this.audit.record({
      userId,
      action: 'media_acquisition.missing_episodes.unignored',
      objectType: 'wanted_episode',
      objectId: id,
    });
    return updated;
  }

  // --- internals ------------------------------------------------------------

  /** Enumerate a series' episodes from the local IMDb catalogue, with titles/years. */
  private async listSeriesEpisodes(seriesTconst: string): Promise<CatalogEpisode[]> {
    const eps = await this.prisma.iMDbEpisode.findMany({
      where: { parentTitleId: seriesTconst },
      orderBy: [{ seasonNumber: 'asc' }, { episodeNumber: 'asc' }],
    });
    const valid = eps.filter((e) => e.seasonNumber != null && e.episodeNumber != null);
    const ids = valid.map((e) => e.episodeTitleId);

    const titleMap = new Map<string, { primaryTitle: string; startYear: number | null }>();
    for (let i = 0; i < ids.length; i += TITLE_CHUNK) {
      const chunk = ids.slice(i, i + TITLE_CHUNK);
      const titles = await this.prisma.iMDbTitle.findMany({
        where: { tconst: { in: chunk } },
        select: { tconst: true, primaryTitle: true, startYear: true },
      });
      for (const t of titles) titleMap.set(t.tconst, { primaryTitle: t.primaryTitle, startYear: t.startYear });
    }

    return valid.map((e) => ({
      episodeTconst: e.episodeTitleId,
      seasonNumber: e.seasonNumber as number,
      episodeNumber: e.episodeNumber as number,
      episodeTitle: titleMap.get(e.episodeTitleId)?.primaryTitle ?? null,
      airYear: titleMap.get(e.episodeTitleId)?.startYear ?? null,
    }));
  }

  /**
   * Owned `season-episode` keys for a series. Primary path uses the structured
   * `seriesImdbId` link; falls back to case-insensitive title match for libraries
   * that haven't been re-identified yet.
   */
  private async ownedEpisodeSet(seriesTconst: string, seriesTitle: string): Promise<Set<string>> {
    let rows = await this.prisma.mediaItem.findMany({
      where: { seriesImdbId: seriesTconst, season: { not: null }, episode: { not: null } },
      select: { season: true, episode: true },
    });
    if (rows.length === 0 && seriesTitle) {
      rows = await this.prisma.mediaItem.findMany({
        where: {
          mediaType: { in: ['tv', 'anime'] },
          title: { equals: seriesTitle, mode: 'insensitive' },
          season: { not: null },
          episode: { not: null },
        },
        select: { season: true, episode: true },
      });
    }
    return new Set(rows.map((r) => this.key(r.season as number, r.episode as number)));
  }

  private async countByStatus(
    watchlistItemId: string,
  ): Promise<{ total: number; owned: number; missing: number; unaired: number; ignored: number }> {
    const grouped = await this.prisma.wantedEpisode.groupBy({
      by: ['status'],
      where: { watchlistItemId },
      _count: { _all: true },
    });
    const counts = { total: 0, owned: 0, missing: 0, unaired: 0, ignored: 0 };
    for (const g of grouped) {
      counts.total += g._count._all;
      if (g.status in counts) (counts as Record<string, number>)[g.status] += g._count._all;
    }
    return counts;
  }

  private async getOrThrow(id: string): Promise<WantedEpisode> {
    const row = await this.prisma.wantedEpisode.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Wanted episode not found');
    return row;
  }

  private key(season: number, episode: number): string {
    return `${season}-${episode}`;
  }

  private imdbId(externalIds: unknown): string | null {
    if (!externalIds || typeof externalIds !== 'object') return null;
    const value = (externalIds as Record<string, unknown>).imdb;
    return typeof value === 'string' && value.startsWith('tt') ? value : null;
  }
}
