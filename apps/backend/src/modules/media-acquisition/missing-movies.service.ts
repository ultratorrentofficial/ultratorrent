import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { WantedMovie } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/** Result of scanning one monitored movie. */
export interface MovieGap {
  watchlistItemId: string;
  title: string;
  movieTconst: string;
  status: string;
}

/** Per-movie summary row for the missing-movies overview. */
export interface MovieGapSummary {
  watchlistItemId: string;
  title: string;
  year: number | null;
  movieTconst: string | null;
  monitorable: boolean; // false when the watchlist item has no IMDb id
  status: string | null; // null = not scanned yet
  lastCheckedAt: Date | null;
}

/**
 * Missing-movie detection. For a monitored movie (a `movie` watchlist item
 * carrying an IMDb id), it checks whether the library owns the movie — by the
 * structured IMDb external-id link, falling back to a case-insensitive title
 * (+ year) match — and persists the result as a `WantedMovie` row. Detection
 * only; the watchlist item itself is what feeds the acquisition evaluator.
 */
@Injectable()
export class MissingMoviesService {
  private readonly logger = new Logger(MissingMoviesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Scan every active `movie` watchlist item. Skips ones without an IMDb id. */
  async scanAll(userId?: string): Promise<{ movies: number; missing: number }> {
    const items = await this.prisma.mediaAcquisitionWatchlistItem.findMany({
      where: { type: 'movie', status: 'active' },
    });
    let movies = 0;
    let missing = 0;
    for (const item of items) {
      try {
        const gap = await this.scanMovie(item.id, userId);
        movies += 1;
        if (gap.status === 'missing') missing += 1;
      } catch (err) {
        this.logger.debug(`Skipped movie ${item.id}: ${(err as Error).message}`);
      }
    }
    this.realtime.broadcast('media_acquisition.missing_movies.scan.completed', { movies, missing });
    return { movies, missing };
  }

  /** Scan one monitored movie and refresh its `WantedMovie` row. */
  async scanMovie(watchlistItemId: string, userId?: string): Promise<MovieGap> {
    const item = await this.prisma.mediaAcquisitionWatchlistItem.findUnique({
      where: { id: watchlistItemId },
    });
    if (!item) throw new NotFoundException('Watchlist item not found');
    if (item.type !== 'movie') throw new BadRequestException('Watchlist item is not a movie');
    const movieTconst = this.imdbId(item.externalIds);
    if (!movieTconst) throw new BadRequestException('Watchlist item has no IMDb id to scan');

    // Prefer the catalogue's title/year; fall back to the watchlist item's own.
    const titleRow = await this.prisma.iMDbTitle.findUnique({ where: { tconst: movieTconst } });
    const title = titleRow?.primaryTitle ?? item.title;
    const year = titleRow?.startYear ?? item.year ?? null;

    const owned = await this.isOwnedMovie(movieTconst, title, year);
    const existing = await this.prisma.wantedMovie.findUnique({ where: { watchlistItemId } });
    const currentYear = new Date().getFullYear();
    const status =
      existing?.status === 'ignored'
        ? 'ignored'
        : owned
          ? 'owned'
          : year == null || year > currentYear
            ? 'unaired'
            : 'missing';

    const row = await this.prisma.wantedMovie.upsert({
      where: { watchlistItemId },
      create: { watchlistItemId, movieTconst, title, year, status },
      update: { movieTconst, title, year, status, lastCheckedAt: new Date() },
    });

    await this.audit.record({
      userId,
      action: 'media_acquisition.missing_movies.scan',
      objectType: 'media_acquisition_watchlist',
      objectId: watchlistItemId,
      metadata: { status, movieTconst },
    });
    return { watchlistItemId, title, movieTconst, status: row.status };
  }

  /** Per-movie overview across all monitored (`movie`) watchlist items. */
  async listMissingMovies(): Promise<MovieGapSummary[]> {
    const items = await this.prisma.mediaAcquisitionWatchlistItem.findMany({
      where: { type: 'movie' },
      orderBy: [{ priority: 'asc' }, { title: 'asc' }],
    });
    const wanted = await this.prisma.wantedMovie.findMany({
      where: { watchlistItemId: { in: items.map((i) => i.id) } },
    });
    const byItem = new Map(wanted.map((w) => [w.watchlistItemId, w]));
    return items.map((item) => {
      const w = byItem.get(item.id);
      return {
        watchlistItemId: item.id,
        title: item.title,
        year: item.year,
        movieTconst: this.imdbId(item.externalIds),
        monitorable: this.imdbId(item.externalIds) != null,
        status: w?.status ?? null,
        lastCheckedAt: w?.lastCheckedAt ?? null,
      };
    });
  }

  /** User opt-out for a movie; survives future rescans. */
  async ignore(id: string, userId?: string): Promise<WantedMovie> {
    await this.getOrThrow(id);
    const updated = await this.prisma.wantedMovie.update({ where: { id }, data: { status: 'ignored' } });
    await this.audit.record({ userId, action: 'media_acquisition.missing_movies.ignored', objectType: 'wanted_movie', objectId: id });
    return updated;
  }

  /** Revert an ignore back to missing/unaired (ownership corrects on next scan). */
  async unignore(id: string, userId?: string): Promise<WantedMovie> {
    const row = await this.getOrThrow(id);
    const currentYear = new Date().getFullYear();
    const status = row.year == null || row.year > currentYear ? 'unaired' : 'missing';
    const updated = await this.prisma.wantedMovie.update({ where: { id }, data: { status } });
    await this.audit.record({ userId, action: 'media_acquisition.missing_movies.unignored', objectType: 'wanted_movie', objectId: id });
    return updated;
  }

  // --- internals ------------------------------------------------------------

  /** Whether the library owns this movie (structured IMDb link, then title+year). */
  private async isOwnedMovie(movieTconst: string, title: string, year: number | null): Promise<boolean> {
    const exts = await this.prisma.mediaExternalId.findMany({
      where: { provider: 'imdb', externalId: movieTconst },
      select: { itemId: true },
    });
    if (exts.length) {
      const item = await this.prisma.mediaItem.findFirst({
        where: { id: { in: exts.map((e) => e.itemId) }, mediaType: 'movie' },
        select: { id: true },
      });
      if (item) return true;
    }
    if (title) {
      const item = await this.prisma.mediaItem.findFirst({
        where: {
          mediaType: 'movie',
          title: { equals: title, mode: 'insensitive' },
          ...(year != null ? { year } : {}),
        },
        select: { id: true },
      });
      if (item) return true;
    }
    return false;
  }

  private async getOrThrow(id: string): Promise<WantedMovie> {
    const row = await this.prisma.wantedMovie.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Wanted movie not found');
    return row;
  }

  private imdbId(externalIds: unknown): string | null {
    if (!externalIds || typeof externalIds !== 'object') return null;
    const value = (externalIds as Record<string, unknown>).imdb;
    return typeof value === 'string' && value.startsWith('tt') ? value : null;
  }
}
