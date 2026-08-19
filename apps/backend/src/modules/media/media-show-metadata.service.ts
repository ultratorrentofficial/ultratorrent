import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.module';
import { TmdbMetadataProvider, type MediaMetadataProvider } from './metadata-provider';
import type { AuditContext } from './media-metadata.service';
import { decodeSeriesKey } from './series-grouping';

/** The fields an operator may correct by hand. */
export interface ShowMetadataPatch {
  title?: string | null;
  originalTitle?: string | null;
  sortTitle?: string | null;
  overview?: string | null;
  year?: number | null;
  status?: string | null;
  networks?: string[];
  genres?: string[];
  studios?: string[];
  rating?: number | null;
  certification?: string | null;
  tags?: string[];
}

/**
 * A series' own metadata and season records.
 *
 * Television had none. A film carries `MediaMetadata` and the detail page reads
 * it; a show is a folder grouping episodes, so "the show's overview" was the
 * overview of whichever episode was asked, and there was nothing to edit. The
 * fields live in `MediaShowMetadata`; this owns fetching, correcting and the
 * season rows that hang off the same show.
 */
@Injectable()
export class MediaShowMetadataService {
  private readonly logger = new Logger(MediaShowMetadataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  private async requireShow(showId: string) {
    const show = await this.prisma.mediaShow.findUnique({ where: { id: showId } });
    if (!show) throw new NotFoundException('Show not found');
    return show;
  }

  /**
   * The show behind a browser key.
   *
   * The Library Browser addresses a show by the opaque key it groups episodes
   * with — a folder path or, for library-root files, a title — because that key
   * survives a page reload while a row object does not. Everything show-level
   * hangs off the `media_shows` id, so something has to translate between them.
   * Returns null rather than throwing: a folder that has never been scanned into
   * `media_shows` is an ordinary state, not an error.
   */
  async findByKey(key: string, libraryId?: string) {
    let decoded: { kind: 'dir' | 'title'; value: string };
    try {
      decoded = decodeSeriesKey(key);
    } catch {
      return null;
    }
    return this.prisma.mediaShow.findFirst({
      where: {
        ...(libraryId ? { libraryId } : {}),
        ...(decoded.kind === 'dir' ? { path: decoded.value } : { title: decoded.value }),
      },
    });
  }

  /** The show, its metadata and its seasons — one read for the detail screen. */
  async detail(showId: string) {
    const show = await this.requireShow(showId);
    const [metadata, seasons, artwork] = await Promise.all([
      this.prisma.mediaShowMetadata.findUnique({ where: { showId } }),
      this.prisma.mediaSeason.findMany({ where: { showId }, orderBy: { seasonNumber: 'asc' } }),
      this.prisma.mediaArtwork.findMany({
        where: { showId },
        orderBy: [{ seasonNumber: 'asc' }, { type: 'asc' }, { selected: 'desc' }],
      }),
    ]);
    return { show, metadata, seasons, artwork };
  }

  /**
   * Fetch the series from the metadata provider and store it.
   *
   * Queried by TITLE and year rather than by a stored id, because a show that
   * has never been enriched has no id to query with — and the id is one of the
   * things worth keeping from the answer: `tmdbId` is what the artwork provider
   * needs, and without it a show can never import art.
   */
  async refresh(showId: string, ctx: AuditContext = {}) {
    const show = await this.requireShow(showId);
    const provider = await this.provider();
    if (!provider) return { showId, refreshed: false, reason: 'no_provider' as const };

    const details = await provider.fetchDetails({
      kind: show.mediaType === 'anime' ? 'anime' : 'tv',
      title: show.title,
      year: show.year,
    });
    if (!details) return { showId, refreshed: false, reason: 'not_found' as const };

    const tmdbId = details.externalIds?.tmdb ?? null;
    const imdbId = details.externalIds?.imdb ?? null;
    const data = {
      title: details.title ?? show.title,
      originalTitle: details.originalTitle ?? null,
      sortTitle: details.sortTitle ?? null,
      overview: details.overview ?? null,
      firstAiredAt: details.releaseDate ? new Date(details.releaseDate) : null,
      year: details.year ?? show.year,
      // `studios` is what the provider calls a network for television.
      networks: (details.studios ?? []) as never,
      genres: (details.genres ?? []) as never,
      studios: (details.studios ?? []) as never,
      cast: (details.cast ?? []) as never,
      crew: (details.crew ?? []) as never,
      rating: details.rating ?? null,
      certification: details.certification ?? null,
      tags: (details.tags ?? []) as never,
      providerName: details.providerName ?? provider.name,
      fieldSources: (details.fieldSources ?? null) as never,
    };

    await this.prisma.mediaShowMetadata.upsert({
      where: { showId },
      create: { showId, ...data },
      update: data,
    });

    /*
     * Provider ids are recorded on the SHOW, not only in the metadata blob:
     * artwork import reads `tmdbId` directly, and an id buried in a JSON column
     * would be an id nothing can use. An existing id is never overwritten with
     * null — losing a working id to a lookup that came back thin is worse than
     * not refreshing at all.
     */
    if (tmdbId || imdbId) {
      await this.prisma.mediaShow.update({
        where: { id: showId },
        data: {
          ...(tmdbId ? { tmdbId } : {}),
          ...(imdbId && !show.imdbId ? { imdbId } : {}),
        },
      });
    }

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.show.metadata_refresh',
      objectType: 'media_show',
      objectId: showId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { provider: data.providerName, tmdbId, title: data.title },
    });

    return { showId, refreshed: true, provider: data.providerName, tmdbId };
  }

  /** Correct the record by hand. Only the named fields change. */
  async update(showId: string, patch: ShowMetadataPatch, ctx: AuditContext = {}) {
    await this.requireShow(showId);
    const data: Record<string, unknown> = {};
    for (const key of ['title', 'originalTitle', 'sortTitle', 'overview', 'status', 'certification'] as const) {
      if (patch[key] !== undefined) data[key] = patch[key];
    }
    if (patch.year !== undefined) data.year = patch.year;
    if (patch.rating !== undefined) data.rating = patch.rating;
    for (const key of ['networks', 'genres', 'studios', 'tags'] as const) {
      if (patch[key] !== undefined) data[key] = patch[key];
    }
    // An operator's correction is authored here, not by a provider, and saying
    // otherwise would make `fieldSources` lie about where a value came from.
    data.providerName = 'manual';

    const row = await this.prisma.mediaShowMetadata.upsert({
      where: { showId },
      create: { showId, ...data } as never,
      update: data as never,
    });

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.show.metadata_update',
      objectType: 'media_show',
      objectId: showId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { fields: Object.keys(data) },
    });
    return row;
  }

  /** Correct one season's own record. */
  async updateSeason(
    showId: string,
    seasonNumber: number,
    patch: { title?: string | null; overview?: string | null },
    ctx: AuditContext = {},
  ) {
    await this.requireShow(showId);
    const row = await this.prisma.mediaSeason.upsert({
      where: { showId_seasonNumber: { showId, seasonNumber } },
      create: { showId, seasonNumber, ...patch, providerName: 'manual' },
      update: { ...patch, providerName: 'manual' },
    });
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.show.season_update',
      objectType: 'media_show',
      objectId: showId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { seasonNumber, fields: Object.keys(patch) },
    });
    return row;
  }

  /**
   * Make sure a row exists for every season the show actually has on disk.
   *
   * Seasons are still DERIVED from the episodes — that is where the truth is —
   * and this only gives each one somewhere to keep a synopsis or a poster.
   */
  async syncSeasons(showId: string): Promise<number> {
    const show = await this.requireShow(showId);
    const rows = await this.prisma.mediaItem.findMany({
      where: { libraryId: show.libraryId, path: { startsWith: `${show.path}/` } },
      select: { season: true },
      distinct: ['season'],
    });
    const numbers = rows
      .map((r) => r.season)
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b);
    let created = 0;
    for (const seasonNumber of numbers) {
      const existing = await this.prisma.mediaSeason.findUnique({
        where: { showId_seasonNumber: { showId, seasonNumber } },
      });
      if (existing) continue;
      await this.prisma.mediaSeason.create({ data: { showId, seasonNumber } });
      created += 1;
    }
    return created;
  }

  private async provider(): Promise<MediaMetadataProvider | null> {
    const key =
      (await this.settings.get<string>('media.tmdbApiKey')) ?? process.env.TMDB_API_KEY;
    return key ? new TmdbMetadataProvider(key) : null;
  }
}
