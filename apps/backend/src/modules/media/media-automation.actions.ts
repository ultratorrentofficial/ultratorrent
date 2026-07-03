import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MediaScannerService } from './media-scanner.service';
import { MediaIdentificationService } from './media-identification.service';
import { MediaMetadataService, type AuditContext } from './media-metadata.service';
import { MediaArtworkService } from './media-artwork.service';
import { MediaNfoService } from './media-nfo.service';
import { MediaServerIntegrationService } from './media-server-integration.service';
import { MediaService } from './media.service';
import { MediaProcessingQueueService } from './media-processing-queue.service';
import type { Preset, RenameMode } from './media-renamer';

/**
 * Executes the Media Manager automation actions dispatched by the AutomationEngine.
 * Each action delegates to the corresponding Media Manager service — filesystem
 * work stays constrained by FilePathService and audited by those services — and
 * long-running operations are tracked as MediaProcessingJob rows with WS progress
 * via {@link MediaProcessingQueueService}.
 *
 * Kept free of any AutomationEngine dependency so the engine can inject it without
 * a circular reference (the engine depends on this; this depends on media only).
 */
@Injectable()
export class MediaAutomationActions {
  private readonly logger = new Logger(MediaAutomationActions.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scanner: MediaScannerService,
    private readonly identification: MediaIdentificationService,
    private readonly metadata: MediaMetadataService,
    private readonly artwork: MediaArtworkService,
    private readonly nfo: MediaNfoService,
    private readonly integrations: MediaServerIntegrationService,
    private readonly media: MediaService,
    private readonly queue: MediaProcessingQueueService,
  ) {}

  /** Dispatch a `media_*` automation action by type. */
  async execute(
    type: string,
    params: Record<string, unknown> = {},
    ctx: AuditContext = {},
  ): Promise<unknown> {
    const libraryId = params.libraryId ? String(params.libraryId) : undefined;
    const itemId = params.itemId ? String(params.itemId) : undefined;

    switch (type) {
      case 'media_scan_library': {
        if (!libraryId) throw new BadRequestException('libraryId is required');
        return this.queue.run('library_scan', { libraryId }, () =>
          this.scanner.scanLibrary(libraryId),
        );
      }
      case 'media_match': {
        if (!itemId) throw new BadRequestException('itemId is required');
        return this.queue.run('media_identification', { itemId }, () =>
          this.identification.identify(itemId),
        );
      }
      case 'media_fetch_metadata': {
        if (!itemId) throw new BadRequestException('itemId is required');
        return this.queue.run('metadata_fetch', { itemId }, () =>
          this.metadata.fetchMetadata(itemId, ctx),
        );
      }
      case 'media_fetch_artwork': {
        if (!itemId) throw new BadRequestException('itemId is required');
        // No online artwork provider is configured in core — report the gap so a
        // downstream rule / operator can act (upload / select).
        return this.queue.run('artwork_fetch', { itemId }, () =>
          this.artwork.detectMissing(itemId),
        );
      }
      case 'media_generate_nfo': {
        if (!itemId && !libraryId) {
          throw new BadRequestException('itemId or libraryId is required');
        }
        return this.queue.run(
          'nfo_generate',
          { itemId, libraryId },
          () => this.nfo.generate({ itemId, libraryId }, ctx),
        );
      }
      case 'media_rename': {
        return this.renameOrMove({ itemId, libraryId }, undefined, ctx);
      }
      case 'media_move': {
        // Force a move into the library structure regardless of the library's
        // default (preview/hardlink/etc.) mode.
        return this.renameOrMove({ itemId, libraryId }, 'rename_move', ctx);
      }
      case 'media_server_refresh': {
        const integrationId = params.integrationId
          ? String(params.integrationId)
          : undefined;
        if (!integrationId) {
          throw new BadRequestException('integrationId is required');
        }
        return this.queue.run(
          'media_server_refresh',
          { payload: { integrationId } },
          () => this.integrations.refresh(integrationId, ctx),
        );
      }
      default:
        throw new BadRequestException(`Unknown media action: ${type}`);
    }
  }

  /**
   * Rename/move an item — or every item in a library — into the library
   * structure using the core renamer (root-guarded + audited by MediaService).
   */
  private async renameOrMove(
    target: { itemId?: string; libraryId?: string },
    modeOverride: RenameMode | undefined,
    ctx: AuditContext,
  ): Promise<unknown> {
    if (target.itemId) {
      return this.queue.run(
        'rename_execute',
        { itemId: target.itemId },
        () => this.renameItem(target.itemId!, modeOverride, ctx),
      );
    }
    if (target.libraryId) {
      return this.queue.run(
        'rename_execute',
        { libraryId: target.libraryId },
        async (report) => {
          const items = await this.prisma.mediaItem.findMany({
            where: { libraryId: target.libraryId },
            select: { id: true },
          });
          let applied = 0;
          let failed = 0;
          for (let i = 0; i < items.length; i++) {
            try {
              await this.renameItem(items[i].id, modeOverride, ctx);
              applied++;
            } catch (err) {
              failed++;
              this.logger.warn(
                `Rename failed for item ${items[i].id}: ${(err as Error).message}`,
              );
            }
            if (items.length) await report(((i + 1) / items.length) * 100);
          }
          return { items: items.length, applied, failed };
        },
      );
    }
    throw new BadRequestException('itemId or libraryId is required');
  }

  /** Build a RenameRequest for one item from its library config and apply it. */
  async renameItem(
    itemId: string,
    modeOverride: RenameMode | undefined,
    ctx: AuditContext = {},
  ) {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: itemId },
      include: { library: true, files: true },
    });
    if (!item) throw new BadRequestException('Item not found');
    if (!item.library) throw new BadRequestException('Item has no library');

    const src = item.files[0]?.path ?? item.path;
    return this.media.apply({
      path: src,
      preset: (item.library.preset ?? 'plex') as Preset,
      mode: (modeOverride ?? item.library.mode ?? 'hardlink') as RenameMode,
      libraryPath: item.library.path,
      template: item.library.template ?? undefined,
    });
  }
}
