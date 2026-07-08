import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { MediaLibrary } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MediaProcessingService } from './media-processing.service';

const TICK_MS = 5 * 60_000;

/**
 * Periodically scans + auto-enriches each media library on its own
 * `scanIntervalMinutes` cadence.
 *
 * A cheap five-minute tick finds enabled libraries whose scan is due — never
 * scanned, or `lastScanAt` older than their interval — and runs the periodic
 * scan+enrich workflow ({@link MediaProcessingService.processLibrary}), which
 * indexes new files and fills in metadata + artwork for anything that lacks it.
 *
 * Opt-in per library: a null / zero `scanIntervalMinutes` means "manual scans
 * only" and is never auto-scanned, so existing libraries are untouched until an
 * operator sets an interval. Runs are serialised via `running` so a long scan
 * never overlaps the next tick, and each library is isolated so one failure
 * never blocks the rest. (Nest `@Interval` first fires after the interval, so a
 * fresh boot waits one tick before the first sweep; the manual "Scan" action
 * remains available for an immediate run.)
 */
@Injectable()
export class MediaLibraryScanScheduler {
  private readonly logger = new Logger(MediaLibraryScanScheduler.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly processing: MediaProcessingService,
  ) {}

  @Interval('media_library_periodic_scan', TICK_MS)
  async tick(): Promise<void> {
    // Claim the run synchronously (before any await) so a second tick firing
    // while this one is mid-scan bails out immediately rather than racing in.
    if (this.running) return;
    this.running = true;
    try {
      let libraries: MediaLibrary[];
      try {
        libraries = await this.prisma.mediaLibrary.findMany({ where: { isEnabled: true } });
      } catch (err) {
        this.logger.warn(`Could not load libraries for periodic scan: ${(err as Error).message}`);
        return;
      }

      const now = Date.now();
      const due = libraries.filter((l) => this.isDue(l, now));

      for (const library of due) {
        try {
          const s = await this.processing.processLibrary(library.id);
          this.logger.log(
            `Periodic scan of ${library.name}: scanned ${s.scanned}, identified ${s.identified}, ` +
              `metadata ${s.metadataFetched}, artwork ${s.artworkFetched}`,
          );
        } catch (err) {
          this.logger.warn(`Periodic scan of ${library.name} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** A library is due when it opts into auto-scan and its interval has elapsed. */
  private isDue(library: Pick<MediaLibrary, 'scanIntervalMinutes' | 'lastScanAt'>, now: number): boolean {
    const interval = library.scanIntervalMinutes;
    if (!interval || interval <= 0) return false; // manual-only
    if (!library.lastScanAt) return true; // never scanned → due now
    return now - library.lastScanAt.getTime() >= interval * 60_000;
  }
}
