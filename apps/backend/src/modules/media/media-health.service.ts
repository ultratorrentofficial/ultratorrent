import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** Low-confidence threshold mirrors the identification match threshold. */
const LOW_CONFIDENCE = 0.5;
const RECENT_DAYS = 7;

/**
 * Aggregated health/overview metrics for the Media Manager dashboard: library
 * composition plus the counts operators act on (unmatched, missing artwork/
 * subtitles, low-confidence, duplicates, failed jobs).
 */
@Injectable()
export class MediaHealthService {
  constructor(private readonly prisma: PrismaService) {}

  async health() {
    const recentSince = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);

    const [
      byTypeRaw,
      total,
      unmatched,
      lowConfidence,
      missingArtworkRows,
      missingSubtitlesRows,
      recentlyAdded,
      duplicateGroups,
      failedJobs,
    ] = await this.prisma.$transaction([
      this.prisma.mediaItem.groupBy({
        by: ['mediaType'],
        _count: { _all: true },
        orderBy: { mediaType: 'asc' },
      }),
      this.prisma.mediaItem.count(),
      this.prisma.mediaItem.count({ where: { matchStatus: 'unmatched' } }),
      this.prisma.mediaItem.count({ where: { confidence: { lt: LOW_CONFIDENCE } } }),
      /*
       * Anti-joins, written by hand.
       *
       * Prisma compiles `{ artwork: { none: {} } }` to
       * `id NOT IN (SELECT "itemId" FROM media_artwork ...)`. Postgres cannot
       * use the index for that: `NOT IN` over a nullable column carries
       * three-valued-logic semantics, so it falls back to materialising the
       * whole subquery per row. At 29k items against 390k artwork rows that
       * stopped completing at all — the dashboard hung indefinitely, and because
       * these run inside `$transaction` the entire page hung with them, piling up
       * a fresh stuck query on every reload.
       *
       * `NOT EXISTS` is an anti-join the planner can satisfy from
       * `media_artwork_itemId_type_idx`: 180s+ (unbounded) → ~0.5s measured on
       * the live dataset.
       */
      this.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM media_items i
        WHERE NOT EXISTS (SELECT 1 FROM media_artwork a WHERE a."itemId" = i.id)
      `,
      this.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM media_items i
        WHERE NOT EXISTS (SELECT 1 FROM media_subtitles s WHERE s."itemId" = i.id)
      `,
      this.prisma.mediaItem.count({ where: { createdAt: { gte: recentSince } } }),
      this.prisma.mediaDuplicateGroup.count(),
      this.prisma.mediaProcessingJob.count({ where: { status: 'failed' } }),
    ]);

    // COUNT(*) comes back as bigint, which does not survive JSON serialization.
    const countOf = (rows: Array<{ count: bigint }>) => Number(rows[0]?.count ?? 0);
    const missingArtwork = countOf(missingArtworkRows);
    const missingSubtitles = countOf(missingSubtitlesRows);

    const byMediaType = byTypeRaw.reduce<Record<string, number>>((acc, row) => {
      const count = row._count as { _all: number } | undefined;
      acc[row.mediaType] = count?._all ?? 0;
      return acc;
    }, {});

    return {
      total,
      byMediaType,
      unmatched,
      lowConfidence,
      missingArtwork,
      missingSubtitles,
      recentlyAdded,
      duplicateGroups,
      failedJobs,
    };
  }

  async dashboard() {
    const [health, libraries] = await Promise.all([
      this.health(),
      this.prisma.mediaLibrary.findMany({
        orderBy: { createdAt: 'asc' },
        include: { _count: { select: { items: true } } },
      }),
    ]);

    return {
      health,
      libraries: libraries.map((lib) => ({
        id: lib.id,
        name: lib.name,
        kind: lib.kind,
        path: lib.path,
        isEnabled: lib.isEnabled,
        lastScanAt: lib.lastScanAt,
        itemCount: lib._count.items,
      })),
    };
  }
}
