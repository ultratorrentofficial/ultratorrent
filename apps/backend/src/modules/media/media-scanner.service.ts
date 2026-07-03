import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../files/file-path.service';

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

    for (const file of files) {
      const existing = await this.prisma.mediaItem.findFirst({
        where: { libraryId, path: file.path },
        include: { files: true },
      });

      if (existing) {
        await this.prisma.mediaFile.upsert({
          where: {
            id: existing.files[0]?.id ?? '00000000-0000-0000-0000-000000000000',
          },
          create: {
            itemId: existing.id,
            path: file.path,
            size: BigInt(file.size),
            container: path.extname(file.path).replace(/^\./, '') || null,
          },
          update: { size: BigInt(file.size) },
        });
        updated++;
      } else {
        const title = path.basename(file.path, path.extname(file.path));
        await this.prisma.mediaItem.create({
          data: {
            libraryId,
            mediaType: this.defaultMediaType(library.kind),
            title,
            path: file.path,
            files: {
              create: {
                path: file.path,
                size: BigInt(file.size),
                container: path.extname(file.path).replace(/^\./, '') || null,
              },
            },
          },
        });
        added++;
      }
    }

    await this.prisma.mediaLibrary.update({
      where: { id: libraryId },
      data: { lastScanAt: new Date() },
    });

    return { libraryId, scanned: files.length, added, updated };
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
        out.push(...(await this.walk(full)));
      } else if (VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) {
        const info = await stat(full).catch(() => null);
        if (info) out.push({ path: full, size: info.size });
      }
    }
    return out;
  }
}
