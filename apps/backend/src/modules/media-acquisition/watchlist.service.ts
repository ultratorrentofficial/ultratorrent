import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

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
   */
  async librarySeries(search?: string): Promise<LibrarySeries[]> {
    const TV_TYPES = ['tv', 'anime', 'episode'];
    const where: Prisma.MediaItemWhereInput = { mediaType: { in: TV_TYPES } };
    if (search?.trim()) where.title = { contains: search.trim(), mode: 'insensitive' };

    const groups = await this.prisma.mediaItem.groupBy({
      by: ['title'],
      where,
      _count: { _all: true },
      _min: { year: true },
      orderBy: { title: 'asc' },
    });
    const titles = groups.map((g) => g.title);
    if (titles.length === 0) return [];

    // Preferred id: a resolved series tconst on any episode of the show.
    const withSeriesId = await this.prisma.mediaItem.findMany({
      where: { ...where, title: { in: titles }, seriesImdbId: { not: null } },
      select: { title: true, seriesImdbId: true },
      distinct: ['title'],
    });
    const seriesIdByTitle = new Map(withSeriesId.map((r) => [r.title, r.seriesImdbId as string]));

    // Fallback id: an `imdb` external id on any episode of the show.
    const extRows = await this.prisma.mediaExternalId.findMany({
      where: { provider: 'imdb', item: { title: { in: titles }, mediaType: { in: TV_TYPES } } },
      select: { externalId: true, item: { select: { title: true } } },
    });
    const extByTitle = new Map<string, string>();
    for (const r of extRows) if (!extByTitle.has(r.item.title)) extByTitle.set(r.item.title, r.externalId);

    // Already monitored? (active-or-any series watchlist item by normalized title.)
    const existing = await this.prisma.mediaAcquisitionWatchlistItem.findMany({
      where: { type: 'series' },
      select: { normalizedTitle: true },
    });
    const onWatchlist = new Set(existing.map((e) => e.normalizedTitle));

    return groups.map((g) => {
      const imdbId = seriesIdByTitle.get(g.title) ?? extByTitle.get(g.title) ?? null;
      return {
        title: g.title,
        year: g._min.year ?? null,
        episodeCount: g._count._all,
        imdbId,
        monitorable: imdbId != null,
        onWatchlist: onWatchlist.has(g.title.toLowerCase().trim()),
      };
    });
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
