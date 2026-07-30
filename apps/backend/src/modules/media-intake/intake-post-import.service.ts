import { dirname } from 'node:path';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MediaScannerService } from '../media/media-scanner.service';
import { MediaMetadataService } from '../media/media-metadata.service';
import { MediaArtworkService } from '../media/media-artwork.service';
import { MediaSubtitleService } from '../media/media-subtitle.service';
import { MediaServerIntegrationService } from '../media/media-server-integration.service';
import { IntakePipelineService, type IntakeStage, type StageContext } from './intake-pipeline.service';

/**
 * The stages that run once the file is in a library.
 *
 * Every one of these needs a `MediaItem`, and an item only exists after a scan
 * has found the file — which is the whole reason enrichment follows the import
 * rather than preceding it.
 *
 * The scan is **scoped to the imported directory** via `scanLibrary`'s
 * `subPath`. Rescanning a whole library per import would make a batch of twenty
 * episodes twenty full sweeps of a 22 TB tree, which is the kind of cost that
 * gets a feature switched off rather than fixed.
 */
@Injectable()
export class IntakePostImportService implements OnModuleInit {
  private readonly logger = new Logger(IntakePostImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: IntakePipelineService,
    private readonly scanner: MediaScannerService,
    private readonly metadata: MediaMetadataService,
    private readonly artwork: MediaArtworkService,
    private readonly subtitles: MediaSubtitleService,
    private readonly integrations: MediaServerIntegrationService,
  ) {}

  onModuleInit(): void {
    this.pipeline.register(this.metadataStage());
    this.pipeline.register(this.artworkStage());
    this.pipeline.register(this.subtitleStage());
    this.pipeline.register(this.seedingStage());
  }

  /**
   * Make the item exist, then enrich it.
   *
   * Resolution is find-then-scan-then-find: the file may already have been
   * picked up by the periodic scanner between the import and this stage, and
   * scanning again would be work for nothing. Only when it is genuinely absent
   * is a scoped scan run.
   */
  private metadataStage(): IntakeStage {
    return {
      produces: 'metadata_ready',
      label: 'Fetch metadata',
      run: async (ctx: StageContext) => {
        const job = await this.prisma.mediaIntakeJob.findUnique({ where: { id: ctx.jobId } });
        if (!job?.importedPath || !job.libraryId) {
          return { quarantine: { reason: 'Nothing was recorded as imported' } };
        }

        let item = await this.prisma.mediaItem.findFirst({ where: { path: job.importedPath } });
        if (!item) {
          // Scoped to the imported folder — see the class comment.
          await this.scanner.scanLibrary(job.libraryId, undefined, dirname(job.importedPath));
          item = await this.prisma.mediaItem.findFirst({ where: { path: job.importedPath } });
        }
        if (!item) {
          /*
           * The file is on disk and the scanner did not take it. That is a
           * mismatch between what intake placed and what the library accepts —
           * an extension outside the library's filter, a permission problem —
           * and it needs a person, not a retry.
           */
          return {
            quarantine: {
              reason: `The file was placed at ${job.importedPath} but the library scan did not pick it up`,
            },
          };
        }

        await this.prisma.mediaIntakeJob.update({
          where: { id: ctx.jobId },
          data: { mediaItemId: item.id },
        });

        try {
          await this.metadata.fetchMetadata(item.id, {});
          return { message: `Metadata fetched for "${item.title}"`, data: { mediaItemId: item.id } };
        } catch (err) {
          // Enrichment is not the import. The file is already in the library and
          // usable; failing the intake here would suggest otherwise, and a
          // provider outage is not a reason to hold media back.
          return {
            message: `Imported; metadata unavailable: ${(err as Error).message}`,
            data: { mediaItemId: item.id, metadataFailed: true },
          };
        }
      },
    };
  }

  /** Artwork, best-effort for the same reason metadata is. */
  private artworkStage(): IntakeStage {
    return {
      produces: 'artwork_ready',
      label: 'Fetch artwork',
      run: async (ctx) => this.bestEffort(ctx, 'artwork', async (itemId) => {
        await this.artwork.importFromProvider(itemId, {});
      }),
    };
  }

  /** Subtitles, likewise. */
  private subtitleStage(): IntakeStage {
    return {
      produces: 'subtitle_ready',
      label: 'Scan subtitles',
      run: async (ctx) => this.bestEffort(ctx, 'subtitles', async (itemId) => {
        await this.subtitles.scan(itemId);
      }),
    };
  }

  /**
   * Tell the media server, and leave the torrent seeding.
   *
   * The notify is last because it is only worth doing once everything the
   * server would show — the file, its metadata, its artwork — is actually
   * there. Refreshing earlier means Plex indexes a bare file and the operator
   * sees an untitled entry appear and then change under them.
   */
  private seedingStage(): IntakeStage {
    return {
      produces: 'seeding',
      label: 'Notify media server',
      run: async () => {
        try {
          const result = await this.integrations.refreshAllEnabled({});
          return {
            message: `Refreshed ${result.refreshed} media server(s)`,
            data: { ...result },
          };
        } catch (err) {
          // The import succeeded whatever the media server says. A failed
          // refresh delays a library appearing; it does not undo anything.
          return { message: `Imported; media server refresh failed: ${(err as Error).message}` };
        }
      },
    };
  }

  /**
   * Run an enrichment step against the item, never failing the intake.
   *
   * The shared shape for artwork and subtitles: both are improvements to
   * something already imported and usable, so an outage records itself in the
   * timeline and the pipeline carries on.
   */
  private async bestEffort(
    ctx: StageContext,
    what: string,
    fn: (itemId: string) => Promise<void>,
  ) {
    const job = await this.prisma.mediaIntakeJob.findUnique({ where: { id: ctx.jobId } });
    if (!job?.mediaItemId) {
      return { message: `No item resolved; skipped ${what}` };
    }
    try {
      await fn(job.mediaItemId);
      return { message: `${what} complete` };
    } catch (err) {
      this.logger.debug(`${what} failed for ${job.mediaItemId}: ${(err as Error).message}`);
      return { message: `${what} unavailable: ${(err as Error).message}` };
    }
  }
}
