import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { NOTIFICATION_BUS_CHANNEL, NOTIFICATION_EVENTS } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../files/file-path.service';
import { parseTorrentName } from '../rss/torrent-name-parser';
import { parseItemIdentity } from './media-identification.service';
import { MediaArtworkService } from './media-artwork.service';
import { MediaMetadataService } from './media-metadata.service';
import { TV_TYPES, parseFolderTitle, showCanonicalKey } from './series-grouping';
import { MediaShowDuplicateService } from './media-show-duplicate.service';

/** Library kinds whose contents are shows (and therefore get MediaShow rows). */
const SHOW_LIBRARY_KINDS = ['tv', 'anime'];

/**
 * The show folder a file belongs to: the **direct child of the library root** that
 * contains it. Returns null for a file sitting loose at the root, which has no show
 * folder of its own.
 *
 * A show folder is defined by its POSITION, not by its name. `showFolderRoot()`
 * climbs only one level past a `Season NN` container, so for the very common layout
 *
 *   TV Shows/Billions (2016)/Billions.S07E02.WEB.x264-TGx/Billions.S07E02.mkv
 *                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^ a release/torrent folder
 *
 * it stops at the release folder and calls *that* the show. Recording those as shows
 * produced 15 bogus "duplicate show" families on a real library — `Billions (2016)`
 * versus a subdirectory of itself — and would have let a monitored show bind to a
 * single torrent's folder. Season containers, `Extras`, complete-season packs and
 * nested release dirs are all *inside* a show, however they are named.
 */
export function showFolderOf(libraryPath: string, filePath: string): string | null {
  const rel = path.relative(libraryPath, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const [first] = rel.split(path.sep);
  if (!first) return null;
  // The file IS the first segment → it sits loose at the library root.
  if (first === path.basename(filePath)) return null;
  return path.join(libraryPath, first);
}

/** Technical fields derived from a release filename for a MediaFile row. */
export interface MediaFileTechInfo {
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  hdr: string | null;
  language: string | null;
  releaseGroup: string | null;
  quality: string | null;
}

/**
 * Derive MediaFile technical metadata by parsing a release filename with the
 * shared torrent-name parser. Pure — exported for unit testing.
 */
export function deriveFileTechInfo(filePath: string): MediaFileTechInfo {
  const parsed = parseTorrentName(path.basename(filePath));
  const container = path.extname(filePath).replace(/^\./, '').toLowerCase() || null;
  const quality = [parsed.source, parsed.resolution].filter(Boolean).join(' ') || null;
  return {
    container,
    videoCodec: parsed.codec ?? null,
    audioCodec: parsed.audio[0] ?? null,
    resolution: parsed.resolution ?? null,
    hdr: parsed.hdr.length ? parsed.hdr.join('/') : null,
    language: parsed.languages[0] ?? null,
    releaseGroup: parsed.releaseGroup ?? null,
    quality,
  };
}

/**
 * Directories the scan skips entirely. Hidden/dot folders hold trash or sidecar
 * metadata rather than library content — e.g. tinyMediaManager's `.deletedByTMM`
 * (deleted items) and `.actors`, macOS `.Trashes` — and Synology litters every
 * share with `@eaDir` thumbnail folders. Indexing these surfaces phantom,
 * unmatchable items. Pure — exported for unit testing.
 */
export function isIgnoredScanDir(name: string): boolean {
  return name.startsWith('.') || name === '@eaDir';
}

/**
 * Marker files that exclude the folder holding them — and everything beneath it
 * — from the library. `.nomedia` is the Android/Kodi convention; `.tmmignore`
 * and `tmmignore` are tinyMediaManager's. Honouring the same markers is what
 * lets a shared tree tell BOTH tools "this subtree is not library content"
 * once, rather than per-tool.
 */
export const SCAN_SKIP_MARKERS = new Set(['.nomedia', '.tmmignore', 'tmmignore']);

/**
 * True when a directory's entries include a skip marker. Pure — exported for
 * unit testing.
 *
 * Note the reconcile consequence: dropping a marker into a folder that was
 * already scanned PRUNES its items on the next scan (the walk stops returning
 * those paths). That removes database rows only — {@link scanLibrary} never
 * deletes files — so a marker is a library-membership statement, not a delete.
 */
export function hasScanSkipMarker(entryNames: string[]): boolean {
  return entryNames.some((n) => SCAN_SKIP_MARKERS.has(n));
}

export const VIDEO_EXT = new Set([
  '.mkv',
  '.mp4',
  '.avi',
  '.m4v',
  '.ts',
  '.m2ts',
  '.wmv',
  '.mov',
  '.webm',
]);

export interface ScanSummary {
  libraryId: string;
  scanned: number;
  added: number;
  updated: number;
  /** Items removed because their file no longer exists on disk. */
  removed: number;
  /** On-disk sidecar artwork files imported during this scan. */
  artworkImported: number;
  /** Items whose local .nfo metadata was imported during this scan. */
  metadataImported: number;
  /** Show folders recorded for this library (0 for a non-show library). */
  shows: number;
  /**
   * Families of show folders that look like the SAME show ("Happy's Place (2024)"
   * beside "Happys Place"). The scan only reports them — merging moves files and
   * deletes a folder, so it is never done without the operator choosing which path
   * is the real one.
   */
  duplicateShows: number;
}

/**
 * Walks a library's folder tree (constrained to the ops hard roots) and
 * reconciles the video files it finds into MediaItem + MediaFile rows.
 */
@Injectable()
export class MediaScannerService {
  private readonly logger = new Logger(MediaScannerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly filePath: FilePathService,
    private readonly artwork: MediaArtworkService,
    private readonly metadata: MediaMetadataService,
    private readonly eventBus: EventEmitter2,
    private readonly showDuplicates: MediaShowDuplicateService,
  ) {}

  async scanLibrary(
    libraryId: string,
    report?: (progress: number, message?: string) => void | Promise<void>,
  ): Promise<ScanSummary> {
    const library = await this.prisma.mediaLibrary.findUnique({
      where: { id: libraryId },
    });
    if (!library) throw new NotFoundException('Library not found');

    // The library root must live inside the allowed storage roots.
    const root = this.filePath.assertWithinHardRoots(library.path);

    await report?.(2, `Reading “${library.name}” folder tree…`);
    const files = await this.walk(root);
    await report?.(5, `Found ${files.length} file(s) to process`);
    let added = 0;
    let updated = 0;
    const itemIds: string[] = [];
    // Throttle per-file progress to ~150 updates so a large library streams a
    // readable action log without flooding the socket.
    const step = Math.max(1, Math.floor(files.length / 150));

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const existing = await this.prisma.mediaItem.findFirst({
        where: { libraryId, path: file.path },
        include: { files: true },
      });

      const tech = deriveFileTechInfo(file.path);
      const action = existing ? 'Updated' : 'Added';

      // Identity from the file's name AND folder context — the series title lives
      // in the show folder for an organised `Show/Season NN/episode` layout, while
      // season/episode come from the filename. Without this the item was stored
      // with the raw filename as its title and null season/episode, which
      // fragmented a show into one bogus "series" per episode and broke
      // owned-episode detection until some later identification pass ran.
      const identity = parseItemIdentity(file.path, library.path);
      const parsedSeason = identity.season ?? null;
      const parsedEpisode = identity.episode ?? identity.absoluteEpisode ?? null;
      // A single file can hold several episodes (an 88-min "S01E01 S01E02" two-part
      // premiere). The scan is the ONLY writer for most items — identification never
      // runs again on an already-matched one — so the span has to be recorded here or
      // the extra episodes look missing forever and the search hunts a phantom.
      const parsedEpisodeEnd = identity.episodeEnd ?? null;

      if (existing) {
        await this.prisma.mediaFile.upsert({
          where: {
            id: existing.files[0]?.id ?? '00000000-0000-0000-0000-000000000000',
          },
          create: {
            itemId: existing.id,
            path: file.path,
            size: BigInt(file.size),
            ...tech,
          },
          update: { size: BigInt(file.size), ...tech },
        });
        // Self-heal a never-identified episodic item: it still carries the raw
        // filename as its title and no season/episode. Only touched when the item
        // has NO episode structure stored and the path clearly yields one, so a
        // matched/user-corrected item is never clobbered.
        if (
          existing.season == null &&
          existing.episode == null &&
          parsedSeason != null &&
          parsedEpisode != null &&
          identity.title
        ) {
          await this.prisma.mediaItem.update({
            where: { id: existing.id },
            data: {
              title: identity.title,
              season: parsedSeason,
              episode: parsedEpisode,
              episodeEnd: parsedEpisodeEnd,
            },
          });
        }
        // Backfill the span onto an item that already has its season/episode. The
        // self-heal above deliberately refuses to touch an identified item, but an
        // episodeEnd is new information, not a re-identification — without this, every
        // two-parter already in a library stays a phantom missing episode forever.
        else if (
          parsedEpisodeEnd != null &&
          existing.episodeEnd == null &&
          existing.season === parsedSeason &&
          existing.episode === parsedEpisode
        ) {
          await this.prisma.mediaItem.update({
            where: { id: existing.id },
            data: { episodeEnd: parsedEpisodeEnd },
          });
        }
        itemIds.push(existing.id);
        updated++;
      } else {
        const title = identity.title ?? path.basename(file.path, path.extname(file.path));
        const created = await this.prisma.mediaItem.create({
          data: {
            libraryId,
            mediaType: this.defaultMediaType(library.kind),
            title,
            year: identity.year ?? undefined,
            season: parsedSeason,
            episode: parsedEpisode,
            episodeEnd: parsedEpisodeEnd,
            path: file.path,
            files: {
              create: {
                path: file.path,
                size: BigInt(file.size),
                ...tech,
              },
            },
          },
        });
        itemIds.push(created.id);
        added++;
      }

      if (i % step === 0 || i === files.length - 1) {
        const pct = 5 + Math.round((i / (files.length || 1)) * 80); // 5..85
        await report?.(pct, `${i + 1}/${files.length} · ${action}: ${path.basename(file.path)}`);
      }
    }

    // Reconcile deletions: drop items whose file is no longer on disk (e.g. a
    // file removed outside UltraTorrent, or now living under a skipped dot-folder
    // like tinyMediaManager's `.deletedByTMM`). Guard: only prune when the walk
    // returned files — an empty walk usually means an unreadable/unmounted root,
    // and we must never wipe a whole library because a mount dropped.
    let removed = 0;
    if (files.length > 0) {
      const present = new Set(files.map((f) => f.path));
      const existingItems = await this.prisma.mediaItem.findMany({ where: { libraryId }, select: { id: true, path: true } });
      const staleIds = existingItems.filter((i) => !present.has(i.path)).map((i) => i.id);
      if (staleIds.length > 0) {
        removed = (await this.prisma.mediaItem.deleteMany({ where: { id: { in: staleIds } } })).count;
        this.logger.log(`Scan of ${library.name}: pruned ${removed} item(s) whose files no longer exist`);
        await report?.(88, `Pruned ${removed} stale item(s) whose files were gone`);
      }
    }

    // Record the show FOLDERS this library actually has, so nothing downstream has
    // to reconstruct one from a title. Runs after the prune so a folder whose files
    // are all gone disappears with them.
    await report?.(90, 'Recording show folders…');
    const shows = await this.reconcileShows(library);

    const duplicateShows = await this.countDuplicateShows(library, shows);
    if (duplicateShows > 0) {
      await report?.(
        91,
        `${duplicateShows} possible duplicate show folder(s) found — review them under Media → Duplicates`,
      );
    }

    await report?.(92, 'Importing artwork & metadata sidecars…');
    const { artworkImported, metadataImported } = await this.importSidecars(
      itemIds,
      library.artworkEnabled,
    );
    await report?.(
      100,
      `Done — ${files.length} scanned, ${added} added, ${updated} updated, ${removed} removed` +
        (shows ? `, ${shows} show folder(s)` : '') +
        (duplicateShows ? `, ${duplicateShows} possible duplicate show(s)` : '') +
        (artworkImported ? `, ${artworkImported} artwork` : '') +
        (metadataImported ? `, ${metadataImported} metadata` : ''),
    );

    await this.prisma.mediaLibrary.update({
      where: { id: libraryId },
      data: { lastScanAt: new Date() },
    });

    this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, {
      event: NOTIFICATION_EVENTS.MEDIA_LIBRARY_SCAN_COMPLETED,
      payload: { libraryName: library.name, mediaTitle: library.name, libraryId, scanned: files.length, added, updated, removed, duplicateShows },
      at: new Date().toISOString(),
    });
    return { libraryId, scanned: files.length, added, updated, removed, artworkImported, metadataImported, shows, duplicateShows };
  }

  /**
   * Count the families of show folders that look like the SAME show — "Happy's Place
   * (2024)" beside "Happys Place".
   *
   * The scan REPORTS them and stops. It must never merge on its own: a merge moves
   * files and PERMANENTLY deletes a folder, and nothing here can know which of the
   * two paths is the real one. The operator chooses the canonical path, sees the exact
   * plan, and confirms.
   *
   * Best-effort. A library whose duplicates we cannot compute is still a successfully
   * scanned library — a detection failure must not fail the scan.
   */
  private async countDuplicateShows(
    library: { id: string; name: string },
    shows: number,
  ): Promise<number> {
    if (shows === 0) return 0; // nothing recorded → nothing to compare
    try {
      const families = await this.showDuplicates.detect(library.id);
      if (families.length > 0) {
        this.logger.warn(
          `Scan of ${library.name}: ${families.length} possible duplicate show folder(s). ` +
            `Nothing was changed — an operator must choose the real path before a merge.`,
        );
      }
      return families.length;
    } catch (err) {
      this.logger.warn(`Duplicate-show detection failed for ${library.name}: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * Record one {@link MediaShow} row per show FOLDER the library actually has.
   *
   * This is the whole point of the table: the folder is written down from what is
   * **on disk**, so the missing-episode sweep can file a grab into a path the
   * library observed instead of rebuilding one from the show's title. Rebuilding it
   * is what produced `TV Shows/Ghosts 2021 (2021)` and `TV Shows/Happys Place`
   * beside the real folders.
   *
   * A file with no show folder of its own (sitting directly at the library root)
   * yields no row — there is no folder to record, and inventing one is the very
   * thing this table exists to prevent.
   */
  private async reconcileShows(library: { id: string; kind: string; path: string; name: string }): Promise<number> {
    if (!SHOW_LIBRARY_KINDS.includes(library.kind)) return 0;

    const items = await this.prisma.mediaItem.findMany({
      where: { libraryId: library.id, mediaType: { in: TV_TYPES } },
      // ONLY `seriesImdbId`. An item's own `imdb` external id is the id of that
      // EPISODE, not of the show — `MediaItem` here is one episode file. Using it as
      // the show's id is a category error, and it silently produced nonsense: on a
      // real library the episode tconst tt13701758 ("Pilot", a tvEpisode) had been
      // mis-assigned to 18 different shows' pilots, so 18 unrelated series — Ted
      // Lasso, Servant, Dickinson, Hawkeye… — all came out sharing one "show" id and
      // were surfaced as a duplicate-show family.
      //
      // `seriesImdbId` is the field whose entire job is to be the *series* tconst;
      // `resolveSeriesImdbId()` sets it, mapping an episode to its parent title. When
      // it is null the show simply has no id yet, and null is the honest answer — an
      // episode id here is worse than nothing, because downstream code trusts it.
      select: { path: true, seriesImdbId: true },
    });

    const byFolder = new Map<string, { count: number; imdbId: string | null }>();
    for (const it of items) {
      const dir = showFolderOf(library.path, it.path);
      if (!dir) continue; // loose at the library root — no show folder to record
      const cur = byFolder.get(dir) ?? { count: 0, imdbId: null };
      cur.count++;
      // First id wins; `??=` keeps looking while it is still null, so an episode
      // that was never identified does not shadow one that was.
      cur.imdbId ??= it.seriesImdbId ?? null;
      byFolder.set(dir, cur);
    }

    const mediaType = library.kind === 'anime' ? 'anime' : 'tv';
    for (const [dir, g] of byFolder) {
      const folder = path.basename(dir);
      const { title, year } = parseFolderTitle(folder);
      const data = {
        mediaType,
        title,
        year,
        imdbId: g.imdbId,
        canonicalKey: showCanonicalKey(folder),
        episodeCount: g.count,
      };
      await this.prisma.mediaShow.upsert({
        where: { libraryId_path: { libraryId: library.id, path: dir } },
        create: { libraryId: library.id, path: dir, ...data },
        update: data,
      });
    }

    // Prune shows whose folder no longer holds a single item — but only when the
    // scan actually saw some, mirroring the item prune. An empty result usually
    // means an unreadable root, and must not wipe the library's shows.
    if (byFolder.size > 0) {
      const stale = await this.prisma.mediaShow.deleteMany({
        where: { libraryId: library.id, path: { notIn: [...byFolder.keys()] } },
      });
      if (stale.count > 0) {
        this.logger.log(`Scan of ${library.name}: pruned ${stale.count} show folder(s) that no longer exist`);
      }
    }
    return byFolder.size;
  }

  /**
   * Import artwork + `.nfo` metadata that already sit next to the scanned media,
   * skipping items already fully enriched (have metadata AND artwork) so a
   * re-scan doesn't re-read every directory. Best-effort per item — one bad
   * sidecar never fails the scan. Artwork import honours the library flag.
   */
  private async importSidecars(
    itemIds: string[],
    artworkEnabled: boolean,
  ): Promise<{ artworkImported: number; metadataImported: number }> {
    let artworkImported = 0;
    let metadataImported = 0;
    if (itemIds.length === 0) return { artworkImported, metadataImported };

    // Consider an item "done" only when it has BOTH local metadata AND a poster.
    // Requiring a poster (not just any artwork) means items that only picked up,
    // say, an episode thumbnail still get re-scanned so show/season-level art in
    // a parent directory (poster.jpg in the show root) is imported.
    const enriched = await this.prisma.mediaItem.findMany({
      where: {
        id: { in: itemIds },
        metadata: { isNot: null },
        artwork: { some: { type: 'poster' } },
      },
      select: { id: true },
    });
    const skip = new Set(enriched.map((r) => r.id));

    for (const id of itemIds) {
      if (skip.has(id)) continue;
      // Always pick up local folder artwork (poster/fanart/folder/… sidecars) —
      // it's a cheap filesystem read and is what a library should display first.
      try {
        artworkImported += await this.artwork.importLocal(id);
      } catch (err) {
        this.logger.warn(`Sidecar artwork import failed for ${id}: ${(err as Error).message}`);
      }
      // Fall back to a provider only when the folder had no poster and the
      // library opts into artwork fetching. Self-limiting: importFromProvider
      // no-ops (no network) without a configured key + a metadata external id,
      // so a fresh un-enriched scan doesn't hammer the provider API.
      if (artworkEnabled) {
        try {
          if (await this.needsProviderArtwork(id)) {
            const res = await this.artwork.importFromProvider(id);
            if ('imported' in res) artworkImported += res.imported.length;
          }
        } catch (err) {
          this.logger.warn(`Provider artwork fetch failed for ${id}: ${(err as Error).message}`);
        }
      }
      try {
        if (await this.metadata.importLocalNfo(id)) metadataImported++;
      } catch (err) {
        this.logger.warn(`Sidecar NFO import failed for ${id}: ${(err as Error).message}`);
      }
    }
    return { artworkImported, metadataImported };
  }

  /** True when the item has no poster artwork yet (local or otherwise). */
  private async needsProviderArtwork(itemId: string): Promise<boolean> {
    const poster = await this.prisma.mediaArtwork.findFirst({
      where: { itemId, type: 'poster' },
      select: { id: true },
    });
    return !poster;
  }

  private defaultMediaType(kind: string): string {
    switch (kind) {
      case 'movie':
        return 'movie';
      case 'tv':
        return 'tv';
      case 'anime':
        return 'anime';
      default:
        return 'other_video';
    }
  }

  private async walk(dir: string): Promise<Array<{ path: string; size: number }>> {
    const out: Array<{ path: string; size: number }> = [];
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      this.logger.warn(`Cannot read directory ${dir}: ${(err as Error).message}`);
      return out;
    }
    // An excluded folder is excluded whole: return before descending, so nothing
    // beneath it is indexed either.
    if (hasScanSkipMarker(entries.filter((e) => e.isFile()).map((e) => e.name))) {
      this.logger.log(`Scan skipping ${dir}: skip marker present`);
      return out;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isIgnoredScanDir(entry.name)) continue;
        out.push(...(await this.walk(full)));
      } else if (VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) {
        const info = await stat(full).catch(() => null);
        if (info) out.push({ path: full, size: info.size });
      }
    }
    return out;
  }
}
