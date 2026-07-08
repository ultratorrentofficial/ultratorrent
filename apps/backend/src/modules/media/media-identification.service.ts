import { Injectable, NotFoundException } from '@nestjs/common';
import * as path from 'node:path';
import type { MediaItem, Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  parseTorrentName,
  ParsedTorrentMeta,
} from '../rss/torrent-name-parser';

export interface ManualMatchDto {
  mediaType?: string;
  title?: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
}

/** Narrowing filter for a bulk re-identification pass. */
export interface BulkIdentifyFilter {
  /** Restrict to one library (omit to span every library). */
  libraryId?: string;
  /**
   * Restrict to items in this match state — e.g. `'unmatched'` to only retry the
   * ones that failed. Omit to re-identify everything *except* `manual` items,
   * which are operator-authoritative and never auto-overwritten.
   */
  matchStatus?: string;
}

export interface BulkIdentifySummary {
  total: number;
  matched: number;
  unmatched: number;
  failed: number;
}

/** Progress callback: `(percent 0..100, message?)`. */
export type BulkIdentifyReporter = (progress: number, message?: string) => Promise<void>;

/** Threshold above which a parsed filename is considered a confident match. */
const MATCH_THRESHOLD = 0.5;

/**
 * Identifies scanned MediaItems by parsing their filename with the shared
 * torrent-name parser and mapping the result onto the item's fields.
 */
@Injectable()
export class MediaIdentificationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Parse the item's filename and persist the derived identity. `libraryKind` is
   * the item's library kind; pass it to skip a per-item lookup (bulk runs do),
   * otherwise it is resolved from the record's library.
   */
  async identify(item: MediaItem | string, libraryKind?: string) {
    const record =
      typeof item === 'string'
        ? await this.prisma.mediaItem.findUnique({ where: { id: item } })
        : item;
    if (!record) throw new NotFoundException('Item not found');

    const parsed = this.parseFromPath(record.path);
    const confidence = this.scoreConfidence(parsed);
    const kind = libraryKind ?? (await this.libraryKind(record.libraryId));
    const mediaType = this.mediaTypeFromParsed(parsed, record.mediaType, kind);
    const isEpisodic = mediaType === 'tv' || mediaType === 'anime';

    return this.prisma.mediaItem.update({
      where: { id: record.id },
      data: {
        mediaType,
        title: parsed.title ?? record.title,
        year: parsed.year ?? null,
        season: parsed.season ?? null,
        episode: parsed.episode ?? parsed.absoluteEpisode ?? null,
        confidence,
        matchStatus: confidence >= MATCH_THRESHOLD ? 'matched' : 'unmatched',
        seriesImdbId: isEpisodic ? await this.resolveSeriesImdbId(record.id) : null,
      },
    });
  }

  /**
   * Re-run automatic identification across many items in one pass — the bulk
   * counterpart to {@link identify}, used to recover a library that scanned as
   * `unmatched` under the old scoring. Each item is identified independently so
   * one bad path never aborts the run; failures are counted, not thrown. By
   * default `manual` items are excluded (operator matches are authoritative);
   * pass an explicit `matchStatus` to target a specific state (e.g. retry only
   * `unmatched`).
   */
  async identifyBulk(
    filter: BulkIdentifyFilter = {},
    report?: BulkIdentifyReporter,
  ): Promise<BulkIdentifySummary> {
    const where: Prisma.MediaItemWhereInput = {};
    if (filter.libraryId) where.libraryId = filter.libraryId;
    if (filter.matchStatus) where.matchStatus = filter.matchStatus;
    else where.matchStatus = { not: 'manual' };

    const items = await this.prisma.mediaItem.findMany({ where });
    const summary: BulkIdentifySummary = {
      total: items.length,
      matched: 0,
      unmatched: 0,
      failed: 0,
    };

    // Prefetch each library's declared kind once so classification doesn't do a
    // lookup per item (see {@link mediaTypeFromParsed}).
    const libraries = await this.prisma.mediaLibrary.findMany({
      select: { id: true, kind: true },
    });
    const kindByLibrary = new Map(libraries.map((l) => [l.id, l.kind]));

    for (let i = 0; i < items.length; i++) {
      try {
        const updated = await this.identify(items[i], kindByLibrary.get(items[i].libraryId));
        if (updated.matchStatus === 'matched') summary.matched++;
        else summary.unmatched++;
      } catch {
        summary.failed++;
      }
      // Throttle progress writes — every 25 items and on the final item.
      if (report && (i % 25 === 0 || i === items.length - 1)) {
        await report(
          ((i + 1) / items.length) * 100,
          `Identified ${i + 1}/${items.length}`,
        );
      }
    }

    return summary;
  }

  /**
   * Best-effort parent-series tconst for a TV/anime episode item, used by the
   * missing-episodes diff. Resolves the item's own IMDb external id: an episode
   * tconst maps to its series via `IMDbEpisode.parentTitleId`; a series tconst is
   * kept as-is. Returns null (never throws) when nothing is resolvable — the scan
   * falls back to title matching.
   */
  private async resolveSeriesImdbId(itemId: string): Promise<string | null> {
    try {
      const ext = await this.prisma.mediaExternalId.findUnique({
        where: { itemId_provider: { itemId, provider: 'imdb' } },
      });
      const tconst = ext?.externalId;
      if (!tconst) return null;
      const ep = await this.prisma.iMDbEpisode.findUnique({
        where: { episodeTitleId: tconst },
      });
      if (ep) return ep.parentTitleId;
      const title = await this.prisma.iMDbTitle.findUnique({ where: { tconst } });
      if (title && (title.titleType === 'tvSeries' || title.titleType === 'tvMiniSeries')) {
        return tconst;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Operator override — authoritative identity, always full confidence. */
  async matchManually(itemId: string, dto: ManualMatchDto) {
    const record = await this.prisma.mediaItem.findUnique({ where: { id: itemId } });
    if (!record) throw new NotFoundException('Item not found');

    const mediaType = dto.mediaType ?? record.mediaType;
    const isEpisodic = mediaType === 'tv' || mediaType === 'anime';

    return this.prisma.mediaItem.update({
      where: { id: itemId },
      data: {
        mediaType,
        title: dto.title ?? record.title,
        year: dto.year ?? record.year,
        season: dto.season ?? record.season,
        episode: dto.episode ?? record.episode,
        matchStatus: 'manual',
        confidence: 1,
        seriesImdbId: isEpisodic ? await this.resolveSeriesImdbId(itemId) : null,
      },
    });
  }

  /** Clear identification back to an unmatched state. */
  async unmatch(itemId: string) {
    const record = await this.prisma.mediaItem.findUnique({ where: { id: itemId } });
    if (!record) throw new NotFoundException('Item not found');

    return this.prisma.mediaItem.update({
      where: { id: itemId },
      data: { matchStatus: 'unmatched', confidence: 0 },
    });
  }

  /**
   * Parse a media file's identity from its name *and* folder context.
   *
   * Well-organised libraries carry the series/movie title in the folder — e.g.
   * `Breaking Bad/Season 01/S01E01.mkv` — leaving the filename with no title of
   * its own. Parsing the basename alone loses that title, so we recover it by
   * climbing to the first meaningful parent folder (skipping generic "Season N"
   * / "Specials" containers) and re-parsing `<folder> <filename>`. The season
   * and episode still come from the filename; the folder only supplies the
   * title the file omits. When the filename already names a title we keep it.
   */
  private parseFromPath(filePath: string): ParsedTorrentMeta {
    const base = path.basename(filePath);
    const parsed = parseTorrentName(base);
    if (parsed.title) return parsed;

    const segments = filePath.split(/[/\\]+/).filter(Boolean);
    segments.pop(); // drop the filename itself
    for (let i = segments.length - 1; i >= 0; i--) {
      if (this.isGenericContainer(segments[i])) continue;
      const combined = parseTorrentName(`${segments[i]} ${base}`);
      // Use the folder-enriched parse only if it actually recovered a title;
      // otherwise fall back to the filename-only result.
      return combined.title ? combined : parsed;
    }
    return parsed;
  }

  /**
   * True for folders that group episodes but never name the title themselves,
   * so the title climb skips past them (e.g. "Season 01", "Specials", "Disc 2").
   */
  private isGenericContainer(name: string): boolean {
    const n = name.trim();
    return (
      /^(season|series|saison|staffel|temporada|disc|disk|cd|part|vol|volume)[\s._-]*\d+$/i.test(n) ||
      /^specials?$/i.test(n)
    );
  }

  /**
   * Decide an item's mediaType. The library declares what it holds, so its
   * `kind` is authoritative for the movie/tv/anime axis: a name like
   * `9-1-1 (2018)` carries a year but no episode marker and would otherwise be
   * inferred as a *movie*, misclassifying a whole TV show. The filename parse
   * still supplies episode *structure* (season/episode/absolute) downstream; it
   * just no longer decides the category when the library already declares it.
   * Only mixed/general libraries (no clear video kind) fall back to inference.
   */
  private mediaTypeFromParsed(
    parsed: ParsedTorrentMeta,
    fallback: string,
    libraryKind?: string,
  ): string {
    switch (libraryKind) {
      case 'movie':
        return 'movie';
      case 'tv':
        return 'tv';
      case 'anime':
        return 'anime';
    }
    switch (parsed.contentType) {
      case 'tv_episode':
      case 'daily':
        return 'tv';
      case 'anime_episode':
        return 'anime';
      case 'movie':
        return 'movie';
      default:
        return fallback;
    }
  }

  /**
   * The declared kind of the item's library (`tv | anime | movie | ...`), used to
   * anchor classification. Fetched fresh (not cached) so a library whose kind was
   * just changed re-classifies correctly on the next identify; bulk runs pass a
   * prefetched value instead to avoid a lookup per item.
   */
  private async libraryKind(libraryId: string): Promise<string | undefined> {
    const lib = await this.prisma.mediaLibrary.findUnique({
      where: { id: libraryId },
      select: { kind: true },
    });
    return lib?.kind;
  }

  /**
   * Confidence 0..1, weighted by what actually *identifies* a title rather than
   * by how many scene tokens the filename happens to carry.
   *
   * The old formula scored the share of 8 equally-weighted fields — four of them
   * scene artifacts (resolution/source/codec/group). A cleanly-named episode in
   * a personal library (`The Office - S01E01.mkv`) resolves only title + season +
   * episode = 3/8 = 0.375 and fell below the 0.5 threshold, so entire TV
   * libraries scanned as "unmatched". Here the identity signals carry the weight:
   * a title plus an episodic marker (S/E, absolute episode, or air date) or a
   * movie year is enough on its own to clear the threshold; the quality tokens
   * only refine an already-identified item and can never gate identification.
   */
  private scoreConfidence(parsed: ParsedTorrentMeta): number {
    const hasEpisodeId =
      (parsed.season !== null && parsed.episode !== null) ||
      parsed.absoluteEpisode !== null ||
      parsed.airDate !== null;
    const hasPrimaryId = hasEpisodeId || parsed.year !== null;

    let score = 0;
    if (parsed.title) score += 0.4;
    if (hasPrimaryId) score += 0.4;
    if (parsed.resolution) score += 0.05;
    if (parsed.source) score += 0.05;
    if (parsed.codec) score += 0.05;
    if (parsed.releaseGroup) score += 0.05;

    return Math.round(Math.min(1, score) * 100) / 100;
  }
}
