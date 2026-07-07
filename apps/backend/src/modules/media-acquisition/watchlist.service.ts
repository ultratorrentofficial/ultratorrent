import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import * as path from 'node:path';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { isSeasonContainer, showFolderRoot } from '../media/media-renamer';

/** A distinct series in the media libraries, for the watchlist "add from library" picker. */
export interface LibrarySeries {
  title: string;
  year: number | null;
  episodeCount: number;
  imdbId: string | null;
  monitorable: boolean;
  onWatchlist: boolean;
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
  targetLibraryId?: string;
  settings?: Record<string, unknown>;
}

/** Watchlist CRUD: what the user wants UltraTorrent to acquire. Audited. */
@Injectable()
export class AcquisitionWatchlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  list(status?: string) {
    return this.prisma.mediaAcquisitionWatchlistItem.findMany({ where: { status }, orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }] });
  }

  async get(id: string) {
    const item = await this.prisma.mediaAcquisitionWatchlistItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException(`Unknown watchlist item: ${id}`);
    return item;
  }

  async create(input: WatchlistInput, userId?: string) {
    const item = await this.prisma.mediaAcquisitionWatchlistItem.create({
      data: {
        type: input.type,
        title: input.title,
        normalizedTitle: input.title.toLowerCase().trim(),
        year: input.year,
        externalIds: (input.externalIds ?? undefined) as object | undefined,
        seasonNumber: input.seasonNumber,
        episodeNumber: input.episodeNumber,
        collectionName: input.collectionName,
        status: input.status ?? 'active',
        priority: input.priority ?? 100,
        profileId: input.profileId,
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
    const TV_TYPES = ['tv', 'anime', 'episode'];
    const items = await this.prisma.mediaItem.findMany({
      where: { mediaType: { in: TV_TYPES } },
      select: {
        title: true,
        year: true,
        path: true,
        seriesImdbId: true,
        externalIds: { where: { provider: 'imdb' }, select: { externalId: true }, take: 1 },
      },
    });
    if (items.length === 0) return [];

    // Library roots: a file whose show folder *is* a library root has no show
    // folder of its own — group it by its parsed title instead.
    const libraries = await this.prisma.mediaLibrary.findMany({ select: { path: true } });
    const roots = new Set(libraries.map((l) => this.normPath(l.path)));

    type Acc = { title: string; year: number | null; count: number; seriesId: string | null; extId: string | null };
    const groups = new Map<string, Acc>();

    for (const it of items) {
      const dir = showFolderRoot(it.path);
      const folder = path.basename(dir);
      // A genuine show folder: below a library root and not itself a season container.
      const isShowFolder = folder !== '' && !roots.has(this.normPath(dir)) && !isSeasonContainer(folder);
      const parsed = isShowFolder ? this.parseFolderTitle(folder) : { title: it.title, year: null };
      const key = isShowFolder ? `dir:${this.normPath(dir)}` : `title:${it.title.toLowerCase().trim()}`;

      const acc = groups.get(key);
      const extId = it.externalIds[0]?.externalId ?? null;
      const year = parsed.year ?? it.year ?? null;
      if (!acc) {
        groups.set(key, { title: parsed.title, year, count: 1, seriesId: it.seriesImdbId ?? null, extId });
      } else {
        acc.count += 1;
        acc.seriesId ??= it.seriesImdbId ?? null;
        acc.extId ??= extId;
        // Keep the earliest known year for the show.
        if (year != null && (acc.year == null || year < acc.year)) acc.year = year;
      }
    }

    // Already monitored? (any series watchlist item, by normalized title.)
    const existing = await this.prisma.mediaAcquisitionWatchlistItem.findMany({
      where: { type: 'series' },
      select: { normalizedTitle: true },
    });
    const onWatchlist = new Set(existing.map((e) => e.normalizedTitle));

    const q = search?.trim().toLowerCase();
    return [...groups.values()]
      .filter((g) => !q || g.title.toLowerCase().includes(q))
      .map((g) => {
        const imdbId = g.seriesId ?? g.extId ?? null;
        return {
          title: g.title,
          year: g.year,
          episodeCount: g.count,
          imdbId,
          monitorable: imdbId != null,
          onWatchlist: onWatchlist.has(g.title.toLowerCase().trim()),
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
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
      const norm = s.title.toLowerCase().trim();
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
    await this.get(id);
    const item = await this.prisma.mediaAcquisitionWatchlistItem.update({
      where: { id },
      data: {
        type: input.type ?? undefined,
        title: input.title ?? undefined,
        normalizedTitle: input.title ? input.title.toLowerCase().trim() : undefined,
        year: input.year === undefined ? undefined : input.year,
        seasonNumber: input.seasonNumber === undefined ? undefined : input.seasonNumber,
        episodeNumber: input.episodeNumber === undefined ? undefined : input.episodeNumber,
        collectionName: input.collectionName === undefined ? undefined : input.collectionName,
        status: input.status ?? undefined,
        priority: input.priority === undefined ? undefined : input.priority,
        profileId: input.profileId === undefined ? undefined : input.profileId,
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
