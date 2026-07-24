import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
 * True for a folder that names ONE release of a season rather than the show — an
 * unrenamed scene/download directory like
 * `From.S04.1080p.WEBRip.10Bit.DDP5.1.x265-NeoNoir`. The tell is scene/quality
 * tokens (resolution, source, codec, release group) or a bare season marker: a real
 * show-root folder ("From (2022)", "Loki (2021)", "9-1-1 (2018)", a "Marvel"
 * collection) carries none of these — it is named for the show across all seasons,
 * never for a single release.
 */
export function isReleaseFolder(name: string): boolean {
  const p = parseTorrentName(name);
  return (
    p.resolution !== null ||
    p.source !== null ||
    p.codec !== null ||
    p.releaseGroup !== null ||
    p.season !== null
  );
}

/**
 * The name of the show folder for a file — the parent that names the SERIES,
 * climbing upward but never past the library root (so a file sitting directly under
 * the library never adopts the library folder's name as its title). Null when none
 * qualifies.
 *
 * Two kinds of parent are climbed past, not just one:
 *  - generic `Season NN`/`Specials`/`Disc N` containers, which never name a title; and
 *  - a **release folder** — an unrenamed download dir like `From.S04.1080p…-NeoNoir`
 *    that a torrent dropped BETWEEN the show root and the season folder. It parses to
 *    a junk title ("From S04", the `.S04.` glued on because no episode number splits
 *    it off), so stopping there mis-titles every episode under it. Observed live:
 *    `From (2022)/From.S04.1080p.WEBRip.…-NeoNoir/Season 04/…S04E08.mkv` stored as
 *    "From S04" while its already-renamed sibling stored the correct "From".
 *
 * The first meaningful parent is still kept as a `fallback`: when the release folder
 * IS the top of the tree (a flat scene release with no show-root wrapper), there is
 * nothing better above it, so it is returned rather than climbing into nothing.
 */
export function showFolderName(filePath: string, libraryPath?: string): string | null {
  const segments = filePath.split(/[/\\]+/).filter(Boolean);
  segments.pop(); // drop the filename itself
  const rootDepth = libraryPath ? libraryPath.split(/[/\\]+/).filter(Boolean).length : 0;
  let fallback: string | null = null;
  for (let i = segments.length - 1; i >= rootDepth; i--) {
    const seg = segments[i];
    if (isGenericContainer(seg)) continue;
    // First non-generic parent: the answer unless a real show root sits above it.
    if (fallback === null) fallback = seg;
    // A release/download folder is not the show root — go back once more (and again),
    // up to the true series folder. Bounded by the library root by the loop itself.
    if (isReleaseFolder(seg)) continue;
    return seg;
  }
  return fallback;
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
  private readonly logger = new Logger(MediaIdentificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Parse the item's filename and persist the derived identity. `libraryKind`
   * and `libraryPath` describe the owning library; pass them to skip a per-item
   * lookup (bulk runs do), otherwise they are resolved from the record's library.
   * `libraryKind` anchors classification (see {@link mediaTypeFromParsed});
   * `libraryPath` bounds the show-folder climb (see {@link parseFromPath}).
   *
   * A locked item is returned untouched: identity is the operator's, and this is
   * the automated path. (The explicit endpoints refuse outright — see
   * {@link manualMatch}.)
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
    if (record.locked) return record;

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
        // A two-parter in one file covers E01..E02; without the span, E02 reads as
        // missing forever and the search hunts an episode the library already has.
        episodeEnd: parsed.episodeEnd ?? null,
        confidence,
        matchStatus: confidence >= MATCH_THRESHOLD ? 'matched' : 'unmatched',
        seriesImdbId: isEpisodic
          ? await this.resolveSeriesImdbId(record.id, parsed.season ?? null)
          : null,
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
   * `unmatched`). Locked items are excluded unconditionally — no `matchStatus`
   * filter can select them back in.
   */
  async identifyBulk(
    filter: BulkIdentifyFilter = {},
    report?: BulkIdentifyReporter,
  ): Promise<BulkIdentifySummary> {
    const where: Prisma.MediaItemWhereInput = { locked: false };
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
  private async resolveSeriesImdbId(itemId: string, season?: number | null): Promise<string | null> {
    try {
      const ext = await this.prisma.mediaExternalId.findUnique({
        where: { itemId_provider: { itemId, provider: 'imdb' } },
      });
      const tconst = ext?.externalId;
      if (!tconst) return null;
      const ep = await this.prisma.iMDbEpisode.findUnique({
        where: { episodeTitleId: tconst },
      });
      const series = ep
        ? ep.parentTitleId
        : await this.prisma.iMDbTitle
            .findUnique({ where: { tconst } })
            .then((t) =>
              t && (t.titleType === 'tvSeries' || t.titleType === 'tvMiniSeries') ? tconst : null,
            );
      if (!series) return null;
      return (await this.seriesCanContainSeason(series, season)) ? series : null;
    } catch {
      return null;
    }
  }

  /**
   * Can this series contain a season numbered `season` at all?
   *
   * The identity of an episode file is only ever as good as the id it inherits — usually
   * from an NFO sidecar written by whatever tool organised the library first. That id can
   * simply be **wrong**: a library filed as *The Librarians (2007)* (an Australian comedy,
   * 3 seasons) actually held TNT's *The Librarians* (2014), and its S04 episodes were
   * matched to the 2007 series regardless. A series with three seasons cannot have a
   * fourth — the claim refutes itself, and nothing was checking.
   *
   * Once a bad id is on the item it poisons everything downstream: the missing-episode
   * diff scans the wrong series, decides episodes are missing that aren't, and the search
   * grabs releases of a different show.
   *
   * Deliberately conservative — it rejects only when the season is absent from the
   * catalogue ENTIRELY. A brand-new episode of an existing season is routinely not in the
   * IMDb dataset yet, and must not be treated as a mis-identification.
   */
  private async seriesCanContainSeason(
    seriesTconst: string,
    season?: number | null,
  ): Promise<boolean> {
    if (season == null) return true;
    const known = await this.prisma.iMDbEpisode.count({
      where: { parentTitleId: seriesTconst, seasonNumber: season },
    });
    if (known > 0) return true;
    // Only distrust the id if we actually know the series' shape. An uncatalogued series
    // tells us nothing, and rejecting on no evidence would unmatch half a library.
    const anyEpisodes = await this.prisma.iMDbEpisode.count({
      where: { parentTitleId: seriesTconst },
    });
    if (anyEpisodes === 0) return true;
    this.logger.warn(
      `Series ${seriesTconst} has no season ${season} in the catalogue — refusing to match ` +
        `this episode to it. The library's id for this show is probably wrong.`,
    );
    return false;
  }

  /**
   * Explicit re-identification (the API path). Unlike {@link identify}, which
   * silently returns a locked item so bulk runs can skip it, this refuses —
   * a no-op answer to a direct request would read as "re-identified" when
   * nothing happened.
   */
  async reidentify(itemId: string) {
    const record = await this.prisma.mediaItem.findUnique({ where: { id: itemId } });
    if (!record) throw new NotFoundException('Item not found');
    if (record.locked) throw new ConflictException('Item is locked — unlock it to re-identify it');
    return this.identify(record);
  }

  /**
   * Operator override — authoritative identity, always full confidence.
   *
   * Refuses a locked item rather than silently skipping it: this is an explicit
   * request, so a no-op would read as success and leave the operator believing
   * they had re-matched something they hadn't.
   */
  async matchManually(itemId: string, dto: ManualMatchDto) {
    const record = await this.prisma.mediaItem.findUnique({ where: { id: itemId } });
    if (!record) throw new NotFoundException('Item not found');
    if (record.locked) throw new ConflictException('Item is locked — unlock it to change its identity');

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
        // No season passed on purpose: a manual match is the operator's explicit
        // statement of identity, so the "can this series contain that season?" guard
        // must not overrule it. The guard exists to catch ids the library *inherited*.
        seriesImdbId: isEpisodic ? await this.resolveSeriesImdbId(itemId) : null,
      },
    });
  }

  /** Clear identification back to an unmatched state. Refuses a locked item. */
  async unmatch(itemId: string) {
    const record = await this.prisma.mediaItem.findUnique({ where: { id: itemId } });
    if (!record) throw new NotFoundException('Item not found');
    if (record.locked) throw new ConflictException('Item is locked — unlock it to change its identity');

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
   * series title (and year) from the show-root folder (climbing past both generic
   * `Season NN` containers AND an unrenamed release dir nested under the show root —
   * see {@link showFolderName} — bounded by the library root so we never grab the
   * library folder itself). Season/episode/quality still come from the filename.
   *
   * When the file is *not* in such a container and the filename already names a
   * title (a loose scene release like `Show.Name.S02E05...`), that filename title
   * is authoritative — the folder is likely a junk/download dir, not the show.
   */
  private parseFromPath(filePath: string, libraryPath?: string): ParsedTorrentMeta {
    return parseItemIdentity(filePath, libraryPath);
  }

  /** Instance wrapper — see the exported {@link showFolderName}. */
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
