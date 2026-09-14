import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { IndexerService } from '../indexers/indexer.service';
import type { IndexerCandidate } from '../indexers/torznab-client';
import { normalize } from '../rss/match-engine';
import { AcquisitionEvaluatorService } from './evaluator.service';
import { AcquisitionMatchPreferenceService } from './acquisition-match-preference.service';
import { MissingEpisodeSearchService } from './missing-episode-search.service';
import { MediaAcquisitionService } from './media-acquisition.service';

const GB = 1024 * 1024 * 1024;

/** The watchlist fields a pack grab needs (a subset of the row). */
export interface PackItem {
  id: string;
  title: string;
  titleAliases?: string[] | null;
  year: number | null;
  rssRuleId: string | null;
  targetLibraryId: string | null;
  libraryShowId?: string | null;
  priority?: number | null;
}

export interface PackBackfillConfig {
  enabled: boolean;
  seriesPacks: boolean;
  seasonMissingThreshold: number;
  wholeSeriesForSeriesPack: boolean;
  maxSeasonPackGb: number;
  maxSeriesPackGb: number;
}

export interface PackResult {
  grabbed: boolean;
  releaseTitle?: string;
  covered: number;
  reason?: string;
}

/**
 * Pack-aware backfill: when a whole season (or the whole series) is missing, search
 * for and grab ONE season/series pack instead of per-episode searches that cannot
 * match a pack listing. It reuses the same indexer search, match-preference quality
 * rules (via {@link AcquisitionMatchPreferenceService.selectPack}), grab path
 * ({@link AcquisitionEvaluatorService.grabSelected}) and save-path resolution
 * ({@link MissingEpisodeSearchService.resolveShowSavePath}) as the episode bridge —
 * Media Intake then fans the pack out to the individual episodes. No pack found →
 * the caller falls back to per-episode search.
 */
@Injectable()
export class PackAcquisitionService {
  private readonly logger = new Logger(PackAcquisitionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexers: IndexerService,
    private readonly evaluator: AcquisitionEvaluatorService,
    private readonly matchPrefs: AcquisitionMatchPreferenceService,
    private readonly search: MissingEpisodeSearchService,
    private readonly acquisition: MediaAcquisitionService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async config(): Promise<PackBackfillConfig> {
    const s = (await this.acquisition.getSettings()) as { packBackfill?: Partial<PackBackfillConfig> };
    const p = s.packBackfill ?? {};
    return {
      enabled: p.enabled ?? true,
      seriesPacks: p.seriesPacks ?? true,
      seasonMissingThreshold: typeof p.seasonMissingThreshold === 'number' ? p.seasonMissingThreshold : 1.0,
      wholeSeriesForSeriesPack: p.wholeSeriesForSeriesPack ?? true,
      maxSeasonPackGb: typeof p.maxSeasonPackGb === 'number' ? p.maxSeasonPackGb : 30,
      maxSeriesPackGb: typeof p.maxSeriesPackGb === 'number' ? p.maxSeriesPackGb : 150,
    };
  }

  /** Try to grab a SEASON pack that covers the given missing episodes of one season. */
  async trySeasonPack(item: PackItem, seriesTconst: string | null, season: number, coveredEpisodeIds: string[], userId?: string): Promise<PackResult> {
    const cfg = await this.config();
    if (!cfg.enabled) return { grabbed: false, covered: 0, reason: 'disabled' };
    return this.tryPack(item, seriesTconst, { type: 'season', season }, coveredEpisodeIds, cfg.maxSeasonPackGb, this.seasonQueries(item, season), userId);
  }

  /** Try to grab a COMPLETE-SERIES pack that covers every needed season. */
  async trySeriesPack(item: PackItem, seriesTconst: string | null, neededSeasons: number[], coveredEpisodeIds: string[], userId?: string): Promise<PackResult> {
    const cfg = await this.config();
    if (!cfg.enabled || !cfg.seriesPacks) return { grabbed: false, covered: 0, reason: 'disabled' };
    return this.tryPack(item, seriesTconst, { type: 'series', seasons: neededSeasons }, coveredEpisodeIds, cfg.maxSeriesPackGb, this.seriesQueries(item, neededSeasons), userId);
  }

  // --- core -----------------------------------------------------------------

  private async tryPack(
    item: PackItem,
    seriesTconst: string | null,
    target: { type: 'season'; season: number } | { type: 'series'; seasons: number[] },
    coveredEpisodeIds: string[],
    maxGb: number,
    queries: { q: string; season?: number }[],
    userId?: string,
  ): Promise<PackResult> {
    if (coveredEpisodeIds.length === 0) return { grabbed: false, covered: 0, reason: 'nothing_to_cover' };

    // The pack must land in the show's folder — refuse rather than scatter it loose.
    const { path: savePath, intakeRuleId, intakeProfileId } = await this.search.resolveShowSavePath(item, seriesTconst);
    if (!savePath) {
      this.logger.warn(`No save path for "${item.title}" ${this.label(target)} pack — refusing to grab.`);
      return { grabbed: false, covered: 0, reason: 'no_save_path' };
    }

    const candidates = await this.searchPacks(queries);
    if (candidates.length === 0) {
      await this.recordNoResults(item, target, userId);
      return { grabbed: false, covered: 0, reason: 'no_candidates' };
    }

    const prefs = await this.matchPrefs.resolveCandidates(item as never);
    const best = this.matchPrefs.selectPack(candidates, prefs, item.title, target, maxGb * GB, item.titleAliases ?? []);
    if (!best) {
      await this.recordNoResults(item, target, userId);
      return { grabbed: false, covered: 0, reason: 'no_match' };
    }

    const rel = best.candidate;
    const { evaluation, torrentHash } = await this.evaluator.grabSelected(
      {
        releaseName: rel.title,
        downloadUrl: rel.downloadUrl ?? undefined,
        sizeBytes: rel.sizeBytes ?? undefined,
        seeders: rel.seeders ?? undefined,
        watchlistItemId: item.id,
        sourceType: target.type === 'season' ? 'season_pack_backfill' : 'series_pack_backfill',
        sourceId: `${item.id}:${this.label(target)}`,
        priority: item.priority ?? 100,
        reason: best.reason,
        savePath,
        intakeProfileId,
      },
      userId,
    );

    if (!torrentHash) {
      this.logger.warn(`Pack grab for "${item.title}" ${this.label(target)} ("${rel.title}") added no torrent.`);
      return { grabbed: false, covered: 0, reason: 'grab_failed' };
    }

    // Mark the covered episodes grabbed-via-pack so the per-episode sweep/backfill
    // skips them. They stay `status:'missing'` until intake imports the pack's files
    // and a rescan flips them to `owned`.
    const now = new Date();
    await this.prisma.wantedEpisode.updateMany({
      where: { id: { in: coveredEpisodeIds } },
      data: {
        searchStatus: 'grabbed',
        lastSearchedAt: now,
        grabbedAt: now,
        grabbedEvaluationId: evaluation.id,
        downloadUrl: rel.downloadUrl,
        releaseTitle: rel.title,
        torrentHash,
        intakeRuleId,
      },
    });

    this.realtime.broadcast('media_acquisition.pack.grabbed', {
      watchlistItemId: item.id,
      packType: target.type,
      releaseTitle: rel.title,
      covered: coveredEpisodeIds.length,
    });
    await this.audit.record({
      userId,
      action: 'media_acquisition.pack.grabbed',
      objectType: 'media_acquisition_watchlist',
      objectId: item.id,
      metadata: { packType: target.type, releaseTitle: rel.title, covered: coveredEpisodeIds.length, evaluationId: evaluation.id },
    });
    this.logger.log(`Grabbed ${this.label(target)} pack for "${item.title}": "${rel.title}" (covers ${coveredEpisodeIds.length} episode(s)).`);
    return { grabbed: true, releaseTitle: rel.title, covered: coveredEpisodeIds.length };
  }

  /** Run the widening pack queries until one returns candidates (stop on an outage). */
  private async searchPacks(queries: { q: string; season?: number }[]): Promise<IndexerCandidate[]> {
    for (const query of queries) {
      const run = await this.indexers.searchAllDetailed({ q: query.q, season: query.season });
      if (run.queried > 0 && run.failed === run.queried) return []; // total outage — do not widen
      if (run.candidates.length) return run.candidates;
      if (run.failed > 0) return []; // partial failure: an empty answer is not evidence to widen
    }
    return [];
  }

  private seasonQueries(item: PackItem, season: number): { q: string; season?: number }[] {
    const titles = [item.title, ...(item.titleAliases ?? [])].filter(Boolean) as string[];
    const ss = String(season).padStart(2, '0');
    const out: { q: string; season?: number }[] = [];
    const push = (q: string) => {
      const v = q.trim();
      if (v && !out.some((x) => x.q.toLowerCase() === v.toLowerCase())) out.push({ q: v, season });
    };
    for (const t of titles) push(`${t} S${ss}`);
    for (const t of titles) push(`${t} Season ${season}`);
    for (const t of titles) push(`${normalize(t)} S${ss}`);
    return out;
  }

  private seriesQueries(item: PackItem, neededSeasons: number[]): { q: string; season?: number }[] {
    const titles = [item.title, ...(item.titleAliases ?? [])].filter(Boolean) as string[];
    const maxS = Math.max(...neededSeasons, 1);
    const out: { q: string; season?: number }[] = [];
    const push = (q: string) => {
      const v = q.trim();
      if (v && !out.some((x) => x.q.toLowerCase() === v.toLowerCase())) out.push({ q: v });
    };
    for (const t of titles) push(`${t} Complete Series`);
    for (const t of titles) push(`${t} Complete`);
    for (const t of titles) push(`${t} S01-S${String(maxS).padStart(2, '0')}`);
    return out;
  }

  private label(target: { type: 'season'; season: number } | { type: 'series'; seasons: number[] }): string {
    return target.type === 'season' ? `s${target.season}` : 'series';
  }

  private async recordNoResults(item: PackItem, target: { type: string }, userId?: string): Promise<void> {
    await this.audit.record({
      userId,
      action: 'media_acquisition.pack.no_results',
      objectType: 'media_acquisition_watchlist',
      objectId: item.id,
      metadata: { packType: target.type, title: item.title },
    });
  }
}
