import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { WantedEpisode } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TvShowStatusService } from '../rss/tv-show-status/tv-show-status.service';
import { normalizeTitle } from '../rss/tv-show-status/tv-show-status-provider';

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
  /**
   * Cached TV airing status (continuing|returning|planned|on_hiatus|ended|
   * canceled|unknown) or null if not yet resolved. Read from the shared
   * `tv_show_status` cache; uncached shows are warmed in the background so a
   * later load shows the badge.
   */
  showStatus: string | null;
}

/** Per-season rollup for missing-season detection. */
export interface SeasonSummary {
  seasonNumber: number;
  total: number;
  owned: number;
  missing: number;
  unaired: number;
  ignored: number;
  complete: boolean; // no missing episodes
}

const SPECIAL_SEASON = 0; // season 0 = specials, excluded from missing math (MVP)
const TITLE_CHUNK = 1000;

/**
 * Punctuation-insensitive title key for matching against the IMDb catalogue.
 * Lowercases, turns `&` into `and`, then strips every non-alphanumeric char (incl.
 * spaces) so `:` / `.` / `'` / spacing differences collapse — e.g. "Chicago P.D."
 * and "Chicago PD", or "FBI: Most Wanted" and "FBI Most Wanted", share a key.
 */
function catalogueTitleKey(title: string): string {
  return title.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

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
    private readonly moduleRef: ModuleRef,
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
    let seriesTconst = this.imdbId(item.externalIds);
    let healed = false;
    if (!seriesTconst) {
      // Self-heal: a series added without an IMDb id can't be scanned. Try to
      // resolve one from the local IMDb catalogue by title (+year) and persist
      // it, so the scheduled scan auto-enables monitoring on the next run
      // instead of silently skipping the show forever.
      seriesTconst = await this.resolveAndPersistImdbId(item, userId);
      healed = true;
    }
    if (!seriesTconst) {
      throw new BadRequestException('Watchlist item has no IMDb id to scan');
    }

    let catalog = await this.listSeriesEpisodes(seriesTconst);
    // Self-heal a present-but-WRONG id: a stored tconst with no catalogue
    // episodes is almost always an episode/movie/stub id (the show was
    // mis-identified when it was added — e.g. "Silo" pinned to an episode
    // tt16091606 instead of the series tt14688458), not the series parent, so
    // the scan would silently find nothing forever. Re-resolve from the title
    // once and retry; the resolver only accepts a tvSeries/tvMiniSeries that has
    // episodes and persists the correction.
    if (catalog.length === 0 && !healed) {
      const corrected = await this.resolveAndPersistImdbId(item, userId);
      if (corrected && corrected !== seriesTconst) {
        seriesTconst = corrected;
        catalog = await this.listSeriesEpisodes(seriesTconst);
      }
    }
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
    // Also preserve acquisition (search/grab) state — otherwise the delete+recreate
    // below would forget that a still-missing episode was already searched or
    // grabbed and re-trigger it. Only carried onto rows that remain `missing`.
    const grabStateByKey = new Map(
      existing
        .filter((w) => w.status !== 'ignored' && w.searchStatus !== 'idle')
        .map((w) => [
          this.key(w.seasonNumber, w.episodeNumber),
          {
            searchStatus: w.searchStatus,
            lastSearchedAt: w.lastSearchedAt,
            grabbedAt: w.grabbedAt,
            grabbedEvaluationId: w.grabbedEvaluationId,
            downloadUrl: w.downloadUrl,
            releaseTitle: w.releaseTitle,
          },
        ]),
    );
    await this.prisma.wantedEpisode.deleteMany({
      where: { watchlistItemId, status: { not: 'ignored' } },
    });

    const currentYear = new Date().getFullYear();
    const rows = scoped
      .filter((ep) => ep.seasonNumber !== SPECIAL_SEASON)
      .filter((ep) => !ignoredKeys.has(this.key(ep.seasonNumber, ep.episodeNumber)))
      .map((ep) => {
        const status = owned.has(this.key(ep.seasonNumber, ep.episodeNumber))
          ? 'owned'
          : ep.airYear == null || ep.airYear > currentYear
            ? 'unaired'
            : 'missing';
        const base = {
          watchlistItemId,
          seriesTconst,
          episodeTconst: ep.episodeTconst,
          seasonNumber: ep.seasonNumber,
          episodeNumber: ep.episodeNumber,
          episodeTitle: ep.episodeTitle,
          airYear: ep.airYear,
          status,
        };
        // A now-owned episode's grab succeeded (or it was sideloaded) — drop the
        // grab-state; an unaired one resets to idle. Only a still-missing episode
        // keeps its prior search/grab state.
        const preserved = status === 'missing' ? grabStateByKey.get(this.key(ep.seasonNumber, ep.episodeNumber)) : undefined;
        return preserved ? { ...base, ...preserved } : base;
      });

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

    // Cached TV airing status, keyed by normalized title (fast; no provider
    // calls). Same read-only cache the "add from library" picker uses.
    const statusRows = await this.prisma.tvShowStatus.findMany({
      select: { normalizedTitle: true, normalizedStatus: true },
    });
    const statusByTitle = new Map(statusRows.map((r) => [r.normalizedTitle, r.normalizedStatus]));

    const summaries = items.map((item) => {
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
        showStatus: statusByTitle.get(normalizeTitle(item.title)) ?? null,
      };
    });

    // Warm the status cache for shows we don't know yet — bounded, best-effort,
    // and in the background so the list returns immediately; a later load shows
    // the badge.
    const uncached = items
      .filter((item) => !statusByTitle.has(normalizeTitle(item.title)))
      .slice(0, 10)
      .map((item) => ({ title: item.title, year: item.year }));
    if (uncached.length) void this.warmShowStatuses(uncached);

    return summaries;
  }

  /** Background: resolve + cache airing status for a bounded set of shows. */
  private async warmShowStatuses(series: { title: string; year: number | null }[]): Promise<void> {
    try {
      const svc = this.moduleRef.get(TvShowStatusService, { strict: false });
      for (const s of series) {
        await svc.lookup({ title: s.title, year: s.year ?? undefined }).catch(() => undefined);
      }
    } catch {
      /* status warming is best-effort — never blocks the overview */
    }
  }

  /** All wanted-episode rows for one series, for the season/episode grid. */
  listForSeries(watchlistItemId: string): Promise<WantedEpisode[]> {
    return this.prisma.wantedEpisode.findMany({
      where: { watchlistItemId },
      orderBy: [{ seasonNumber: 'asc' }, { episodeNumber: 'asc' }],
    });
  }

  /**
   * Per-season rollup of a monitored series — missing-season detection. A season
   * is "incomplete" when it has any missing episode, and "complete" when every
   * aired episode is owned. Derived from the `WantedEpisode` rows (no extra
   * storage), so it always reflects the latest scan.
   */
  async listSeasons(watchlistItemId: string): Promise<SeasonSummary[]> {
    const rows = await this.prisma.wantedEpisode.findMany({
      where: { watchlistItemId },
      select: { seasonNumber: true, status: true },
    });
    const bySeason = new Map<number, SeasonSummary>();
    for (const r of rows) {
      let s = bySeason.get(r.seasonNumber);
      if (!s) {
        s = { seasonNumber: r.seasonNumber, total: 0, owned: 0, missing: 0, unaired: 0, ignored: 0, complete: true };
        bySeason.set(r.seasonNumber, s);
      }
      s.total += 1;
      if (r.status in s) (s as unknown as Record<string, number>)[r.status] += 1;
    }
    return [...bySeason.values()]
      .map((s) => ({ ...s, complete: s.missing === 0 }))
      .sort((a, b) => a.seasonNumber - b.seasonNumber);
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

  /**
   * Best-effort auto-resolution of a monitored series' IMDb tconst from the local
   * catalogue, by exact title (+year when the watchlist item has one), preferring
   * the candidate with the most catalogued episodes (the real, long-running
   * series over same-named stubs — e.g. "9-1-1" 2018/143 eps beats "9-1-1"
   * 1991/0 eps). Persists the id onto the item's `externalIds` and audits it, so
   * scanning self-enables on the next scheduled run. Returns null when there is
   * no confident match (no title match, or no candidate has any episodes).
   */
  private async resolveAndPersistImdbId(
    item: { id: string; title: string; year: number | null; externalIds: unknown },
    userId?: string,
  ): Promise<string | null> {
    let candidates = await this.prisma.iMDbTitle.findMany({
      where: {
        primaryTitle: { equals: item.title, mode: 'insensitive' },
        titleType: { in: ['tvSeries', 'tvMiniSeries'] },
        ...(item.year ? { startYear: item.year } : {}),
      },
      select: { tconst: true, startYear: true },
      take: 10,
    });
    // Fallback: punctuation-insensitive match. Names sourced from RSS rules strip
    // ':' '&' '.' etc. ("FBI Most Wanted" vs IMDb "FBI: Most Wanted", "Chicago PD"
    // vs "Chicago P.D."), so the exact match above misses. Gated on `year` and a
    // first-word prefix so it stays on the (titleType, startYear) index and never
    // scans the full catalogue; matched by a punctuation-stripped key.
    if (candidates.length === 0 && item.year) {
      const firstWord = item.title.match(/[a-z0-9]+/i)?.[0];
      if (firstWord) {
        const want = catalogueTitleKey(item.title);
        const pool = await this.prisma.iMDbTitle.findMany({
          where: {
            titleType: { in: ['tvSeries', 'tvMiniSeries'] },
            startYear: item.year,
            primaryTitle: { startsWith: firstWord, mode: 'insensitive' },
          },
          select: { tconst: true, primaryTitle: true, startYear: true },
          take: 200,
        });
        candidates = pool
          .filter((c) => catalogueTitleKey(c.primaryTitle) === want)
          .map((c) => ({ tconst: c.tconst, startYear: c.startYear }));
      }
    }
    if (candidates.length === 0) return null;

    let best: { tconst: string; startYear: number | null } | null = null;
    let bestEpisodes = -1;
    for (const c of candidates) {
      const episodes = await this.prisma.iMDbEpisode.count({ where: { parentTitleId: c.tconst } });
      if (episodes > bestEpisodes || (episodes === bestEpisodes && (c.startYear ?? 0) > (best?.startYear ?? 0))) {
        best = c;
        bestEpisodes = episodes;
      }
    }
    // Require at least one catalogued episode: an empty match can't be scanned
    // and is far more likely to be the wrong (stub) title.
    if (!best || bestEpisodes <= 0) return null;

    const base = typeof item.externalIds === 'object' && item.externalIds ? (item.externalIds as object) : {};
    await this.prisma.mediaAcquisitionWatchlistItem.update({
      where: { id: item.id },
      data: { externalIds: { ...base, imdb: best.tconst } },
    });
    this.logger.log(
      `Auto-resolved IMDb id ${best.tconst} for watchlist series "${item.title}" (${bestEpisodes} catalogued episodes)`,
    );
    await this.audit
      .record({
        userId,
        action: 'media_acquisition.watchlist.imdb_resolved',
        objectType: 'media_acquisition_watchlist_item',
        objectId: item.id,
        metadata: { imdbId: best.tconst, title: item.title, episodes: bestEpisodes, via: 'missing_episode_scan' },
      })
      .catch(() => undefined);
    return best.tconst;
  }
}
