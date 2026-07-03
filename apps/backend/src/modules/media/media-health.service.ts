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
      missingArtwork,
      missingSubtitles,
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
      this.prisma.mediaItem.count({ where: { artwork: { none: {} } } }),
      this.prisma.mediaItem.count({ where: { subtitles: { none: {} } } }),
      this.prisma.mediaItem.count({ where: { createdAt: { gte: recentSince } } }),
      this.prisma.mediaDuplicateGroup.count(),
      this.prisma.mediaProcessingJob.count({ where: { status: 'failed' } }),
    ]);

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
