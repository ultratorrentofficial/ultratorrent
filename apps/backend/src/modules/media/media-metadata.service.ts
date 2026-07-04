import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../settings/settings.module';
import { FilePathService } from '../files/file-path.service';
import { AuditService } from '../audit/audit.service';
import { ImdbService } from './imdb/imdb.service';
import {
  LocalMetadataProvider,
  MediaLookup,
  MediaMetadataDetails,
  MediaMetadataProvider,
  TmdbMetadataProvider,
} from './metadata-provider';

/** Manual metadata edits accepted from the UI. */
export interface MetadataUpdateDto {
  title?: string;
  originalTitle?: string;
  sortTitle?: string;
  overview?: string;
  year?: number | null;
  runtime?: number | null;
  genres?: string[];
  studios?: string[];
  cast?: Array<{ name: string; role?: string }>;
  crew?: Array<{ name: string; job?: string }>;
  directors?: string[];
  writers?: string[];
  rating?: number | null;
  certification?: string | null;
  tags?: string[];
}

export interface AuditContext {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Parse a Kodi-style .nfo XML for the handful of fields we can safely extract
 * without a full XML parser. Best-effort and pure — used to overlay local
 * metadata when no online provider is configured.
 */
export function parseNfoXml(xml: string): Partial<MediaMetadataDetails> {
  const pick = (tag: string): string | undefined => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
    return m ? m[1].trim() : undefined;
  };
  const pickAll = (tag: string): string[] => {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi');
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) out.push(m[1].trim());
    return out;
  };
  const details: Partial<MediaMetadataDetails> = { providerName: 'local-nfo' };
  const title = pick('title');
  if (title) details.title = title;
  const plot = pick('plot') ?? pick('outline');
  if (plot) details.overview = plot;
  const year = pick('year');
  if (year && /^\d{4}$/.test(year)) details.year = Number(year);
  const runtime = pick('runtime');
  if (runtime && /^\d+$/.test(runtime)) details.runtime = Number(runtime);
  const rating = pick('rating');
  if (rating && !Number.isNaN(Number(rating))) details.rating = Number(rating);
  const genres = pickAll('genre');
  if (genres.length) details.genres = genres;
  const studios = pickAll('studio');
  if (studios.length) details.studios = studios;
  const cert = pick('mpaa') ?? pick('certification');
  if (cert) details.certification = cert;
  return details;
}

/**
 * Fetches and persists rich metadata for a MediaItem via the pluggable metadata
 * provider (local NFO overlay + TMDB when an API key is configured). Never logs
 * or leaks the provider key; degrades cleanly to local/offline behaviour.
 */
@Injectable()
export class MediaMetadataService {
  private readonly logger = new Logger(MediaMetadataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly filePath: FilePathService,
    private readonly audit: AuditService,
    private readonly imdb: ImdbService,
  ) {}

  /** Resolve the active provider (TMDB when keyed, else offline local). */
  private async provider(): Promise<MediaMetadataProvider> {
    const key =
      (await this.settings.get<string>('media.tmdbApiKey')) ??
      process.env.TMDB_API_KEY;
    return key ? new TmdbMetadataProvider(key) : new LocalMetadataProvider();
  }

  private lookupFor(item: {
    mediaType: string;
    title: string;
    year: number | null;
    season: number | null;
    episode: number | null;
  }): MediaLookup {
    const kind: MediaLookup['kind'] =
      item.mediaType === 'movie'
        ? 'movie'
        : item.mediaType === 'anime'
          ? 'anime'
          : item.mediaType === 'tv'
            ? 'tv'
            : 'general';
    return {
      kind,
      title: item.title,
      year: item.year,
      season: item.season,
      episode: item.episode,
    };
  }

  /** Read a sidecar .nfo next to the item's primary file, if present + safe. */
  private async readLocalNfo(
    filePaths: string[],
  ): Promise<Partial<MediaMetadataDetails> | null> {
    for (const p of filePaths) {
      const nfoPath = p.replace(/\.[^.]+$/, '') + '.nfo';
      try {
        const abs = this.filePath.assertWithinHardRoots(nfoPath);
        const xml = await readFile(abs, 'utf8');
        return parseNfoXml(xml);
      } catch {
        // No sidecar / outside roots — skip.
      }
    }
    return null;
  }

  /** Fetch metadata for an item and upsert MediaMetadata + external ids. */
  async fetchMetadata(itemId: string, ctx: AuditContext = {}) {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: itemId },
      include: { files: true },
    });
    if (!item) throw new NotFoundException('Item not found');

    const provider = await this.provider();
    const query = this.lookupFor(item);

    let remote: MediaMetadataDetails | null = null;
    try {
      remote = await provider.fetchDetails(query);
    } catch (err) {
      // Audit the failure WITHOUT leaking any key or config.
      await this.audit.record({
        userId: ctx.userId,
        action: 'media.metadata.fetch_failed',
        objectType: 'media_item',
        objectId: itemId,
        result: 'failure',
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        metadata: { provider: provider.name, error: (err as Error).message },
      });
      this.logger.warn(
        `Metadata fetch failed for item ${itemId} via ${provider.name}: ${(err as Error).message}`,
      );
    }

    const local = await this.readLocalNfo(item.files.map((f) => f.path));

    // Merge: remote provider wins, local NFO fills gaps, parsed title as base.
    const merged: MediaMetadataDetails = {
      title: item.title,
      year: item.year ?? undefined,
      ...(local ?? {}),
      ...(remote ?? {}),
      externalIds: { ...(local as any)?.externalIds, ...remote?.externalIds },
    };

    const data: Prisma.MediaMetadataUncheckedCreateInput = {
      itemId,
      title: merged.title ?? item.title,
      originalTitle: merged.originalTitle ?? null,
      overview: merged.overview ?? null,
      releaseDate: merged.releaseDate ? new Date(merged.releaseDate) : null,
      year: merged.year ?? item.year ?? null,
      runtime: merged.runtime ?? null,
      genres: (merged.genres ?? []) as Prisma.InputJsonValue,
      studios: (merged.studios ?? []) as Prisma.InputJsonValue,
      cast: (merged.cast ?? []) as Prisma.InputJsonValue,
      crew: (merged.crew ?? []) as Prisma.InputJsonValue,
      directors: (merged.directors ?? []) as Prisma.InputJsonValue,
      writers: (merged.writers ?? []) as Prisma.InputJsonValue,
      rating: merged.rating ?? null,
      certification: merged.certification ?? null,
      tags: (merged.tags ?? []) as Prisma.InputJsonValue,
      providerName: merged.providerName ?? provider.name,
    };

    const metadata = await this.prisma.mediaMetadata.upsert({
      where: { itemId },
      create: data,
      update: data,
    });

    // Persist external ids returned by the provider.
    const externalIds = merged.externalIds ?? {};
    for (const [prov, extId] of Object.entries(externalIds)) {
      if (!extId) continue;
      await this.prisma.mediaExternalId.upsert({
        where: { itemId_provider: { itemId, provider: prov } },
        create: {
          itemId,
          provider: prov,
          externalId: String(extId),
          url: this.externalUrl(prov, String(extId), item.mediaType),
        },
        update: { externalId: String(extId) },
      });
    }

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.metadata.fetch',
      objectType: 'media_item',
      objectId: itemId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { provider: provider.name, matched: remote !== null },
    });

    // Cross-provider enrichment: when an IMDb id is known, let TMDB/OMDb resolve
    // by IMDb id and apply the IMDb rating (only) as a rating source. Best-effort.
    const imdbId = externalIds.imdb;
    if (imdbId) {
      try {
        await this.imdb.enrichCrossProvider(itemId, String(imdbId), ctx);
      } catch (err) {
        this.logger.warn(
          `IMDb cross-provider enrichment failed for ${itemId}: ${(err as Error).message}`,
        );
      }
    }

    return metadata;
  }

  private externalUrl(
    provider: string,
    id: string,
    mediaType: string,
  ): string | null {
    switch (provider) {
      case 'imdb':
        return `https://www.imdb.com/title/${id}/`;
      case 'tmdb':
        return mediaType === 'movie'
          ? `https://www.themoviedb.org/movie/${id}`
          : `https://www.themoviedb.org/tv/${id}`;
      case 'tvdb':
        return `https://thetvdb.com/?id=${id}`;
      default:
        return null;
    }
  }

  /** Manual operator edit of an item's metadata. */
  async updateMetadata(itemId: string, dto: MetadataUpdateDto, ctx: AuditContext = {}) {
    const item = await this.prisma.mediaItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Item not found');

    const set = <T>(v: T | undefined) => (v === undefined ? undefined : v);
    const jsonSet = (v: unknown[] | undefined) =>
      v === undefined ? undefined : (v as Prisma.InputJsonValue);

    const update: Prisma.MediaMetadataUncheckedUpdateInput = {
      title: set(dto.title),
      originalTitle: set(dto.originalTitle),
      sortTitle: set(dto.sortTitle),
      overview: set(dto.overview),
      year: dto.year === undefined ? undefined : dto.year,
      runtime: dto.runtime === undefined ? undefined : dto.runtime,
      genres: jsonSet(dto.genres),
      studios: jsonSet(dto.studios),
      cast: jsonSet(dto.cast),
      crew: jsonSet(dto.crew),
      directors: jsonSet(dto.directors),
      writers: jsonSet(dto.writers),
      rating: dto.rating === undefined ? undefined : dto.rating,
      certification: dto.certification === undefined ? undefined : dto.certification,
      tags: jsonSet(dto.tags),
      providerName: 'manual',
    };

    const metadata = await this.prisma.mediaMetadata.upsert({
      where: { itemId },
      create: {
        itemId,
        title: dto.title ?? item.title,
        originalTitle: dto.originalTitle ?? null,
        sortTitle: dto.sortTitle ?? null,
        overview: dto.overview ?? null,
        year: dto.year ?? item.year ?? null,
        runtime: dto.runtime ?? null,
        genres: (dto.genres ?? []) as Prisma.InputJsonValue,
        studios: (dto.studios ?? []) as Prisma.InputJsonValue,
        cast: (dto.cast ?? []) as Prisma.InputJsonValue,
        crew: (dto.crew ?? []) as Prisma.InputJsonValue,
        directors: (dto.directors ?? []) as Prisma.InputJsonValue,
        writers: (dto.writers ?? []) as Prisma.InputJsonValue,
        rating: dto.rating ?? null,
        certification: dto.certification ?? null,
        tags: (dto.tags ?? []) as Prisma.InputJsonValue,
        providerName: 'manual',
      },
      update: update,
    });

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.metadata.update',
      objectType: 'media_item',
      objectId: itemId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    return metadata;
  }
}
