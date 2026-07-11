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

// ---------------------------------------------------------------------------
// Pure path→identity parsing. Exported (and used by the library scanner) so a
// newly-scanned item gets a real series title + season/episode immediately,
// instead of storing the raw filename as the title and waiting for a later
// identification pass that may never run.
// ---------------------------------------------------------------------------

/**
 * True for folders that group episodes but never name the title themselves, so
 * the title climb skips past them (e.g. "Season 01", "Specials", "Disc 2").
 */
export function isGenericContainer(name: string): boolean {
  const n = name.trim();
  return (
    /^(season|series|saison|staffel|temporada|disc|disk|cd|part|vol|volume)[\s._-]*\d+$/i.test(n) ||
    /^specials?$/i.test(n)
  );
}

/**
 * The name of the show folder for a file — the first parent that isn't a generic
 * `Season NN`/`Specials`/`Disc N` container, climbing upward but never past the
 * library root (so a file sitting directly under the library never adopts the
 * library folder's name as its title). Null when none qualifies.
 */
export function showFolderName(filePath: string, libraryPath?: string): string | null {
  const segments = filePath.split(/[/\\]+/).filter(Boolean);
  segments.pop(); // drop the filename itself
  const rootDepth = libraryPath ? libraryPath.split(/[/\\]+/).filter(Boolean).length : 0;
  for (let i = segments.length - 1; i >= rootDepth; i--) {
    if (isGenericContainer(segments[i])) continue;
    return segments[i];
  }
  return null;
}

/**
 * Parse a media file's identity from its name *and* folder context.
 *
 * In a `Show/Season NN/episode` layout the **series title lives in the show
 * folder**, and the filename often carries only the *episode* title — e.g.
 * `9-1-1 (2018)/Season 9/Contraband Seized at the Border - S09E04.mkv`, whose
 * basename parses to the title "Contraband Seized at the Border" and would
 * fragment the show into one series per episode. So for an **episodic** file that
 * sits inside a `Season NN`/`Specials` container (the strong signal of an
 * organised library), or whose filename yields no title at all, we take the series
 * title (and year) from the first meaningful parent folder (climbing past the
 * generic containers, bounded by the library root). Season/episode/quality still
 * come from the filename.
 *
 * When the file is *not* in such a container and the filename already names a
 * title (a loose scene release like `Show.Name.S02E05...`), that filename title is
 * authoritative — the folder is likely a junk/download dir, not the show.
 */
export function parseItemIdentity(filePath: string, libraryPath?: string): ParsedTorrentMeta {
  const base = path.basename(filePath);
  const parsed = parseTorrentName(base);

  const episodic =
    (parsed.season !== null && parsed.episode !== null) ||
    parsed.absoluteEpisode !== null ||
    parsed.airDate !== null;
  const parentIsContainer = isGenericContainer(path.basename(path.dirname(filePath)));

  if (episodic && (parentIsContainer || !parsed.title)) {
    const folder = showFolderName(filePath, libraryPath);
    const folderParsed = folder ? parseTorrentName(folder) : null;
    if (folderParsed?.title) {
      // Series identity from the folder; episode structure from the filename.
      return { ...parsed, title: folderParsed.title, year: folderParsed.year ?? parsed.year };
    }
  }

  if (parsed.title) return parsed;

  // Filename yielded no title and the folder above didn't parse to a series —
  // last resort: re-parse `<folder> <filename>` to recover something.
  const folder = showFolderName(filePath, libraryPath);
  if (folder) {
    const combined = parseTorrentName(`${folder} ${base}`);
    if (combined.title) return combined;
  }
  return parsed;
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
   * Parse the item's filename and persist the derived identity. `libraryKind`
   * and `libraryPath` describe the owning library; pass them to skip a per-item
   * lookup (bulk runs do), otherwise they are resolved from the record's library.
   * `libraryKind` anchors classification (see {@link mediaTypeFromParsed});
   * `libraryPath` bounds the show-folder climb (see {@link parseFromPath}).
   */
  async identify(
    item: MediaItem | string,
    libraryKind?: string,
    libraryPath?: string,
  ) {
    const record =
      typeof item === 'string'
        ? await this.prisma.mediaItem.findUnique({ where: { id: item } })
        : item;
    if (!record) throw new NotFoundException('Item not found');

    const lib =
      libraryKind !== undefined || libraryPath !== undefined
        ? { kind: libraryKind, path: libraryPath }
        : await this.libraryInfo(record.libraryId);
    const parsed = this.parseFromPath(record.path, lib?.path ?? undefined);
    const confidence = this.scoreConfidence(parsed);
    const mediaType = this.mediaTypeFromParsed(parsed, record.mediaType, lib?.kind ?? undefined);
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

    // Prefetch each library's kind + path once so per-item identify doesn't do a
    // lookup (see {@link mediaTypeFromParsed} and {@link parseFromPath}).
    const libraries = await this.prisma.mediaLibrary.findMany({
      select: { id: true, kind: true, path: true },
    });
    const libraryById = new Map(libraries.map((l) => [l.id, l]));

    for (let i = 0; i < items.length; i++) {
      try {
        const lib = libraryById.get(items[i].libraryId);
        const updated = await this.identify(items[i], lib?.kind, lib?.path);
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
   * In a `Show/Season NN/episode` layout the **series title lives in the show
   * folder**, and the filename often carries only the *episode* title — e.g.
   * `9-1-1 (2018)/Season 9/Contraband Seized at the Border - S09E04.mkv`, whose
   * basename parses to the title "Contraband Seized at the Border" and would
   * fragment the show into one series per episode. So for an **episodic** file
   * that sits inside a `Season NN`/`Specials` container (the strong signal of an
   * organised library), or whose filename yields no title at all, we take the
   * series title (and year) from the first meaningful parent folder (climbing
   * past the generic containers, bounded by the library root so we never grab the
   * library folder itself). Season/episode/quality still come from the filename.
   *
   * When the file is *not* in such a container and the filename already names a
   * title (a loose scene release like `Show.Name.S02E05...`), that filename title
   * is authoritative — the folder is likely a junk/download dir, not the show.
   */
  private parseFromPath(filePath: string, libraryPath?: string): ParsedTorrentMeta {
    return parseItemIdentity(filePath, libraryPath);
  }

  /**
   * The name of the show folder for a file — the first parent that isn't a
   * generic `Season NN`/`Specials`/`Disc N` container, climbing upward but never
   * past the library root (so a file sitting directly under the library never
   * adopts the library folder's name as its title). Null when none qualifies.
   */
  private showFolderName(filePath: string, libraryPath?: string): string | null {
    return showFolderName(filePath, libraryPath);
  }

  private isGenericContainer(name: string): boolean {
    return isGenericContainer(name);
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
   * The item's library `kind` (anchors classification) and `path` (bounds the
   * show-folder climb). Fetched fresh (not cached) so a library edited between
   * scans re-identifies correctly; bulk runs pass prefetched values instead to
   * avoid a lookup per item.
   */
  private async libraryInfo(
    libraryId: string,
  ): Promise<{ kind: string; path: string } | undefined> {
    const lib = await this.prisma.mediaLibrary.findUnique({
      where: { id: libraryId },
      select: { kind: true, path: true },
    });
    return lib ?? undefined;
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
