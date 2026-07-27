import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface Move {
  from: string;
  to: string;
}

export interface RelocationResult {
  items: number;
  files: number;
  subtitles: number;
  nfo: number;
  artwork: number;
}

const EMPTY: RelocationResult = { items: 0, files: 0, subtitles: 0, nfo: 0, artwork: 0 };

/**
 * Keeps the database pointing at where the files actually are.
 *
 * A path in this platform is a *property of a tracked record*, not the identity
 * of one. Moving a file therefore updates rows; it must never leave a record
 * describing a path that no longer exists.
 *
 * Before this existed, the rename engine moved files and told nobody. The row
 * kept the old path, the next scan found the file at its new path and inserted
 * a **second** row, then pruned the first because its file was gone — and
 * because `MediaMetadata`, `MediaArtwork`, `MediaSubtitle` and `MediaNfoFile`
 * all cascade from `MediaItem`, that prune destroyed the item's entire
 * enrichment. A rename silently cost the library its metadata, artwork,
 * subtitle inventory, external ids, manual match and lock, and returned an
 * `unmatched` row with a new id in their place.
 *
 * Everything in a media folder belongs to the item it accompanies, so all five
 * path-bearing records move together:
 *
 * | Record | Column |
 * |---|---|
 * | `MediaItem` | `path` |
 * | `MediaFile` | `path` |
 * | `MediaSubtitle` | `path` |
 * | `MediaNfoFile` | `path` |
 * | `MediaArtwork` | `localPath` |
 */
@Injectable()
export class MediaRelocationService {
  private readonly logger = new Logger(MediaRelocationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Follow one file to its new location.
   *
   * Matched on the **exact** old path rather than a prefix. A prefix match would
   * rewrite every record under a directory that merely shares a name prefix
   * (`/media/Show` also prefixes `/media/Show Two`), and a rename plan already
   * names each file it moves — so exactness costs nothing and removes a whole
   * class of silent corruption.
   *
   * One transaction: a half-applied relocation is a row pointing at neither the
   * old nor the new location.
   */
  async recordMove(from: string, to: string): Promise<RelocationResult> {
    if (!from || !to || from === to) return { ...EMPTY };

    const [items, files, subtitles, nfo, artwork] = await this.prisma.$transaction([
      this.prisma.mediaItem.updateMany({ where: { path: from }, data: { path: to } }),
      this.prisma.mediaFile.updateMany({ where: { path: from }, data: { path: to } }),
      this.prisma.mediaSubtitle.updateMany({ where: { path: from }, data: { path: to } }),
      this.prisma.mediaNfoFile.updateMany({ where: { path: from }, data: { path: to } }),
      this.prisma.mediaArtwork.updateMany({ where: { localPath: from }, data: { localPath: to } }),
    ]);

    return {
      items: items.count,
      files: files.count,
      subtitles: subtitles.count,
      nfo: nfo.count,
      artwork: artwork.count,
    };
  }

  /**
   * Follow a batch, reporting the total.
   *
   * Sequential rather than concurrent: two moves in one run can touch the same
   * row (a rename chain), and interleaving them would make the outcome depend
   * on scheduling.
   */
  async recordMoves(moves: Move[]): Promise<RelocationResult> {
    const total = { ...EMPTY };
    for (const move of moves) {
      const one = await this.recordMove(move.from, move.to);
      for (const key of Object.keys(total) as Array<keyof RelocationResult>) {
        total[key] += one[key];
      }
    }
    return total;
  }

  /**
   * Forget a file that has genuinely been deleted.
   *
   * Sidecar rows only: deleting the `MediaItem` here would cascade its metadata
   * and artwork away, and cleanup removing a stray `.srt` is not a statement
   * about the film. An item whose *video* is gone is the scanner's business,
   * which prunes it deliberately and prunes duplicate groups with it.
   */
  async recordDelete(path: string): Promise<RelocationResult> {
    if (!path) return { ...EMPTY };

    const [subtitles, nfo, artwork] = await this.prisma.$transaction([
      this.prisma.mediaSubtitle.deleteMany({ where: { path } }),
      this.prisma.mediaNfoFile.deleteMany({ where: { path } }),
      this.prisma.mediaArtwork.deleteMany({ where: { localPath: path } }),
    ]);

    return {
      ...EMPTY,
      subtitles: subtitles.count,
      nfo: nfo.count,
      artwork: artwork.count,
    };
  }

  /**
   * Relocate, never letting a bookkeeping failure fail the file operation.
   *
   * The move already happened on disk. Throwing here would report a failed
   * rename for work that succeeded, and the caller would have no way to tell
   * the difference — so a failure is logged loudly and the next scan reconciles.
   */
  async recordMoveSafe(from: string, to: string): Promise<void> {
    try {
      await this.recordMove(from, to);
    } catch (err) {
      this.logger.error(
        `Relocation bookkeeping failed for ${from} → ${to}: ${(err as Error).message}`,
      );
    }
  }
}
