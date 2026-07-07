import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as path from 'node:path';
import type { MediaLibrary } from '@prisma/client';
import { NOTIFICATION_BUS_CHANNEL, NOTIFICATION_EVENTS, type NormalizedTorrent } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AutomationEngine } from '../automation/automation.module';
import { MediaScannerService } from './media-scanner.service';
import { MediaIdentificationService } from './media-identification.service';
import { MediaSubtitleService } from './media-subtitle.service';
import { MediaServerIntegrationService } from './media-server-integration.service';
import { MediaAutomationActions } from './media-automation.actions';
import { MediaProcessingQueueService } from './media-processing-queue.service';

/** True when `child` is `parent` or lives beneath it (both pre-resolved). */
export function isWithin(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

/**
 * Post-download Media Manager workflow. On `torrent.completed`, if a completed
 * torrent's savePath falls inside an opted-in MediaLibrary, it runs a best-effort
 * pipeline — scan → identify → (matched) rename/move per library.mode → metadata
 * → artwork → NFO → media-server refresh — recording each stage as a
 * MediaProcessingJob (WS progress) and firing the corresponding `media.*`
 * automation triggers. Every stage is isolated: one failure never aborts the rest.
 *
 * OPT-IN by design: only libraries whose path contains the savePath are eligible,
 * so arbitrary downloads are never auto-organised.
 */
@Injectable()
export class MediaProcessingService {
  private readonly logger = new Logger(MediaProcessingService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Lazily resolved (see below) to break the MediaModule ⇄ AutomationModule
    // cycle: AutomationModule imports MediaService/MediaAutomationActions from
    // here, so AutomationEngine can't be a construction-time dependency.
    private readonly moduleRef: ModuleRef,
    private readonly scanner: MediaScannerService,
    private readonly identification: MediaIdentificationService,
    private readonly subtitles: MediaSubtitleService,
    private readonly integrations: MediaServerIntegrationService,
    private readonly actions: MediaAutomationActions,
    private readonly queue: MediaProcessingQueueService,
    private readonly eventBus: EventEmitter2,
  ) {}

  /** Publish a domain event onto the Notification Center bus (fire-and-forget). */
  private emitEvent(event: string, t: NormalizedTorrent, extra: Record<string, unknown> = {}): void {
    this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, {
      event,
      payload: { torrentName: t.name, mediaTitle: t.name, hash: t.hash, ...extra },
      at: new Date().toISOString(),
    });
  }

  /** Fire a `media.*` automation trigger with the torrent as context (best-effort). */
  private fire(trigger: string, t: NormalizedTorrent): void {
    this.moduleRef
      .get(AutomationEngine, { strict: false })
      .evaluate(trigger, t)
      .catch((err) =>
        this.logger.warn(`Automation ${trigger} failed: ${(err as Error).message}`),
      );
  }

  /**
   * Entry point wired from torrent completion detection. Never throws — a failure
   * here must not disrupt the sync loop.
   */
  async handleTorrentCompleted(t: NormalizedTorrent): Promise<void> {
    try {
      const savePath = t.savePath;
      if (!savePath) return;

      const libraries = await this.prisma.mediaLibrary.findMany({
        where: { isEnabled: true },
      });
      // Opt-in: only libraries whose root contains the download.
      const covering = libraries.filter((l) => isWithin(savePath, l.path));
      if (covering.length === 0) return;

      for (const library of covering) {
        await this.runWorkflow(library, t, path.resolve(savePath));
      }
    } catch (err) {
      this.logger.warn(
        `Post-download workflow failed for ${t.name}: ${(err as Error).message}`,
      );
      this.emitEvent(NOTIFICATION_EVENTS.MEDIA_PROCESSING_FAILED, t, { errorMessage: (err as Error).message });
    }
  }

  private async runWorkflow(
    library: MediaLibrary,
    t: NormalizedTorrent,
    resolvedSave: string,
  ): Promise<void> {
    // Stage 1 — scan the library so freshly-downloaded files become MediaItems.
    try {
      await this.queue.run('library_scan', { libraryId: library.id }, () =>
        this.scanner.scanLibrary(library.id),
      );
      this.fire('media.detected', t);
    } catch (err) {
      this.logger.warn(`Scan stage failed: ${(err as Error).message}`);
      return; // nothing to process without a scan
    }

    // Only act on items that came from this download.
    const items = await this.prisma.mediaItem.findMany({
      where: { libraryId: library.id },
      select: { id: true, path: true },
    });
    const fromDownload = items.filter((i) => isWithin(i.path, resolvedSave));

    for (const item of fromDownload) {
      await this.processItem(library, item.id, t);
    }

    // Stage 6 — refresh any configured media servers so they pick up new files.
    await this.refreshServers(t);
    this.emitEvent(NOTIFICATION_EVENTS.MEDIA_PROCESSING_COMPLETED, t, { libraryName: library.name, itemCount: fromDownload.length });
  }

  /** Best-effort per-item enrichment pipeline. Each stage is isolated. */
  private async processItem(
    library: MediaLibrary,
    itemId: string,
    t: NormalizedTorrent,
  ): Promise<void> {
    // Stage 2 — identify.
    let matched = false;
    try {
      const identified = await this.queue.run(
        'media_identification',
        { itemId },
        () => this.identification.identify(itemId),
      );
      matched =
        identified.matchStatus === 'matched' ||
        identified.matchStatus === 'manual';
      this.fire(matched ? 'media.matched' : 'media.unmatched', t);
      if (!matched) this.emitEvent(NOTIFICATION_EVENTS.MEDIA_METADATA_MATCH_FAILED, t, { itemId, libraryName: library.name });
    } catch (err) {
      this.logger.warn(`Identify failed for ${itemId}: ${(err as Error).message}`);
    }

    // Unmatched items stop here — we never reorganise something we can't name.
    if (!matched) return;

    // Stage 3 — metadata, fetched *before* the rename so the new filename can
    // draw on the fullest identity we have (episode title, canonical series
    // title, year) rather than whatever the raw filename happened to carry.
    try {
      await this.actions.execute('media_fetch_metadata', { itemId });
    } catch (err) {
      this.logger.warn(`Metadata failed for ${itemId}: ${(err as Error).message}`);
    }

    // Stage 4 — rename/move into the library structure per its mode.
    try {
      await this.actions.execute('media_rename', { itemId });
      this.fire('media.rename_completed', t);
      this.emitEvent(NOTIFICATION_EVENTS.MEDIA_RENAMED, t, { itemId, libraryName: library.name });
    } catch (err) {
      this.logger.warn(`Rename failed for ${itemId}: ${(err as Error).message}`);
    }

    // Stage 5a — artwork (when the library wants it).
    if (library.artworkEnabled) {
      try {
        const art = (await this.actions.execute('media_fetch_artwork', {
          itemId,
        })) as { missing?: string[] };
        if (art?.missing && art.missing.length > 0) {
          this.fire('media.missing_artwork', t);
          this.emitEvent(NOTIFICATION_EVENTS.MEDIA_MISSING_ARTWORK, t, { itemId, missing: art.missing });
        }
      } catch (err) {
        this.logger.warn(`Artwork failed for ${itemId}: ${(err as Error).message}`);
      }
    }

    // Stage 5b — subtitle sidecar scan.
    try {
      await this.queue.run('subtitle_scan', { itemId }, () =>
        this.subtitles.scan(itemId),
      );
      const subs = await this.subtitles.detectMissing(itemId);
      if (subs.missing.length > 0) {
        this.fire('media.missing_subtitles', t);
        this.emitEvent(NOTIFICATION_EVENTS.MEDIA_MISSING_SUBTITLES, t, { itemId, missing: subs.missing });
      }
    } catch (err) {
      this.logger.warn(`Subtitle scan failed for ${itemId}: ${(err as Error).message}`);
    }

    // Stage 5c — NFO (when the library enables it).
    if (library.nfoEnabled) {
      try {
        await this.actions.execute('media_generate_nfo', { itemId });
      } catch (err) {
        this.logger.warn(`NFO failed for ${itemId}: ${(err as Error).message}`);
      }
    }
  }

  /** Refresh every enabled media-server integration; audit + trigger on failure. */
  private async refreshServers(t: NormalizedTorrent): Promise<void> {
    const enabled = await this.prisma.mediaServerIntegration.findMany({
      where: { isEnabled: true },
      select: { id: true },
    });
    for (const integration of enabled) {
      try {
        await this.actions.execute('media_server_refresh', {
          integrationId: integration.id,
        });
      } catch (err) {
        this.logger.warn(
          `Media-server refresh failed for ${integration.id}: ${(err as Error).message}`,
        );
        this.fire('media.server_refresh_failed', t);
      }
    }
  }
}
