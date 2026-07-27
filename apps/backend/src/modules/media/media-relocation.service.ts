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
   * Follow a file — or a whole folder — to its new location.
   *
   * One transaction: a half-applied relocation is a row pointing at neither the
   * old nor the new location.
   */
  async recordMove(from: string, to: string): Promise<RelocationResult> {
    if (!from || !to || from === to) return { ...EMPTY };

    const fromDir = `${from}/`;
    const toDir = `${to}/`;

    /*
     * Two matches, because a "path" may name a file or a directory.
     *
     * The exact match follows a moved file. The prefix match follows everything
     * *inside* a moved directory — renaming `Vivo (2021)` to `Vivo (2021)
     * [1080p]` moves every file beneath it, and an exact match alone would
     * update nothing at all.
     *
     * Containment is tested with `substring(...) = $` rather than `LIKE`: a path
     * may legitimately contain `%` or `_`, which `LIKE` would treat as
     * wildcards and over-match. Comparing a fixed-length prefix has no
     * metacharacters to escape. The trailing slash is what stops `/media/Show`
     * from matching `/media/Show Two`.
     */
    const rewrite = (table: string, column: string) =>
      this.prisma.$executeRawUnsafe(
        `UPDATE ${table}
            SET "${column}" = CASE WHEN "${column}" = $1 THEN $2
                                   ELSE $4 || substring("${column}" from char_length($3) + 1) END
          WHERE "${column}" = $1
             OR substring("${column}", 1, char_length($3)) = $3`,
        from, to, fromDir, toDir,
      );

    // Table and column names come from closed literals; every value is bound.
    const [items, files, subtitles, nfo, artwork] = await this.prisma.$transaction([
      rewrite('media_items', 'path'),
      rewrite('media_files', 'path'),
      rewrite('media_subtitles', 'path'),
      rewrite('media_nfo_files', 'path'),
      rewrite('media_artwork', 'localPath'),
    ]);

    return { items, files, subtitles, nfo, artwork };
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
   * Forget what has genuinely been deleted — a file, or a whole folder.
   *
   * This deletes the `MediaItem` too, which an earlier version deliberately did
   * not. That caution was wrong: if the video is gone, the item is going away
   * regardless — the scanner prunes it on the next pass, cascading the same
   * children. Withholding it bought nothing except a window in which the
   * database described a file that no longer existed, which is the exact defect
   * this service exists to remove.
   *
   * A deleted **folder** clears everything beneath it. That is the common case
   * from the file manager, and matching only the exact path left every record
   * inside a removed directory pointing at nothing.
   */
  async recordDelete(path: string): Promise<RelocationResult> {
    if (!path) return { ...EMPTY };

    const dir = `${path}/`;

    const purge = (table: string, column: string) =>
      this.prisma.$executeRawUnsafe(
        `DELETE FROM ${table}
          WHERE "${column}" = $1
             OR substring("${column}", 1, char_length($2)) = $2`,
        path, dir,
      );

    /*
     * Order matters. Sidecars go first because some belong to items that
     * survive — a `.srt` deleted on its own says nothing about the film.
     * `media_items` goes LAST because deleting it cascades its remaining
     * children, and doing that first would make the earlier counts meaningless.
     */
    const [subtitles, nfo, artwork, files, items] = await this.prisma.$transaction([
      purge('media_subtitles', 'path'),
      purge('media_nfo_files', 'path'),
      purge('media_artwork', 'localPath'),
      purge('media_files', 'path'),
      purge('media_items', 'path'),
    ]);

    return { items, files, subtitles, nfo, artwork };
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
