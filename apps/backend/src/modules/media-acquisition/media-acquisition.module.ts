import { Injectable, Logger, Module } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { EngineModule } from '../engine/engine.module';
import { MediaIntakeModule } from '../media-intake/media-intake.module';
import { IndexersModule } from '../indexers/indexers.module';
import { MEDIA_ACQUISITION_MODULE_ID } from './decision.engine';
import { MediaAcquisitionService } from './media-acquisition.service';
import { AcquisitionWatchlistService } from './watchlist.service';
import { ImdbSeriesResolver } from './imdb-series-resolver.service';
import { WantedSearchReconciler } from './wanted-search-reconciler.service';
import { AcquisitionProfileService } from './profile.service';
import { AcquisitionEvaluatorService } from './evaluator.service';
import { AcquisitionApprovalService } from './approval.service';
import { SmartDownloadExecutorService } from './smart-download-executor.service';
import { MissingEpisodesService } from './missing-episodes.service';
import { MissingMoviesService } from './missing-movies.service';
import { MissingEpisodeSearchService } from './missing-episode-search.service';
import { AcquisitionMatchPreferenceService } from './acquisition-match-preference.service';
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
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly missingSearch: MissingEpisodeSearchService,
    private readonly reconciler: WantedSearchReconciler,
  ) {}

  private get enabled(): boolean {
    return this.registry.getStatus(MEDIA_ACQUISITION_MODULE_ID)?.enabled ?? false;
  }

  @Interval('media_acquisition_rss_sweep', 5 * 60_000)
  rssSweep(): void { if (this.enabled) this.logger.debug('RSS acquisition sweep tick (operator-driven evaluation for now)'); }

  // The static 15-min tick drives the missing-episode auto-acquire sweep; the
  // operator's `searchIntervalMinutes` is enforced by the service's per-episode
  // lastSearchedAt backoff, and the sweep itself no-ops unless opted in.
  @Interval('media_acquisition_watchlist_sweep', 15 * 60_000)
  watchlistSweep(): void {
    if (!this.enabled) return;
    this.missingSearch.sweep().catch((err) =>
      this.logger.warn(`Missing-episode sweep failed: ${(err as Error).message}`),
    );
  }

  @Interval('media_acquisition_quality_upgrade_sweep', 30 * 60_000)
  upgradeSweep(): void { if (this.enabled) this.logger.debug('Quality upgrade sweep tick'); }

  /**
   * Retires grabs that are going nowhere — the torrent is parked with no seeders,
   * or is no longer in the client at all — so the episode rejoins the search pool
   * with that release remembered as dead.
   *
   * The reconciler runs this at boot too; on a timer it is what keeps a `grabbed`
   * row from being a dead end between deploys. Only the grab half is scheduled:
   * its sibling (releasing rows stuck in `searching`) is boot-only by design,
   * because mid-sweep rows are legitimately `searching`.
   */
  @Interval('media_acquisition_stuck_grab_sweep', 60 * 60_000)
  stuckGrabSweep(): void {
    if (!this.enabled) return;
    this.reconciler.releaseStuckGrabs().catch((err) =>
      this.logger.warn(`Stuck-grab reconcile failed: ${(err as Error).message}`),
    );
  }
}

/**
 * Media Acquisition Intelligence module. RBAC-gated. Reuses `parseTorrentName`
 * and the Release Scoring engine; never performs file operations (decisions +
 * recommendations only).
 */
@Module({
  imports: [IndexersModule, MediaIntakeModule, EngineModule],
  providers: [
    MediaAcquisitionService,
    ImdbSeriesResolver,
    WantedSearchReconciler,
    AcquisitionWatchlistService,
    AcquisitionProfileService,
    AcquisitionEvaluatorService,
    AcquisitionApprovalService,
    SmartDownloadExecutorService,
    MissingEpisodesService,
    MissingMoviesService,
    MissingEpisodeSearchService,
    AcquisitionMatchPreferenceService,
    MediaAcquisitionScheduler,
  ],
  controllers: [MediaAcquisitionController],
  exports: [MediaAcquisitionService, AcquisitionEvaluatorService],
})
export class MediaAcquisitionModule {}
