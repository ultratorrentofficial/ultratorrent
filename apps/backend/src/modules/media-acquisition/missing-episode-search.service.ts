import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { WantedEpisode } from '@prisma/client';
import { NOTIFICATION_BUS_CHANNEL, NOTIFICATION_EVENTS } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { IndexerService } from '../indexers/indexer.service';
import { AcquisitionEvaluatorService } from './evaluator.service';
import { AcquisitionMatchPreferenceService } from './acquisition-match-preference.service';
import { MediaAcquisitionService } from './media-acquisition.service';
import { MEDIA_ACQUISITION_MODULE_ID } from './decision.engine';

type WantedSearchStatus = 'idle' | 'searching' | 'grabbed' | 'pending_approval' | 'no_results' | 'failed';

export interface EpisodeSearchOutcome {
  wantedEpisodeId: string;
  searchStatus: WantedSearchStatus;
  releaseTitle?: string;
  evaluationId?: string;
}

/**
 * The missing-episode auto-acquire bridge: for each `missing` WantedEpisode it
 * searches the configured Torznab/Newznab indexers and picks a release using the
 * **auto-download match preferences** ({@link AcquisitionMatchPreferenceService})
 * — the same ranked candidate + quality + **size-cap** model RSS rules use — then
 * grabs the winner via {@link AcquisitionEvaluatorService.grabSelected}. Nothing
 * matches the preferences → `no_results`. Grab-state is written back onto the
 * WantedEpisode (and preserved across rescans).
 *
 * The scheduled `sweep()` is opt-in (`settings.autoSearchMissing`, default OFF);
 * the manual triggers run whenever the module is enabled.
 */
@Injectable()
export class MissingEpisodeSearchService {
  private readonly logger = new Logger(MissingEpisodeSearchService.name);
  private searching = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexers: IndexerService,
    private readonly evaluator: AcquisitionEvaluatorService,
    private readonly matchPrefs: AcquisitionMatchPreferenceService,
    private readonly acquisition: MediaAcquisitionService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly eventBus: EventEmitter2,
    private readonly registry: ModuleRegistryService,
  ) {}

  private get enabled(): boolean {
    return this.registry.getStatus(MEDIA_ACQUISITION_MODULE_ID)?.enabled ?? false;
  }

  /**
   * Scheduled sweep. No-op unless the module is enabled AND the operator opted in
   * (`autoSearchMissing`). Re-entrancy guarded; processes a bounded, oldest-first
   * batch and applies a per-episode backoff so it doesn't hammer indexers.
   */
  async sweep(): Promise<{ scanned: number; grabbed: number; pendingApproval: number; noResults: number } | null> {
    if (!this.enabled || this.searching) return null;
    const settings = await this.acquisition.getSettings();
    if (!settings.autoSearchMissing) return null;

    this.searching = true;
    try {
      const cutoff = new Date(Date.now() - (settings.searchIntervalMinutes ?? 60) * 60_000);
      const rows = await this.prisma.wantedEpisode.findMany({
        where: {
          status: 'missing',
          OR: [
            { searchStatus: 'idle' },
            { searchStatus: { in: ['no_results', 'failed'] }, lastSearchedAt: { lt: cutoff } },
            { searchStatus: { in: ['no_results', 'failed'] }, lastSearchedAt: null },
          ],
        },
        orderBy: { lastSearchedAt: { sort: 'asc', nulls: 'first' } },
        take: settings.maxSearchesPerSweep ?? 50,
      });

      const summary = { scanned: 0, grabbed: 0, pendingApproval: 0, noResults: 0 };
      for (const row of rows) {
        try {
          const outcome = await this.processEpisode(row, settings.missingSearchProfileId);
          summary.scanned += 1;
          if (outcome.searchStatus === 'grabbed') summary.grabbed += 1;
          else if (outcome.searchStatus === 'pending_approval') summary.pendingApproval += 1;
          else summary.noResults += 1;
        } catch (err) {
          this.logger.warn(`Search failed for wanted episode ${row.id}: ${(err as Error).message}`);
          await this.setState(row.id, { searchStatus: 'failed', lastSearchedAt: new Date() });
        }
      }
      if (summary.scanned) {
        this.logger.log(`Missing-episode sweep: ${summary.scanned} searched, ${summary.grabbed} grabbed, ${summary.pendingApproval} pending approval`);
      }
      return summary;
    } finally {
      this.searching = false;
    }
  }

  /** Manual: search one wanted episode now (bypasses the autoSearchMissing gate). */
  async searchEpisode(wantedEpisodeId: string, userId?: string): Promise<EpisodeSearchOutcome> {
    if (!this.enabled) throw new BadRequestException('Media Acquisition module is disabled');
    const row = await this.prisma.wantedEpisode.findUnique({ where: { id: wantedEpisodeId } });
    if (!row) throw new NotFoundException('Wanted episode not found');
    if (row.status !== 'missing') throw new BadRequestException(`Episode is "${row.status}", not missing`);
    const settings = await this.acquisition.getSettings();
    return this.processEpisode(row, settings.missingSearchProfileId, userId);
  }

  /** Manual: search every missing episode of one monitored series now. */
  async searchSeries(watchlistItemId: string, userId?: string): Promise<{ results: EpisodeSearchOutcome[] }> {
    if (!this.enabled) throw new BadRequestException('Media Acquisition module is disabled');
    const settings = await this.acquisition.getSettings();
    const rows = await this.prisma.wantedEpisode.findMany({
      where: { watchlistItemId, status: 'missing' },
      orderBy: [{ seasonNumber: 'asc' }, { episodeNumber: 'asc' }],
    });
    const results: EpisodeSearchOutcome[] = [];
    for (const row of rows) {
      try {
        results.push(await this.processEpisode(row, settings.missingSearchProfileId, userId));
      } catch (err) {
        this.logger.warn(`Search failed for wanted episode ${row.id}: ${(err as Error).message}`);
        await this.setState(row.id, { searchStatus: 'failed', lastSearchedAt: new Date() });
        results.push({ wantedEpisodeId: row.id, searchStatus: 'failed' });
      }
    }
    return { results };
  }

  // --- core -----------------------------------------------------------------

  private async processEpisode(
    wanted: WantedEpisode,
    _settingsProfileId: string | null,
    userId?: string,
  ): Promise<EpisodeSearchOutcome> {
    await this.setState(wanted.id, { searchStatus: 'searching' });

    const item = await this.prisma.mediaAcquisitionWatchlistItem.findUnique({
      where: { id: wanted.watchlistItemId },
    });
    if (!item) throw new NotFoundException('Watchlist item not found');

    // Download directory comes from the Show Rule (the RSS rule that is the parent
    // of this show's match candidates), so grabbed episodes land in the same folder
    // the show's RSS rule uses — not the engine's default /downloads.
    const savePath = await this.resolveSavePath(item.rssRuleId);

    const candidates = await this.indexers.searchAll({
      q: item.title,
      season: wanted.seasonNumber,
      ep: wanted.episodeNumber,
    });
    // Match preferences (ranked candidate list + quality + size cap) decide which
    // release to grab — a quality profile is no longer consulted here.
    const prefs = await this.matchPrefs.resolveCandidates(item);
    const best = this.matchPrefs.select(candidates, prefs, item.title, wanted.seasonNumber, wanted.episodeNumber);

    if (!best) {
      // Nothing matched the preferences (e.g. everything over the size cap).
      await this.setState(wanted.id, { searchStatus: 'no_results', lastSearchedAt: new Date() });
      return { wantedEpisodeId: wanted.id, searchStatus: 'no_results' };
    }

    const rel = best.candidate;
    const evaluation = await this.evaluator.grabSelected(
      {
        releaseName: rel.title,
        downloadUrl: rel.downloadUrl ?? undefined,
        sizeBytes: rel.sizeBytes ?? undefined,
        seeders: rel.seeders ?? undefined,
        watchlistItemId: item.id,
        sourceType: 'missing_episode_sweep',
        sourceId: wanted.id,
        priority: item.priority,
        reason: best.reason,
        savePath,
      },
      userId,
    );

    const now = new Date();
    await this.setState(wanted.id, {
      searchStatus: 'grabbed',
      lastSearchedAt: now,
      grabbedAt: now,
      grabbedEvaluationId: evaluation.id,
      downloadUrl: rel.downloadUrl,
      releaseTitle: rel.title,
    });
    this.emitGrabbed(wanted, rel.title, evaluation.id);
    await this.audit.record({
      userId,
      action: 'media_acquisition.missing_episode.grabbed',
      objectType: 'wanted_episode',
      objectId: wanted.id,
      metadata: { releaseTitle: rel.title, evaluationId: evaluation.id, via: 'match_preferences' },
    });
    return { wantedEpisodeId: wanted.id, searchStatus: 'grabbed', releaseTitle: rel.title, evaluationId: evaluation.id };
  }

  /**
   * The download directory for a grabbed episode: the parent Show Rule's
   * `savePath`. Returns undefined when the show isn't linked to an RSS rule or the
   * rule has no save path set, letting the torrent engine use its own default.
   */
  private async resolveSavePath(rssRuleId: string | null): Promise<string | undefined> {
    if (!rssRuleId) return undefined;
    const rule = await this.prisma.rssRule.findUnique({
      where: { id: rssRuleId },
      select: { savePath: true },
    });
    return rule?.savePath?.trim() || undefined;
  }

  private setState(id: string, data: Partial<WantedEpisode>): Promise<unknown> {
    return this.prisma.wantedEpisode.update({ where: { id }, data });
  }

  private emitGrabbed(wanted: WantedEpisode, releaseTitle: string, evaluationId: string): void {
    const payload = {
      watchlistItemId: wanted.watchlistItemId,
      seriesTconst: wanted.seriesTconst,
      seasonNumber: wanted.seasonNumber,
      episodeNumber: wanted.episodeNumber,
      releaseTitle,
      evaluationId,
    };
    this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, {
      event: NOTIFICATION_EVENTS.MEDIA_MISSING_EPISODE_FILLED,
      payload,
      at: new Date().toISOString(),
    });
    this.realtime.broadcast('media_acquisition.missing_episode.grabbed', payload);
  }
}
