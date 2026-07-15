/**
 * Builds a media file's search IDENTITY (SubtitleFingerprint).
 *
 * Reuses what media_manager already measured — MediaFile carries the mediainfo
 * probe results (durationSec / frameRate / resolution / codecs / releaseGroup)
 * and MediaExternalId carries imdb/tmdb/tvdb — and adds only the two things a
 * subtitle provider needs and nobody else stores: the OpenSubtitles movie hash
 * and a sampled content hash. It reads just 128 KiB regardless of file size, and
 * is confined to the ops hard roots (FilePathService).
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SubtitleFingerprint } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../../files/file-path.service';
import { HASH_BLOCK_BYTES, computeMovieHash } from './moviehash';

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.ts', '.m2ts', '.wmv', '.mov', '.webm']);

@Injectable()
export class VideoFingerprintService {
  private readonly logger = new Logger(VideoFingerprintService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly filePath: FilePathService,
  ) {}

  /** Read the head + tail 64 KiB blocks of a file in one open. */
  private async readEnds(safePath: string, size: number): Promise<{ head: Buffer; tail: Buffer }> {
    const fh = await open(safePath, 'r');
    try {
      const head = Buffer.alloc(HASH_BLOCK_BYTES);
      const tail = Buffer.alloc(HASH_BLOCK_BYTES);
      await fh.read(head, 0, HASH_BLOCK_BYTES, 0);
      await fh.read(tail, 0, HASH_BLOCK_BYTES, Math.max(0, size - HASH_BLOCK_BYTES));
      return { head, tail };
    } finally {
      await fh.close();
    }
  }

  /**
   * Compute (or refresh) the fingerprint for an item's primary video file.
   * Returns the persisted row. Never throws for a missing/absent-on-disk file —
   * it records what it can (hashes null) so search can still fall back to ids.
   */
  async fingerprint(itemId: string): Promise<SubtitleFingerprint> {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: itemId },
      include: { files: true, externalIds: true },
    });
    if (!item) throw new NotFoundException('Item not found');

    // Primary video = the largest file with a video extension (fallback: first file).
    const videos = item.files
      .filter((f) => VIDEO_EXT.has(path.extname(f.path).toLowerCase()))
      .sort((a, b) => Number(b.size) - Number(a.size));
    const file = videos[0] ?? item.files[0] ?? null;

    let movieHash: string | null = null;
    let sha256: string | null = null;
    let fileSize = file ? Number(file.size) : 0;

    if (file) {
      try {
        const safe = this.filePath.assertWithinHardRoots(file.path);
        const st = await stat(safe);
        fileSize = st.size;
        if (st.size >= 2 * HASH_BLOCK_BYTES) {
          const { head, tail } = await this.readEnds(safe, st.size);
          movieHash = computeMovieHash(st.size, head, tail);
          // Sampled content hash (head+tail+size) — cheap, stable, dedup-friendly.
          // NOT a full-file digest: hashing multi-GB media on every fingerprint is
          // not worth it, and head+tail+size already separates distinct encodes.
          sha256 = createHash('sha256')
            .update(head)
            .update(tail)
            .update(String(st.size))
            .digest('hex');
        }
      } catch (err) {
        // Outside roots, missing, or unreadable — degrade to id-only search.
        this.logger.warn(`fingerprint IO skipped for ${itemId}: ${(err as Error).message}`);
      }
    }

    const ext = (p?: string) => item.externalIds.find((e) => e.provider === p)?.externalId ?? null;
    // For a TV episode the SERIES imdb id is what subtitle providers key on.
    const imdbId = item.seriesImdbId ?? ext('imdb');

    const data = {
      fileId: file?.id ?? null,
      movieHash,
      sha256,
      fileSize: BigInt(fileSize),
      runtimeSec: file?.durationSec ?? null,
      frameRate: file?.frameRate ?? null,
      resolution: file?.resolution ?? null,
      videoCodec: file?.videoCodec ?? null,
      audioCodec: file?.audioCodec ?? null,
      audioLanguage: file?.language ?? null,
      container: file?.container ?? null,
      source: null as string | null,
      releaseGroup: file?.releaseGroup ?? null,
      hdr: file?.hdr ?? null,
      edition: null as string | null,
      season: item.season ?? null,
      episode: item.episode ?? null,
      imdbId,
      tmdbId: ext('tmdb'),
      tvdbId: ext('tvdb'),
      mediaType: item.mediaType,
    };

    return this.prisma.subtitleFingerprint.upsert({
      where: { itemId },
      create: { itemId, ...data },
      update: data,
    });
  }
}
