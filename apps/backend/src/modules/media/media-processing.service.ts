import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as path from 'node:path';
import type { MediaLibrary, Prisma } from '@prisma/client';
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

/** Outcome of a periodic scan + in-place enrichment of one library. */
export interface LibraryEnrichmentSummary {
  libraryId: string;
  /** Video files the scan reconciled into MediaItems. */
  scanned: number;
  /** Previously-unmatched items the enrichment could identify. */
  identified: number;
  /** Items that received provider metadata this pass. */
  metadataFetched: number;
  /** Items that received provider artwork this pass. */
  artworkFetched: number;
  /** Items considered for enrichment (needed identify/metadata/artwork). */
  processed: number;
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
   * Libraries whose post-download workflow is already in flight.
   *
   * The workflow scans the WHOLE library, so running it once per completed torrent
   * — concurrently — is pure waste: a scan already under way will see every file
   * that landed before it walks the tree. And the caller no longer awaits us, so
   * without this guard a *backlog* of completions all fire at once. That is not
   * hypothetical: after a sync outage left ~166 completions unrecorded, the first
   * healthy tick fired every one of them and launched **166 concurrent full library
   * scans**, which is what pinned a NAS at load 15.
   */
  private readonly workflowsInFlight = new Set<string>();

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
        if (this.workflowsInFlight.has(library.id)) {
          this.logger.debug(
            `Post-download workflow for "${library.name}" is already running — ` +
              `skipping a second pass for ${t.name}; the running scan will pick it up.`,
          );
          continue;
        }
        this.workflowsInFlight.add(library.id);
        try {
          await this.runWorkflow(library, t, path.resolve(savePath));
        } finally {
          this.workflowsInFlight.delete(library.id);
        }
      }
    } catch (err) {
      this.logger.warn(
        `Post-download workflow failed for ${t.name}: ${(err as Error).message}`,
      );
      this.emitEvent(NOTIFICATION_EVENTS.MEDIA_PROCESSING_FAILED, t, { errorMessage: (err as Error).message });
    }
  }

  /**
   * Scan a library and auto-populate metadata + artwork for the items that
   * still need it — the periodic-scan counterpart to {@link handleTorrentCompleted}.
   *
   * Two deliberate differences from the post-download workflow:
   *  - **No torrent context** — driven by the scheduler on a timer, so it fires
   *    no `media.*` automation triggers (those carry a torrent) and only emits
   *    the scan-completed event the scanner already raises.
   *  - **Never renames or moves files** — a routine scan should enrich what's on
   *    disk in place, not reorganise a user's folders behind their back. Renaming
   *    stays the job of the post-download organiser.
   *
   * Only *gaps* are filled: unmatched items are identified, and matched items get
   * metadata / a poster only if they lack them. So repeated scans converge and
   * don't re-hammer the providers. Best-effort — every stage is isolated and a
   * single item's failure never aborts the sweep. Never throws.
   */
  async processLibrary(libraryId: string): Promise<LibraryEnrichmentSummary> {
    const empty: LibraryEnrichmentSummary = { libraryId, scanned: 0, identified: 0, metadataFetched: 0, artworkFetched: 0, processed: 0 };
    const library = await this.prisma.mediaLibrary.findUnique({ where: { id: libraryId } });
    if (!library || !library.isEnabled) return empty;

    // Stage 1 — scan so new files on disk become MediaItems (also imports local
    // sidecar art + .nfo). Without a scan there is nothing to enrich.
    try {
      const summary = await this.queue.run('library_scan', { libraryId }, () =>
        this.scanner.scanLibrary(libraryId),
      );
      empty.scanned = summary.scanned;
    } catch (err) {
      this.logger.warn(`Periodic scan of ${library.name} failed: ${(err as Error).message}`);
      return empty;
    }

    // Enrichment targets: unmatched items (need identifying), or matched items
    // still missing metadata or a poster. Anything already enriched is skipped,
    // so a steady-state library does almost no work per pass.
    const or: Prisma.MediaItemWhereInput[] = [
      { matchStatus: 'unmatched' },
      { metadata: { is: null } },
    ];
    if (library.artworkEnabled) or.push({ artwork: { none: { type: 'poster' } } });
    const items = await this.prisma.mediaItem.findMany({
      where: { libraryId, OR: or },
      select: { id: true },
    });

    const result: LibraryEnrichmentSummary = { ...empty };
    for (const item of items) {
      const r = await this.enrichLibraryItem(library, item.id);
      if (r.identified) result.identified++;
      if (r.metadataFetched) result.metadataFetched++;
      if (r.artworkFetched) result.artworkFetched++;
      result.processed++;
    }
    return result;
  }

  /**
   * Enrich a single item in place: identify (if unmatched) → fetch metadata (if
   * missing) → fetch poster artwork (if missing and the library opts in). No
   * rename, no subtitle/NFO side effects — this only fills the gaps that power
   * the browse experience. Each stage is isolated; never throws.
   */
  private async enrichLibraryItem(
    library: MediaLibrary,
    itemId: string,
  ): Promise<{ identified: boolean; metadataFetched: boolean; artworkFetched: boolean }> {
    const out = { identified: false, metadataFetched: false, artworkFetched: false };

    const item = await this.prisma.mediaItem.findUnique({
      where: { id: itemId },
      select: {
        matchStatus: true,
        metadata: { select: { id: true } },
        artwork: { where: { type: 'poster' }, select: { id: true } },
      },
    });
    if (!item) return out;

    let matched = item.matchStatus === 'matched' || item.matchStatus === 'manual';

    // Identify unmatched items so we know what they are.
    if (!matched) {
      try {
        const identified = await this.queue.run('media_identification', { itemId }, () =>
          this.identification.identify(itemId),
        );
        matched = identified.matchStatus === 'matched' || identified.matchStatus === 'manual';
        out.identified = matched;
      } catch (err) {
        this.logger.warn(`Identify failed for ${itemId}: ${(err as Error).message}`);
      }
    }

    // Can't enrich something we couldn't name.
    if (!matched) return out;

    // Fill missing metadata (a freshly-identified item has none yet). Existing
    // metadata is left alone — periodic scan fills gaps, it doesn't re-fetch.
    if (!item.metadata) {
      try {
        await this.actions.execute('media_fetch_metadata', { itemId });
        out.metadataFetched = true;
      } catch (err) {
        this.logger.warn(`Metadata fetch failed for ${itemId}: ${(err as Error).message}`);
      }
    }

    // Fill a missing poster when the library opts into artwork.
    if (library.artworkEnabled && item.artwork.length === 0) {
      try {
        await this.actions.execute('media_fetch_artwork', { itemId });
        out.artworkFetched = true;
      } catch (err) {
        this.logger.warn(`Artwork fetch failed for ${itemId}: ${(err as Error).message}`);
      }
    }

    return out;
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
