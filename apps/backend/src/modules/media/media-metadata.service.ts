import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../settings/settings.module';
import { FilePathService } from '../files/file-path.service';
import { AuditService } from '../audit/audit.service';
import { ImdbService } from './imdb/imdb.service';
import { showFolderOf } from './media-scanner.service';
import { TV_TYPES } from './series-grouping';
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
  const originalTitle = pick('originaltitle');
  if (originalTitle) details.originalTitle = originalTitle;
  const directors = pickAll('director');
  if (directors.length) details.directors = directors;
  const writers = pickAll('credits');
  if (writers.length) details.writers = writers;

  // <actor><name>..</name><role>..</role></actor> blocks → cast.
  const cast: Array<{ name: string; role?: string }> = [];
  const actorRe = /<actor>([\s\S]*?)<\/actor>/gi;
  let am: RegExpExecArray | null;
  while ((am = actorRe.exec(xml))) {
    const name = /<name>([\s\S]*?)<\/name>/i.exec(am[1])?.[1]?.trim();
    const role = /<role>([\s\S]*?)<\/role>/i.exec(am[1])?.[1]?.trim();
    if (name) cast.push(role ? { name, role } : { name });
  }
  if (cast.length) details.cast = cast;

  // External ids: dedicated <imdbid>/<tmdbid>/<tvdbid> or Kodi <uniqueid type=…>.
  const uniqueId = (kind: string): string | undefined => {
    const m = new RegExp(
      `<uniqueid[^>]*type=["']${kind}["'][^>]*>([^<]+)</uniqueid>`,
      'i',
    ).exec(xml);
    return m ? m[1].trim() : undefined;
  };
  const externalIds: Record<string, string> = {};
  const imdb = pick('imdbid') ?? uniqueId('imdb');
  if (imdb) externalIds.imdb = imdb;
  const tmdb = pick('tmdbid') ?? uniqueId('tmdb');
  if (tmdb) externalIds.tmdb = tmdb;
  const tvdb = pick('tvdbid') ?? uniqueId('tvdb');
  if (tvdb) externalIds.tvdb = tvdb;
  if (Object.keys(externalIds).length) details.externalIds = externalIds;

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

  /**
   * Is this `imdb` episode id shared with a DIFFERENT show — i.e. provably wrong?
   *
   * A `.nfo` is written by whatever media manager last touched the library, and it can
   * be confidently, systematically wrong. On a real library, eighteen unrelated Apple
   * TV+ shows — Ted Lasso, Servant, Dickinson, Hawkeye, See … — each carried
   * `<uniqueid type="imdb">tt13701758</uniqueid>` in their S01E01 sidecar. That tconst
   * is *Acapulco* S01E01: the generator had matched episodes by title, so every show's
   * "Pilot" collided. Imported verbatim, one show's episode ids landed on eighteen
   * shows, and everything keyed on IMDb identity inherited the lie.
   *
   * An episode tconst identifies exactly one episode of exactly one series. So if the
   * same id is filed under two different show FOLDERS, it is provably wrong for at
   * least one of them — and we cannot tell which, so neither may keep it.
   *
   * We deliberately do NOT compare the catalogue's series title against the folder
   * name. That looks appealing and is wrong: a library legitimately files "Andor" as
   * `Star Wars Andor`, and AMC renamed "Interview with the Vampire" to "The Vampire
   * Lestat" mid-run. A title check flagged 36 perfectly good ids across those two
   * shows. The collision is the only signal that cannot produce a false positive.
   */
  private async isForeignEpisodeId(
    item: { id: string; path: string; mediaType: string; libraryId: string },
    provider: string,
    externalId: string,
  ): Promise<boolean> {
    if (provider !== 'imdb') return false;
    if (!TV_TYPES.includes(item.mediaType)) return false;

    const library = await this.prisma.mediaLibrary.findUnique({
      where: { id: item.libraryId },
      select: { path: true },
    });
    const folder = library ? showFolderOf(library.path, item.path) : null;
    if (!folder) return false;

    const others = await this.prisma.mediaExternalId.findMany({
      where: {
        provider: 'imdb',
        externalId,
        NOT: { itemId: item.id },
        item: { mediaType: { in: TV_TYPES }, libraryId: item.libraryId },
      },
      select: { id: true, item: { select: { path: true } } },
    });
    const foreign = others.filter(
      (o) => showFolderOf(library!.path, o.item.path) !== folder,
    );
    if (foreign.length === 0) return false;

    // Untrustworthy for everyone: drop the rows that already carry it, and refuse to
    // add ours. Two shows cannot share one episode.
    await this.prisma.mediaExternalId.deleteMany({
      where: { id: { in: foreign.map((f) => f.id) } },
    });
    this.logger.warn(
      `IMDb id ${externalId} is claimed by ${foreign.length + 1} different show folders ` +
        `(incl. “${path.basename(folder)}”) — an episode belongs to exactly one series, so the ` +
        `sidecars are wrong. Dropping it from all of them.`,
    );
    return true;
  }

  /**
   * Import metadata from a Kodi/Jellyfin `.nfo` already on disk — the item's
   * `<basename>.nfo`, or a directory-level `movie.nfo` / `tvshow.nfo`. Purely
   * local (no network). Only fills gaps: an existing non-null value (e.g. from a
   * provider fetch) is never clobbered, so it's safe to re-run on every scan.
   * Records any external ids (bar one the catalogue contradicts — see
   * {@link isForeignEpisodeId}) and logs the sidecar as a MediaNfoFile. Returns
   * true when an NFO was found and imported.
   */
  async importLocalNfo(itemId: string, ctx: AuditContext = {}): Promise<boolean> {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: itemId },
      include: { files: true, metadata: true },
    });
    if (!item) return false;

    // Candidates: per-file <basename>.nfo, then directory-level movie/tvshow.nfo.
    const candidates: string[] = [];
    const dirs = new Set<string>();
    for (const f of item.files) {
      candidates.push(f.path.replace(/\.[^.]+$/, '') + '.nfo');
      dirs.add(path.dirname(f.path));
    }
    for (const dir of dirs) {
      candidates.push(path.join(dir, 'movie.nfo'));
      candidates.push(path.join(dir, 'tvshow.nfo'));
    }

    let parsed: Partial<MediaMetadataDetails> | null = null;
    let nfoPath: string | null = null;
    for (const c of candidates) {
      try {
        const abs = this.filePath.assertWithinHardRoots(c);
        const xml = await readFile(abs, 'utf8');
        parsed = parseNfoXml(xml);
        nfoPath = abs;
        break;
      } catch {
        // Missing / outside roots — try the next candidate.
      }
    }
    if (!parsed || !nfoPath) return false;

    const cur = item.metadata;
    const arr = (existing: unknown, next: unknown[] | undefined): Prisma.InputJsonValue =>
      (Array.isArray(existing) && existing.length ? existing : (next ?? [])) as Prisma.InputJsonValue;
    const data: Prisma.MediaMetadataUncheckedCreateInput = {
      itemId,
      title: cur?.title ?? parsed.title ?? item.title,
      originalTitle: cur?.originalTitle ?? parsed.originalTitle ?? null,
      overview: cur?.overview ?? parsed.overview ?? null,
      year: cur?.year ?? parsed.year ?? item.year ?? null,
      runtime: cur?.runtime ?? parsed.runtime ?? null,
      genres: arr(cur?.genres, parsed.genres),
      studios: arr(cur?.studios, parsed.studios),
      cast: arr(cur?.cast, parsed.cast),
      directors: arr(cur?.directors, parsed.directors),
      writers: arr(cur?.writers, parsed.writers),
      rating: cur?.rating ?? parsed.rating ?? null,
      certification: cur?.certification ?? parsed.certification ?? null,
      providerName: cur?.providerName ?? 'local-nfo',
    };
    await this.prisma.mediaMetadata.upsert({ where: { itemId }, create: data, update: data });

    // External ids — create when absent; never clobber an existing mapping.
    for (const [prov, extId] of Object.entries(parsed.externalIds ?? {})) {
      if (!extId) continue;
      if (await this.isForeignEpisodeId(item, prov, String(extId))) continue;
      await this.prisma.mediaExternalId.upsert({
        where: { itemId_provider: { itemId, provider: prov } },
        create: {
          itemId,
          provider: prov,
          externalId: String(extId),
          url: this.externalUrl(prov, String(extId), item.mediaType),
        },
        update: {},
      });
    }

    // Record the imported sidecar (once per path).
    const already = await this.prisma.mediaNfoFile.findFirst({ where: { itemId, path: nfoPath } });
    if (!already) {
      const type = nfoPath.endsWith('tvshow.nfo')
        ? 'tvshow'
        : nfoPath.endsWith('movie.nfo')
          ? 'movie'
          : item.mediaType === 'tv' || item.mediaType === 'anime'
            ? 'episode'
            : 'movie';
      await this.prisma.mediaNfoFile.create({ data: { itemId, type, path: nfoPath } });
    }

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.metadata.nfo_import',
      objectType: 'media_item',
      objectId: itemId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { nfoPath },
    });
    return true;
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
