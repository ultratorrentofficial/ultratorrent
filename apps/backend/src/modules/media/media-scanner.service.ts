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

const VIDEO_EXT = new Set([
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
            data: { title: identity.title, season: parsedSeason, episode: parsedEpisode },
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

    await report?.(92, 'Importing artwork & metadata sidecars…');
    const { artworkImported, metadataImported } = await this.importSidecars(
      itemIds,
      library.artworkEnabled,
    );
    await report?.(
      100,
      `Done — ${files.length} scanned, ${added} added, ${updated} updated, ${removed} removed` +
        (artworkImported ? `, ${artworkImported} artwork` : '') +
        (metadataImported ? `, ${metadataImported} metadata` : ''),
    );

    await this.prisma.mediaLibrary.update({
      where: { id: libraryId },
      data: { lastScanAt: new Date() },
    });

    this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, {
      event: NOTIFICATION_EVENTS.MEDIA_LIBRARY_SCAN_COMPLETED,
      payload: { libraryName: library.name, mediaTitle: library.name, libraryId, scanned: files.length, added, updated, removed },
      at: new Date().toISOString(),
    });
    return { libraryId, scanned: files.length, added, updated, removed, artworkImported, metadataImported };
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
