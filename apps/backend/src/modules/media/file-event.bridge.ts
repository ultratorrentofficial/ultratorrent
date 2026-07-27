import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DOMAIN_EVENTS, DOMAIN_EVENT_CHANNEL, type DomainEventEnvelope } from '@ultratorrent/shared';
import { dirname } from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MediaRelocationService } from './media-relocation.service';
import { MediaScannerService } from './media-scanner.service';

/** Quiet period before a touched directory is rescanned. */
const SCAN_DEBOUNCE_MS = 5_000;

/**
 * Keeps media records in step with whatever moved the bytes.
 *
 * The file manager, the trash and any future mover cannot call into the media
 * module — media already depends on files, so a direct call would close a
 * cycle. They publish a fact instead, and this follows it.
 *
 * That inversion is the point. Before it, staying consistent meant every author
 * of a file operation remembering to update five tables; the rename engine
 * forgot for as long as it has existed, and the file manager never did it at
 * all. A subsystem now only has to say what it did.
 */
@Injectable()
export class FileEventBridge {
  private readonly logger = new Logger(FileEventBridge.name);

  /** Directories awaiting a confined rescan, and the timer that will run them. */
  private readonly pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly relocation: MediaRelocationService,
    private readonly prisma: PrismaService,
    private readonly scanner: MediaScannerService,
  ) {}

  /**
   * Reconcile a touched directory shortly after the fact.
   *
   * **Order matters.** Relocation runs first and preserves identity — the record
   * follows the file, keeping its id, metadata and artwork. The scan runs second
   * and provides completeness: it notices what no event described, such as files
   * copied in by hand. Reversed, the scan would prune the stale row and cascade
   * its enrichment away before relocation could save it, which is exactly the
   * damage this whole seam exists to stop.
   *
   * Debounced because a bulk delete of forty files emits forty events, and forty
   * scans of the same folder would be thirty-nine wasted walks.
   */
  private scheduleScan(filePath: string): void {
    this.pending.add(dirname(filePath));
    if (this.timer) return;
    this.timer = setTimeout(() => {
      const dirs = [...this.pending];
      this.pending.clear();
      this.timer = null;
      void this.rescan(dirs);
    }, SCAN_DEBOUNCE_MS);
    // Never hold the process open for a bookkeeping scan.
    this.timer.unref?.();
  }

  private async rescan(dirs: string[]): Promise<void> {
    const libraries = await this.prisma.mediaLibrary.findMany({
      where: { isEnabled: true },
      select: { id: true, path: true },
    });

    for (const dir of dirs) {
      // Only directories inside a library are our business; the file manager
      // spans every storage root, most of which hold no media.
      const owner = libraries.find((l) => dir === l.path || dir.startsWith(`${l.path}/`));
      if (!owner) continue;
      try {
        await this.scanner.scanLibrary(owner.id, undefined, dir);
      } catch (err) {
        this.logger.warn(`Follow-up scan of ${dir} failed: ${(err as Error).message}`);
      }
    }
  }

  @OnEvent(DOMAIN_EVENT_CHANNEL)
  async handle(envelope: DomainEventEnvelope): Promise<void> {
    try {
      const payload = (envelope.payload ?? {}) as Record<string, unknown>;

      if (envelope.eventKey === DOMAIN_EVENTS.FILE_MOVED) {
        const from = typeof payload.from === 'string' ? payload.from : null;
        const to = typeof payload.to === 'string' ? payload.to : null;
        if (from && to) {
          await this.relocation.recordMove(from, to);
          // Both ends: a file can leave one library folder and enter another.
          this.scheduleScan(from);
          this.scheduleScan(to);
        }
        return;
      }

      if (envelope.eventKey === DOMAIN_EVENTS.FILE_DELETED) {
        const path = typeof payload.path === 'string' ? payload.path : null;
        // Clears the item and everything beneath it for a folder. If the video
        // is gone the item is going regardless — withholding it would only
        // leave a window where the database described a file that is not there.
        if (path) {
          await this.relocation.recordDelete(path);
          this.scheduleScan(path);
        }
        return;
      }
    } catch (err) {
      // A subscriber must never throw at the bus: the file operation already
      // happened, and failing here would neither undo it nor help the caller.
      this.logger.error(`File-event bookkeeping failed: ${(err as Error).message}`);
    }
  }
}
