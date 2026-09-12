import { Module } from '@nestjs/common';

import { MediaDiscoveryModule } from '../media-discovery/media-discovery.module';
import { MediaAcquisitionModule } from '../media-acquisition/media-acquisition.module';
import { RssModule } from '../rss/rss.module';
import { SeriesAcquisitionProvisioningService } from './series-acquisition-provisioning.service';
import { SeriesBackfillService } from './series-backfill.service';
import { SeriesAcquisitionController } from './series-acquisition.controller';

/**
 * Add Series — the unified "I want this series" workflow.
 *
 * A composition layer, not a new subsystem. It imports the modules that already
 * own every piece (watchlist + rule + readiness + intake from Media Discovery,
 * missing-episode detection + the Smart-Download search/grab primitive from Media
 * Acquisition, airing status from RSS) and orchestrates them through one
 * idempotent provisioning path plus a managed back-catalogue platform job.
 *
 * This module is a leaf: nothing imports it, so composing Media Discovery (which
 * already depends on Media Acquisition) with Media Acquisition and RSS introduces
 * no dependency cycle. `JobRegistry`/`PlatformJobService` (global Jobs module),
 * `RealtimeGateway` and `AuditService` are globally provided.
 */
@Module({
  imports: [MediaDiscoveryModule, MediaAcquisitionModule, RssModule],
  controllers: [SeriesAcquisitionController],
  providers: [SeriesAcquisitionProvisioningService, SeriesBackfillService],
  exports: [SeriesAcquisitionProvisioningService, SeriesBackfillService],
})
export class SeriesAcquisitionModule {}
