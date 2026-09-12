import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  DiscoveryWatchlistService,
  type LinkableMedia,
} from '../media-discovery/discovery-watchlist.service';
import { DiscoveryRuleService } from '../media-discovery/discovery-rule.service';
import { DiscoveryTemplateService } from '../media-discovery/discovery-template.service';
import { DiscoveryIntakeService } from '../media-discovery/discovery-intake.service';
import { renderTargetPath, type PathTokens } from '../media-discovery/discovery-path';
import { MissingEpisodesService, type SeriesGap } from '../media-acquisition/missing-episodes.service';
import { TvShowStatusService } from '../rss/tv-show-status/tv-show-status.service';
import { isInactiveStatus, type NormalizedShowStatus } from '../rss/tv-show-status/tv-show-status-provider';
import { SeriesBackfillService } from './series-backfill.service';

/** What UltraTorrent should do when an operator says "I want this series". */
export type SeriesAcquisitionMode = 'backfill_and_monitor' | 'backfill_only' | 'monitor_new_only';

export const SERIES_ACQUISITION_MODES: SeriesAcquisitionMode[] = [
  'backfill_and_monitor',
  'backfill_only',
  'monitor_new_only',
];

export interface SeriesAcquisitionInput {
  /** Identity-first external ids (imdb/tmdb/tvdb/tvmaze/trakt). */
  externalIds?: Record<string, string>;
  title: string;
  year?: number | null;
  /** Defaults to `series`; this workflow is for episodic media. */
  mediaType?: string;
  mode: SeriesAcquisitionMode;
  /** Seasons to acquire; omit or empty = every season. */
  seasons?: number[];
  /** Explicit confirmation to monitor an ended/canceled show (audited). */
  allowInactiveShowMonitoring?: boolean;
  /** Pin a specific discovery template carrier; else the default enabled one. */
  templateId?: string | null;
  /** Override the storage profile's target library for this media type. */
  targetLibraryId?: string | null;
}

interface ResolvedContext {
  media: LinkableMedia;
  template: {
    id: string;
    name: string;
    acquisitionTemplateId: string | null;
    pathTemplate: string | null;
    storageProfileId: string | null;
    rssFeedId: string | null;
  } | null;
  profile: {
    id: string;
    stagingRoot: string;
    movieLibraryId: string | null;
    tvLibraryId: string | null;
    movieLibrary: { path: string } | null;
    tvLibrary: { path: string } | null;
  } | null;
  readiness: { ready: boolean; reason: string };
  existing: { id: string; status: string; rssRuleId: string | null } | null;
  showStatus: { normalizedStatus: NormalizedShowStatus; inactive: boolean } | null;
  requestedSeasons: number[] | null;
}

export interface SeriesAcquisitionPlan {
  mode: SeriesAcquisitionMode;
  media: { title: string; year: number | null; mediaType: string; externalIds: Record<string, string> };
  template: { id: string; name: string } | null;
  readiness: { ready: boolean; reason: string };
  existing: { watchlistItemId: string | null; status: string | null; rssRuleId: string | null };
  showStatus: { normalizedStatus: string; inactive: boolean } | null;
  requestedSeasons: number[] | null;
  /** This mode keeps the RSS rule enabled for new releases. */
  willMonitor: boolean;
  /** This mode enqueues a back-catalogue job. */
  willBackfill: boolean;
  /** Monitoring an ended/canceled show: needs `allowInactiveShowMonitoring`. */
  requiresInactiveConfirmation: boolean;
  /** Reasons provisioning would refuse right now (empty = ready to act). */
  blockers: string[];
  ready: boolean;
}

export interface SeriesAcquisitionResult {
  watchlistItemId: string;
  rssRuleId: string | null;
  ruleEnabled: boolean;
  alreadyExisted: boolean;
  scan: SeriesGap | null;
  excludedFromScope: number;
  backfillJobId: string | null;
  notes: string[];
}

/**
 * The single idempotent "Add Series" orchestration path.
 *
 * It provisions NOTHING itself — every piece is ensured through the existing
 * subsystem that owns it: the watchlist via {@link DiscoveryWatchlistService},
 * the RSS/acquisition rule via {@link DiscoveryRuleService} (whose readiness is
 * gated by {@link DiscoveryTemplateService.acquisitionReadiness}), the staging
 * directory via {@link DiscoveryIntakeService}, episode detection via
 * {@link MissingEpisodesService.scanSeries}, airing status via
 * {@link TvShowStatusService}, and the back-catalogue run via the managed
 * {@link SeriesBackfillService} platform job. The three modes are just three
 * combinations of {rule enabled, backfill enqueued, aired-missing in scope} over
 * those same subsystems — there is no second watchlist, evaluator or matcher.
 *
 * "Ensure" not "create again": asking twice links to what already exists rather
 * than duplicating it, so the operator can safely re-run to widen a scope or flip
 * a mode.
 */
@Injectable()
export class SeriesAcquisitionProvisioningService {
  private readonly logger = new Logger(SeriesAcquisitionProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly watchlist: DiscoveryWatchlistService,
    private readonly rules: DiscoveryRuleService,
    private readonly templates: DiscoveryTemplateService,
    private readonly intake: DiscoveryIntakeService,
    private readonly missingEpisodes: MissingEpisodesService,
    private readonly showStatus: TvShowStatusService,
    private readonly backfill: SeriesBackfillService,
    private readonly realtime: RealtimeGateway,
  ) {}

  // --- public API -----------------------------------------------------------

  /** Read-only preview of what provisioning would ensure. No writes. */
  async planSeriesAcquisition(
    input: SeriesAcquisitionInput,
    ctx: { userId?: string; ipAddress?: string; userAgent?: string } = {},
  ): Promise<SeriesAcquisitionPlan> {
    const resolved = await this.resolve(input, ctx);
    return this.toPlan(input, resolved);
  }

  /**
   * Ensure the full acquisition stack for a series. Idempotent. Throws only on a
   * hard blocker (no template, match preferences not ready, or an unconfirmed
   * ended show) — a convenience that fails (a directory, a rescan) is reported in
   * `notes`, never a reason to have done nothing.
   */
  async provisionSeriesAcquisition(
    input: SeriesAcquisitionInput,
    userId?: string,
    ctx: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<SeriesAcquisitionResult> {
    const resolved = await this.resolve(input, { userId, ...ctx });
    const plan = this.toPlan(input, resolved);

    // Hard gates.
    if (!resolved.template) {
      throw new BadRequestException(
        'No discovery template is configured with a feed and a storage profile, so there is nothing to build an acquisition rule from.',
      );
    }
    if (!resolved.readiness.ready) throw new BadRequestException(resolved.readiness.reason);
    if (plan.requiresInactiveConfirmation && !input.allowInactiveShowMonitoring) {
      throw new BadRequestException(
        `"${input.title}" has ended or been canceled. Confirm monitoring it for new releases (allowInactiveShowMonitoring) — there may be none.`,
      );
    }

    const { media, template, profile } = resolved;
    const notes: string[] = [];
    const willMonitor = plan.willMonitor;
    const willBackfill = plan.willBackfill;

    // 1. Watchlist entry (ensure).
    const link = await this.watchlist.linkOrCreate(
      media,
      {
        targetLibraryId: input.targetLibraryId ?? profile?.tvLibraryId,
        createSettings: {
          createdBySeriesAcquisition: true,
          seriesAcquisitionMode: input.mode,
          requestedSeasons: resolved.requestedSeasons,
        },
      },
      userId,
    );
    const watchlistItemId = link.watchlistItemId;
    const alreadyExisted = link.outcome !== 'created';
    if (link.note) notes.push(link.note);

    // 2. Save path + rule (ensure), mirroring DiscoveryEvaluationService.act().
    const pathTokens: PathTokens = {
      title: media.title,
      tvshow: media.title,
      movie: null,
      year: media.year,
    };
    const libraryPaths = [profile?.movieLibrary?.path, profile?.tvLibrary?.path].filter(
      (p): p is string => Boolean(p),
    );
    let savePath: string | null = null;
    if (profile && template.pathTemplate) {
      try {
        savePath = renderTargetPath({
          stagingRoot: profile.stagingRoot,
          pathTemplate: template.pathTemplate,
          tokens: pathTokens,
          libraryPaths,
        });
      } catch (err) {
        notes.push(`Target path could not be built: ${(err as Error).message}`);
      }
    }

    let rssRuleId: string | null = null;
    try {
      const acquisition = template.acquisitionTemplateId
        ? await this.prisma.acquisitionRuleTemplate.findUnique({
            where: { id: template.acquisitionTemplateId },
            include: { candidates: true },
          })
        : null;
      const generated = await this.rules.generate(
        { media, template: { id: template.id, rssFeedId: template.rssFeedId, storageProfileId: template.storageProfileId }, acquisition, savePath },
        userId,
      );
      rssRuleId = generated.ruleId;
      if (generated.reason) notes.push(generated.reason);
      if (generated.ruleId) {
        await this.watchlist.linkOrCreate(media, { rssRuleId: generated.ruleId }, userId);
      }
    } catch (err) {
      notes.push(`Rule generation failed: ${(err as Error).message}`);
    }

    // 3. Intake directory (ensure).
    if (savePath && profile && template.pathTemplate) {
      try {
        const provisioned = await this.intake.provision({
          stagingRoot: profile.stagingRoot,
          pathTemplate: template.pathTemplate,
          tokens: pathTokens,
          libraryPaths,
        });
        if (!provisioned.ok) notes.push(`Intake directory: ${provisioned.detail}`);
      } catch (err) {
        notes.push(`Intake directory failed: ${(err as Error).message}`);
      }
    }

    // 4. Mode → rule enablement. Only a rule that is still ours to touch (generated
    //    by automation and never hand-edited) is flipped; an operator's own rule is
    //    left exactly as they set it. When the operator confirmed monitoring an
    //    ended/canceled show, the rule also carries `allowInactiveShowMonitoring` so
    //    the RSS sweep does not skip it for being inactive — generate() never sets it.
    const allowInactive = plan.requiresInactiveConfirmation && Boolean(input.allowInactiveShowMonitoring);
    let ruleEnabled = willMonitor;
    if (rssRuleId) {
      const { count } = await this.prisma.rssRule.updateMany({
        where: { id: rssRuleId, generatedByDiscovery: true, userModifiedAt: null },
        data: { isEnabled: willMonitor, ...(allowInactive ? { allowInactiveShowMonitoring: true } : {}) },
      });
      if (!count) {
        const current = await this.prisma.rssRule.findUnique({
          where: { id: rssRuleId },
          select: { isEnabled: true },
        });
        ruleEnabled = current?.isEnabled ?? willMonitor;
        notes.push('Existing hand-edited rule left as the operator set it.');
      }
    }

    // 5. Missing-episode detection (reuse scanSeries). Safe to run unconditionally:
    //    scanSeries fetches the aired boundary when the year check is ambiguous and
    //    classifies not-yet-aired episodes as `unaired`, not `missing`, so an early
    //    or upcoming season is never written as a false gap. A series with no
    //    resolvable IMDb id simply cannot be scanned — an ordinary outcome, noted.
    let scan: SeriesGap | null = null;
    try {
      scan = await this.missingEpisodes.scanSeries(watchlistItemId, userId);
    } catch (err) {
      notes.push(`Episode scan skipped: ${(err as Error).message}`);
    }

    // 6. Season scope + "monitor new only": mark out-of-scope episodes NOT WANTED
    //    (distinct from missing) so neither the sweep nor the backfill fetches them.
    const excludedFromScope = await this.applyScope(
      watchlistItemId,
      input.mode,
      resolved.requestedSeasons,
    );

    // 7. Back-catalogue job (backfill modes only).
    let backfillJobId: string | null = null;
    if (willBackfill && scan && scan.missing > 0) {
      try {
        const { jobId } = await this.backfill.enqueue(
          {
            watchlistItemId,
            seriesTconst: scan.seriesTconst,
            title: media.title,
            seasons: resolved.requestedSeasons,
          },
          userId,
        );
        backfillJobId = jobId;
      } catch (err) {
        notes.push(`Backfill could not start: ${(err as Error).message}`);
      }
    }

    await this.audit.record({
      userId,
      ...ctx,
      action: 'media_acquisition.series.provisioned',
      objectType: 'media_acquisition_watchlist',
      objectId: watchlistItemId,
      metadata: {
        title: media.year ? `${media.title} (${media.year})` : media.title,
        mode: input.mode,
        alreadyExisted,
        templateName: template.name,
        ruleEnabled,
        missing: scan?.missing ?? null,
        excludedFromScope,
        backfillJobId,
        inactiveShowOverride: Boolean(plan.requiresInactiveConfirmation && input.allowInactiveShowMonitoring),
      },
    });

    this.realtime.broadcast('media_acquisition.series.provisioned', {
      watchlistItemId,
      mode: input.mode,
      ruleEnabled,
      missing: scan?.missing ?? 0,
      backfillJobId,
    });

    this.logger.log(
      `Add Series "${media.title}" (${input.mode}): rule ${rssRuleId ?? 'none'} ${ruleEnabled ? 'enabled' : 'disabled'}, ` +
        `${scan?.missing ?? 0} missing, ${excludedFromScope} out-of-scope, backfill ${backfillJobId ?? 'none'}`,
    );

    return {
      watchlistItemId,
      rssRuleId,
      ruleEnabled,
      alreadyExisted,
      scan,
      excludedFromScope,
      backfillJobId,
      notes,
    };
  }

  // --- resolution (shared by plan + provision) ------------------------------

  private async resolve(
    input: SeriesAcquisitionInput,
    ctx: { userId?: string; ipAddress?: string; userAgent?: string },
  ): Promise<ResolvedContext> {
    const mediaType = input.mediaType ?? 'series';
    const media: LinkableMedia = {
      id: `series-acq:${input.externalIds?.imdb ?? input.externalIds?.tmdb ?? input.title}`,
      mediaType,
      title: input.title,
      year: input.year ?? null,
      externalIds: input.externalIds ?? {},
    };

    const template = input.templateId
      ? await this.prisma.discoveryTemplate.findUnique({ where: { id: input.templateId } })
      : await this.prisma.discoveryTemplate.findFirst({
          where: { enabled: true, rssFeedId: { not: null }, storageProfileId: { not: null } },
          orderBy: { createdAt: 'asc' },
        });

    const readiness = template
      ? await this.templates.acquisitionReadiness(template.acquisitionTemplateId)
      : { ready: false, reason: 'No discovery template with a feed and a storage profile is configured.' };

    const profile = template?.storageProfileId
      ? await this.prisma.storageProfile.findUnique({
          where: { id: template.storageProfileId },
          include: { movieLibrary: true, tvLibrary: true },
        })
      : null;

    const existing = await this.watchlist.resolveExisting(media);

    let showStatus: ResolvedContext['showStatus'] = null;
    try {
      const result = await this.showStatus.lookup(
        { title: input.title, year: input.year ?? null },
        { userId: ctx.userId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
      );
      showStatus = {
        normalizedStatus: result.normalizedStatus,
        inactive: isInactiveStatus(result.normalizedStatus),
      };
    } catch (err) {
      this.logger.debug(`Show-status lookup failed for "${input.title}": ${(err as Error).message}`);
    }

    return {
      media,
      template: template
        ? {
            id: template.id,
            name: template.name,
            acquisitionTemplateId: template.acquisitionTemplateId,
            pathTemplate: template.pathTemplate,
            storageProfileId: template.storageProfileId,
            rssFeedId: template.rssFeedId,
          }
        : null,
      profile: profile
        ? {
            id: profile.id,
            stagingRoot: profile.stagingRoot,
            movieLibraryId: profile.movieLibraryId,
            tvLibraryId: profile.tvLibraryId,
            movieLibrary: profile.movieLibrary ? { path: profile.movieLibrary.path } : null,
            tvLibrary: profile.tvLibrary ? { path: profile.tvLibrary.path } : null,
          }
        : null,
      readiness,
      existing,
      showStatus,
      requestedSeasons: input.seasons && input.seasons.length ? [...new Set(input.seasons)].sort((a, b) => a - b) : null,
    };
  }

  private toPlan(input: SeriesAcquisitionInput, r: ResolvedContext): SeriesAcquisitionPlan {
    const willMonitor = input.mode !== 'backfill_only';
    const willBackfill = input.mode !== 'monitor_new_only';
    const inactive = r.showStatus?.inactive ?? false;
    const requiresInactiveConfirmation = willMonitor && inactive;

    const blockers: string[] = [];
    if (!r.template) blockers.push('No discovery template with a feed and a storage profile is configured.');
    else if (!r.readiness.ready) blockers.push(r.readiness.reason);
    if (requiresInactiveConfirmation && !input.allowInactiveShowMonitoring) {
      blockers.push(
        `"${input.title}" has ended or been canceled — confirm monitoring for new releases before proceeding.`,
      );
    }

    return {
      mode: input.mode,
      media: { title: r.media.title, year: r.media.year, mediaType: r.media.mediaType, externalIds: r.media.externalIds },
      template: r.template ? { id: r.template.id, name: r.template.name } : null,
      readiness: r.readiness,
      existing: {
        watchlistItemId: r.existing?.id ?? null,
        status: r.existing?.status ?? null,
        rssRuleId: r.existing?.rssRuleId ?? null,
      },
      showStatus: r.showStatus
        ? { normalizedStatus: r.showStatus.normalizedStatus, inactive: r.showStatus.inactive }
        : null,
      requestedSeasons: r.requestedSeasons,
      willMonitor,
      willBackfill,
      requiresInactiveConfirmation,
      blockers,
      ready: blockers.length === 0,
    };
  }

  /**
   * Mark the episodes the operator did NOT ask for as out-of-scope (not wanted),
   * and re-include the ones they did — so a re-run that widens the scope flips the
   * flag back. Returns how many rows ended up excluded.
   *
   *  - A requested-season list excludes every episode outside it.
   *  - `monitor_new_only` additionally excludes every already-aired (`missing`)
   *    episode: only genuinely new releases, arriving via the RSS rule, are wanted.
   *
   * `ignored` rows (an explicit operator override) are never touched.
   */
  private async applyScope(
    watchlistItemId: string,
    mode: SeriesAcquisitionMode,
    requestedSeasons: number[] | null,
  ): Promise<number> {
    if (requestedSeasons) {
      await this.prisma.wantedEpisode.updateMany({
        where: { watchlistItemId, status: { not: 'ignored' }, seasonNumber: { notIn: requestedSeasons } },
        data: { excludedFromScope: true },
      });
      await this.prisma.wantedEpisode.updateMany({
        where: { watchlistItemId, status: { not: 'ignored' }, seasonNumber: { in: requestedSeasons } },
        data: { excludedFromScope: false },
      });
    } else {
      // No season filter: start from "everything in scope", then let the mode rule
      // below narrow it. This also re-includes episodes a prior narrower run excluded.
      await this.prisma.wantedEpisode.updateMany({
        where: { watchlistItemId, status: { not: 'ignored' } },
        data: { excludedFromScope: false },
      });
    }

    if (mode === 'monitor_new_only') {
      await this.prisma.wantedEpisode.updateMany({
        where: { watchlistItemId, status: 'missing' },
        data: { excludedFromScope: true },
      });
    }

    return this.prisma.wantedEpisode.count({ where: { watchlistItemId, excludedFromScope: true } });
  }
}
