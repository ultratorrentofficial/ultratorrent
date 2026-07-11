import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import * as path from 'node:path';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { isSeasonContainer, showFolderRoot } from '../media/media-renamer';
import { TvShowStatusService } from '../rss/tv-show-status/tv-show-status.service';
import { normalizeTitle } from '../rss/tv-show-status/tv-show-status-provider';
import { parseTorrentName } from '../rss/torrent-name-parser';
import { ImdbSeriesResolver, type ResolvedSeries } from './imdb-series-resolver.service';

/** Shows healed per picker load. Bounded so the background pass stays cheap; the
 * rest are picked up on the next open (or in one shot via the explicit sweep). */
const BACKGROUND_HEAL_LIMIT = 200;
/** Ceiling for an explicitly-triggered sweep. */
const DEFAULT_HEAL_LIMIT = 2000;
/**
 * Minimum gap between *background* heals. Shows the catalogue can't match stay
 * candidates forever, so without this every picker load would re-attempt them —
 * and each attempt re-reads the catalogue's TV slice. The explicit sweep ignores it.
 */
const BACKGROUND_HEAL_COOLDOWN_MS = 10 * 60_000;

/**
 * The **series** title for a monitored show, collapsing an episode-formatted
 * value to its series name so a downloaded episode ("90 Day Fiance - S12E09")
 * can't masquerade as its own series on the watchlist. Only rewrites when the
 * release parser actually detects a season/episode token — a clean show title
 * (incl. numeric/`SxxExx`-looking names like "9-1-1", "1923") is left untouched.
 */
function seriesTitleOf(raw: string): string {
  const parsed = parseTorrentName(raw);
  const hasEpisodeToken =
    parsed.season != null || parsed.episode != null || parsed.absoluteEpisode != null;
  return hasEpisodeToken && parsed.title?.trim() ? parsed.title.trim() : raw.trim();
}

/**
 * Fold the submitted provider ids into the stored ones. Merging rather than
 * replacing means an edit form that only carries `imdb` can't wipe a `tvdb`/`tmdb`
 * id it never showed the user. A blank value clears just that provider; once no
 * provider is left the column goes back to NULL.
 */
export function mergeExternalIds(
  current: Prisma.JsonValue | null | undefined,
  patch: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (patch == null) return undefined;
  const base =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  const merged: Record<string, string> = {};
  for (const [provider, raw] of Object.entries({ ...base, ...patch })) {
    const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw);
    if (value) merged[provider] = value;
  }
  return Object.keys(merged).length > 0 ? merged : Prisma.JsonNull;
}

/** A distinct series in the media libraries, for the watchlist "add from library" picker. */
export interface LibrarySeries {
  title: string;
  year: number | null;
  episodeCount: number;
  imdbId: string | null;
  monitorable: boolean;
  onWatchlist: boolean;
  /** Cached TV airing status (continuing|returning|ended|canceled|on_hiatus|planned|unknown) or null if not yet resolved. */
  showStatus: string | null;
  recommendation: string | null;
}

/** One show as the library sees it, collapsed from its `MediaItem` rows. */
interface LibraryShowGroup {
  title: string;
  year: number | null;
  count: number;
  /** IMDb id from the item's own `seriesImdbId` … */
  seriesId: string | null;
  /** … or from a linked `imdb` external id. */
  extId: string | null;
  /** Every `MediaItem` of this show — the rows a healed id is written back to. */
  itemIds: string[];
}

/** Outcome of an IMDb-id heal pass over the library. */
export interface LibraryImdbHealSummary {
  /** Shows with no IMDb id at all. */
  candidates: number;
  /** Of those, how many this pass tried (bounded by `limit`). */
  attempted: number;
  resolved: number;
  /** Attempted but not confidently matched in the catalogue. */
  unresolved: number;
}

export interface WatchlistInput {
  type: string;
  title: string;
  year?: number;
  externalIds?: Record<string, unknown>;
  seasonNumber?: number;
  episodeNumber?: number;
  collectionName?: string;
  status?: string;
  priority?: number;
  profileId?: string;
  rssRuleId?: string | null;
  targetLibraryId?: string;
  settings?: Record<string, unknown>;
}

/** Watchlist CRUD: what the user wants UltraTorrent to acquire. Audited. */
@Injectable()
export class AcquisitionWatchlistService {
  private readonly logger = new Logger(AcquisitionWatchlistService.name);
  /** Claimed synchronously so two overlapping picker loads can't sweep at once. */
  private healing = false;
  private lastBackgroundHealAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly moduleRef: ModuleRef,
    private readonly resolver: ImdbSeriesResolver,
  ) {}

  list(status?: string) {
    // Alphabetical by title for the watchlist view. `normalizedTitle` is the
    // lower-cased title, so ordering by it is case-insensitive (e.g. "apple"
    // and "Apple" sort together, not all-caps first). `createdAt` breaks ties.
    return this.prisma.mediaAcquisitionWatchlistItem.findMany({ where: { status }, orderBy: [{ normalizedTitle: 'asc' }, { createdAt: 'desc' }] });
  }

  async get(id: string) {
    const item = await this.prisma.mediaAcquisitionWatchlistItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException(`Unknown watchlist item: ${id}`);
    return item;
  }

  async create(input: WatchlistInput, userId?: string) {
    // A series/season monitors a whole show — never a single episode. Collapse an
    // episode-formatted title to its series name so "90 Day Fiance - S12E09" is
    // stored (and monitored) as "90 Day Fiance".
    const title =
      input.type === 'series' || input.type === 'season'
        ? seriesTitleOf(input.title)
        : input.title;
    const item = await this.prisma.mediaAcquisitionWatchlistItem.create({
      data: {
        type: input.type,
        title,
        normalizedTitle: title.toLowerCase().trim(),
        year: input.year,
        externalIds: (input.externalIds ?? undefined) as object | undefined,
        seasonNumber: input.seasonNumber,
        episodeNumber: input.episodeNumber,
        collectionName: input.collectionName,
        status: input.status ?? 'active',
        priority: input.priority ?? 100,
        profileId: input.profileId,
        rssRuleId: input.rssRuleId ?? undefined,
        targetLibraryId: input.targetLibraryId,
        settings: (input.settings ?? undefined) as object | undefined,
        createdBy: userId,
      },
    });
    await this.audit.record({ userId, action: 'media_acquisition.watchlist.created', objectType: 'media_acquisition_watchlist', objectId: item.id });
    this.realtime.broadcast('media_acquisition.watchlist.updated', { id: item.id, action: 'created' });
    return item;
  }

  /**
   * Distinct TV/anime series already in the media libraries, for the
   * "add series from library" picker — so a user can multi-select shows to
   * monitor instead of hand-typing each title + IMDb id. Each row carries a
   * best-effort series IMDb id (the resolved `seriesImdbId` if present, else an
   * episode's `imdb` external id), whether it's monitorable (has an id), and
   * whether it's already on the watchlist.
   *
   * Series are grouped by their **show folder** (the item's path climbed past any
   * `Season NN`/`Specials` container), not by `MediaItem.title`: for a
   * folder-organised show like "9-1-1" the parsed per-file title is the *episode*
   * name (the identifier keeps the basename title when it finds one), so grouping
   * by title emitted a bogus row per episode. The folder name is the authoritative
   * series title. Files sitting directly at a library root (no show folder) fall
   * back to their parsed title, which for a `SxxExx` filename is the series.
   */
  async librarySeries(search?: string): Promise<LibrarySeries[]> {
    const groups = await this.groupLibraryShows();
    if (groups.size === 0) return [];

    // Already monitored? (any series watchlist item, by normalized title.)
    const existing = await this.prisma.mediaAcquisitionWatchlistItem.findMany({
      where: { type: 'series' },
      select: { normalizedTitle: true },
    });
    const onWatchlist = new Set(existing.map((e) => e.normalizedTitle));

    // Cached TV airing status, keyed by normalized title (fast; no provider calls).
    const statusRows = await this.prisma.tvShowStatus.findMany({
      select: { normalizedTitle: true, normalizedStatus: true, recommendation: true },
    });
    const statusByTitle = new Map(statusRows.map((r) => [r.normalizedTitle, r]));

    const q = search?.trim().toLowerCase();
    const result = [...groups.values()]
      .filter((g) => !q || g.title.toLowerCase().includes(q))
      .map((g) => {
        const imdbId = g.seriesId ?? g.extId ?? null;
        const st = statusByTitle.get(normalizeTitle(g.title));
        return {
          title: g.title,
          year: g.year,
          episodeCount: g.count,
          imdbId,
          monitorable: imdbId != null,
          onWatchlist: onWatchlist.has(g.title.toLowerCase().trim()),
          showStatus: st?.normalizedStatus ?? null,
          recommendation: st?.recommendation ?? null,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));

    // Warm the status cache for shows we don't know yet — best-effort and in the
    // background so the list returns immediately; a later open shows the badge.
    const uncached = result.filter((r) => !r.showStatus).slice(0, 10);
    if (uncached.length) void this.warmShowStatuses(uncached);

    // Same idea for missing IMDb ids: a show identified against TVDB (or never
    // identified at all) has no tconst, so it reads as unmonitorable here and the
    // user can't add it. Heal a bounded batch from the local IMDb catalogue in the
    // background — the list returns now, and the next open shows the ids.
    const now = Date.now();
    if (result.some((r) => !r.imdbId) && now - this.lastBackgroundHealAt > BACKGROUND_HEAL_COOLDOWN_MS) {
      this.lastBackgroundHealAt = now;
      void this.healLibraryImdbIds({ limit: BACKGROUND_HEAL_LIMIT });
    }

    return result;
  }

  /**
   * Fill in `MediaItem.seriesImdbId` for library shows that have no IMDb id, by
   * resolving their title (+year) against the local IMDb catalogue.
   *
   * Why this is needed: identification may have matched a show against TVDB (or
   * not at all), which leaves the IMDb tconst null. Everything downstream —
   * the add-from-library picker's `monitorable` flag, missing-episode scans — keys
   * off the IMDb id, so those shows are silently un-addable and un-scannable.
   *
   * The id is written onto every `MediaItem` of the show, so the heal is permanent
   * and also repairs owned-episode matching. Shows the catalogue can't confidently
   * resolve are left alone (and simply retried on a later pass).
   */
  async healLibraryImdbIds(
    opts: { limit?: number; userId?: string } = {},
  ): Promise<LibraryImdbHealSummary> {
    const summary: LibraryImdbHealSummary = { candidates: 0, attempted: 0, resolved: 0, unresolved: 0 };
    if (this.healing) return summary; // a sweep is already running
    this.healing = true;
    try {
      const groups = await this.groupLibraryShows();
      const missing = [...groups.values()].filter((g) => !(g.seriesId ?? g.extId));
      summary.candidates = missing.length;

      const batch = missing.slice(0, opts.limit ?? DEFAULT_HEAL_LIMIT);
      summary.attempted = batch.length;

      for (const show of batch) {
        let best: ResolvedSeries | null = null;
        try {
          best = await this.resolver.resolve(show.title, show.year);
        } catch (err) {
          // One bad title must not abort the sweep.
          this.logger.warn(`IMDb heal failed for "${show.title}": ${(err as Error).message}`);
        }
        if (!best) {
          summary.unresolved += 1;
          continue;
        }
        await this.prisma.mediaItem.updateMany({
          where: { id: { in: show.itemIds } },
          data: { seriesImdbId: best.tconst },
        });
        summary.resolved += 1;
        this.logger.log(
          `Healed IMDb id ${best.tconst} for library show "${show.title}"` +
            ` (${show.itemIds.length} items, ${best.episodes} catalogued episodes)`,
        );
        await this.audit
          .record({
            userId: opts.userId,
            action: 'media_acquisition.library.imdb_resolved',
            objectType: 'media_item',
            objectId: show.itemIds[0],
            metadata: {
              imdbId: best.tconst,
              title: show.title,
              year: show.year,
              items: show.itemIds.length,
              episodes: best.episodes,
              via: 'library_imdb_heal',
            },
          })
          .catch(() => undefined);
      }

      if (summary.resolved > 0) {
        this.realtime.broadcast('media_acquisition.library.imdb_healed', summary);
      }
      return summary;
    } finally {
      this.healing = false;
    }
  }

  /**
   * Collapse the TV items in every library into one entry per **show**, keyed by
   * its show folder (or, for a loose file at a library root, its parsed series
   * title). Shared by the add-from-library picker and the IMDb heal so both agree
   * on what a "show" is.
   */
  private async groupLibraryShows(): Promise<Map<string, LibraryShowGroup>> {
    const TV_TYPES = ['tv', 'anime', 'episode'];
    const groups = new Map<string, LibraryShowGroup>();
    const items = await this.prisma.mediaItem.findMany({
      where: { mediaType: { in: TV_TYPES } },
      select: {
        id: true,
        title: true,
        year: true,
        path: true,
        seriesImdbId: true,
        externalIds: { where: { provider: 'imdb' }, select: { externalId: true }, take: 1 },
      },
    });
    if (items.length === 0) return groups;

    // Library roots: a file whose show folder *is* a library root has no show
    // folder of its own — group it by its parsed title instead.
    const libraries = await this.prisma.mediaLibrary.findMany({ select: { path: true } });
    const roots = new Set(libraries.map((l) => this.normPath(l.path)));

    for (const it of items) {
      const dir = showFolderRoot(it.path);
      const folder = path.basename(dir);
      // A genuine show folder: below a library root and not itself a season container.
      const isShowFolder = folder !== '' && !roots.has(this.normPath(dir)) && !isSeasonContainer(folder);
      // Loose file at a library root (no show folder): parse the series out of
      // its title so an episode name ("90 Day Fiance - S12E09") groups under the
      // series, not as its own bogus "show".
      const parsed = isShowFolder
        ? this.parseFolderTitle(folder)
        : { title: seriesTitleOf(it.title), year: null };
      // Key loose files by their parsed series title so every episode of a show
      // collapses into one group (not one bogus "show" per episode).
      const key = isShowFolder ? `dir:${this.normPath(dir)}` : `title:${parsed.title.toLowerCase().trim()}`;

      const acc = groups.get(key);
      const extId = it.externalIds[0]?.externalId ?? null;
      const year = parsed.year ?? it.year ?? null;
      if (!acc) {
        groups.set(key, {
          title: parsed.title,
          year,
          count: 1,
          seriesId: it.seriesImdbId ?? null,
          extId,
          itemIds: [it.id],
        });
      } else {
        acc.count += 1;
        acc.seriesId ??= it.seriesImdbId ?? null;
        acc.extId ??= extId;
        acc.itemIds.push(it.id);
        // Keep the earliest known year for the show.
        if (year != null && (acc.year == null || year < acc.year)) acc.year = year;
      }
    }
    return groups;
  }

  /** Background: resolve + cache airing status for a bounded set of shows. */
  private async warmShowStatuses(series: { title: string; year: number | null }[]): Promise<void> {
    try {
      const svc = this.moduleRef.get(TvShowStatusService, { strict: false });
      for (const s of series) {
        await svc.lookup({ title: s.title, year: s.year ?? undefined }).catch(() => undefined);
      }
    } catch {
      /* status warming is best-effort — never blocks the picker */
    }
  }

  /** Normalize a filesystem path for use as a grouping key (drop trailing slash, lowercase). */
  private normPath(p: string): string {
    return p.replace(/[/\\]+$/, '').toLowerCase();
  }

  /**
   * Split a show-folder name into a clean title + optional year, e.g.
   * `"9-1-1 (2018)"` → `{ title: '9-1-1', year: 2018 }`. Only a parenthesised
   * 4-digit year is stripped, so numeric/hyphenated titles ("9-1-1", "1899")
   * are left intact.
   */
  private parseFolderTitle(name: string): { title: string; year: number | null } {
    const m = name.match(/^(.*?)[\s._]*\((\d{4})\)\s*$/);
    if (m) return { title: m[1].trim(), year: Number(m[2]) };
    return { title: name.trim(), year: null };
  }

  /**
   * Add many series to the watchlist at once (from the library picker). Skips
   * shows already present (by normalized title); each add is audited via
   * {@link create}. Returns how many were added vs skipped.
   */
  async bulkCreate(
    series: Array<{ title: string; year?: number | null; imdbId?: string | null }>,
    userId?: string,
  ): Promise<{ added: number; skipped: number }> {
    const existing = await this.prisma.mediaAcquisitionWatchlistItem.findMany({
      where: { type: 'series' },
      select: { normalizedTitle: true },
    });
    const have = new Set(existing.map((e) => e.normalizedTitle));
    let added = 0;
    let skipped = 0;
    for (const s of series) {
      // Dedup on the collapsed series title (matching what `create` stores), so
      // two episodes of one show don't each add a duplicate "series".
      const norm = seriesTitleOf(s.title).toLowerCase().trim();
      if (!norm || have.has(norm)) {
        skipped++;
        continue;
      }
      await this.create(
        {
          type: 'series',
          title: s.title,
          year: s.year ?? undefined,
          externalIds: s.imdbId ? { imdb: s.imdbId } : undefined,
        },
        userId,
      );
      have.add(norm);
      added++;
    }
    return { added, skipped };
  }

  async update(id: string, input: Partial<WatchlistInput>, userId?: string) {
    const existing = await this.get(id);
    const item = await this.prisma.mediaAcquisitionWatchlistItem.update({
      where: { id },
      data: {
        type: input.type ?? undefined,
        title: input.title ?? undefined,
        normalizedTitle: input.title ? input.title.toLowerCase().trim() : undefined,
        year: input.year === undefined ? undefined : input.year,
        externalIds: mergeExternalIds(existing.externalIds, input.externalIds),
        seasonNumber: input.seasonNumber === undefined ? undefined : input.seasonNumber,
        episodeNumber: input.episodeNumber === undefined ? undefined : input.episodeNumber,
        collectionName: input.collectionName === undefined ? undefined : input.collectionName,
        status: input.status ?? undefined,
        priority: input.priority === undefined ? undefined : input.priority,
        profileId: input.profileId === undefined ? undefined : input.profileId,
        rssRuleId: input.rssRuleId === undefined ? undefined : input.rssRuleId,
        targetLibraryId: input.targetLibraryId === undefined ? undefined : input.targetLibraryId,
        settings: input.settings === undefined ? undefined : (input.settings as object),
      },
    });
    await this.audit.record({ userId, action: 'media_acquisition.watchlist.updated', objectType: 'media_acquisition_watchlist', objectId: id });
    this.realtime.broadcast('media_acquisition.watchlist.updated', { id, action: 'updated' });
    return item;
  }

  async remove(id: string, userId?: string) {
    await this.get(id);
    await this.prisma.mediaAcquisitionWatchlistItem.delete({ where: { id } });
    // Wanted rows are loosely coupled by id (no FK), so clean them up here.
    await this.prisma.wantedEpisode.deleteMany({ where: { watchlistItemId: id } });
    await this.prisma.wantedMovie.deleteMany({ where: { watchlistItemId: id } });
    await this.audit.record({ userId, action: 'media_acquisition.watchlist.deleted', objectType: 'media_acquisition_watchlist', objectId: id });
    this.realtime.broadcast('media_acquisition.watchlist.updated', { id, action: 'deleted' });
    return { ok: true as const };
  }
}
