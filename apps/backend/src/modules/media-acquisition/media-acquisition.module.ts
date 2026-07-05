import { Injectable, Logger, Module } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { MEDIA_ACQUISITION_MODULE_ID } from './decision.engine';
import { MediaAcquisitionService } from './media-acquisition.service';
import { AcquisitionWatchlistService } from './watchlist.service';
import { AcquisitionProfileService } from './profile.service';
import { AcquisitionEvaluatorService } from './evaluator.service';
import { AcquisitionApprovalService } from './approval.service';
import { SmartDownloadExecutorService } from './smart-download-executor.service';
import { MissingEpisodesService } from './missing-episodes.service';
import { MediaAcquisitionController } from './media-acquisition.controller';

/**
 * Scheduler stubs for the acquisition sweeps. Each is a no-op unless the module
 * is enabled, so a disabled install pays nothing. They are the hook where
 * RSS/watchlist/upgrade sweeps will batch-evaluate candidates; evaluation is
 * operator-driven for now.
 */
@Injectable()
export class MediaAcquisitionScheduler {
  private readonly logger = new Logger(MediaAcquisitionScheduler.name);
  constructor(private readonly registry: ModuleRegistryService) {}

  private get enabled(): boolean {
    return this.registry.getStatus(MEDIA_ACQUISITION_MODULE_ID)?.enabled ?? false;
  }

  @Interval('media_acquisition_rss_sweep', 5 * 60_000)
  rssSweep(): void { if (this.enabled) this.logger.debug('RSS acquisition sweep tick (operator-driven evaluation for now)'); }

  @Interval('media_acquisition_watchlist_sweep', 15 * 60_000)
  watchlistSweep(): void { if (this.enabled) this.logger.debug('Watchlist acquisition sweep tick'); }

  @Interval('media_acquisition_quality_upgrade_sweep', 30 * 60_000)
  upgradeSweep(): void { if (this.enabled) this.logger.debug('Quality upgrade sweep tick'); }
}

/**
 * Media Acquisition Intelligence module. RBAC-gated. Reuses `parseTorrentName`
 * and the Release Scoring engine; never performs file operations (decisions +
 * recommendations only).
 */
@Module({
  providers: [
    MediaAcquisitionService,
    AcquisitionWatchlistService,
    AcquisitionProfileService,
    AcquisitionEvaluatorService,
    AcquisitionApprovalService,
    SmartDownloadExecutorService,
    MissingEpisodesService,
    MediaAcquisitionScheduler,
  ],
  controllers: [MediaAcquisitionController],
  exports: [MediaAcquisitionService, AcquisitionEvaluatorService],
})
export class MediaAcquisitionModule {}
