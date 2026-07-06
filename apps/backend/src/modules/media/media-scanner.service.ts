import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../files/file-path.service';
import { parseTorrentName } from '../rss/torrent-name-parser';
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
  ) {}

  async scanLibrary(libraryId: string): Promise<ScanSummary> {
    const library = await this.prisma.mediaLibrary.findUnique({
      where: { id: libraryId },
    });
    if (!library) throw new NotFoundException('Library not found');

    // The library root must live inside the allowed storage roots.
    const root = this.filePath.assertWithinHardRoots(library.path);

    const files = await this.walk(root);
    let added = 0;
    let updated = 0;
    const itemIds: string[] = [];

    for (const file of files) {
      const existing = await this.prisma.mediaItem.findFirst({
        where: { libraryId, path: file.path },
        include: { files: true },
      });

      const tech = deriveFileTechInfo(file.path);

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
        itemIds.push(existing.id);
        updated++;
      } else {
        const title = path.basename(file.path, path.extname(file.path));
        const created = await this.prisma.mediaItem.create({
          data: {
            libraryId,
            mediaType: this.defaultMediaType(library.kind),
            title,
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
    }

    const { artworkImported, metadataImported } = await this.importSidecars(
      itemIds,
      library.artworkEnabled,
    );

    await this.prisma.mediaLibrary.update({
      where: { id: libraryId },
      data: { lastScanAt: new Date() },
    });

    return { libraryId, scanned: files.length, added, updated, artworkImported, metadataImported };
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

    const enriched = await this.prisma.mediaItem.findMany({
      where: { id: { in: itemIds }, metadata: { isNot: null }, artwork: { some: {} } },
      select: { id: true },
    });
    const skip = new Set(enriched.map((r) => r.id));

    for (const id of itemIds) {
      if (skip.has(id)) continue;
      if (artworkEnabled) {
        try {
          artworkImported += await this.artwork.importLocal(id);
        } catch (err) {
          this.logger.warn(`Sidecar artwork import failed for ${id}: ${(err as Error).message}`);
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
