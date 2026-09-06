import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { DiscoveryTemplate } from '@prisma/client';
import type { DiscoveryDecision } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { evaluateDiscovery, type PolicyTemplate, type PolicyVerdict } from './discovery-policy';
import { DiscoveryBudgetService } from './discovery-budget.service';
import { DiscoveryWatchlistService } from './discovery-watchlist.service';
import { DiscoveryRuleService } from './discovery-rule.service';
import { DiscoveryIntakeService } from './discovery-intake.service';

/**
 * The piece that runs the pipeline.
 *
 * Everything else in this module answers one question well; this one puts them
 * in order: evaluate each stored discovery against each enabled template, and —
 * only for `auto_monitor` — create the watchlist entry, generate the rule and
 * provision the directory. Every outcome is written to `DiscoveryEvaluation`
 * with the trace that produced it, so the Inbox can explain itself.
 *
 * The ordering is deliberate and the failure handling is the interesting part:
 *
 *  - **Watchlist first, rule second, directory third.** The watchlist entry is
 *    what actually causes acquisition — the existing sweeps monitor it. A rule
 *    carries preferences and a directory is a convenience, so a failure in
 *    either leaves a title that is still monitored, correctly, with a recorded
 *    reason rather than a silent gap.
 *  - **A failure is never silent.** `failureReason` goes on the evaluation and
 *    the title lands in the inbox as `needs_review`. A monitored title whose rule
 *    could not be built, with nothing anywhere saying so, is the outcome this is
 *    written to prevent.
 *  - **Budget is read once per template per run**, then decremented locally, so a
 *    single pass cannot exceed the allowance by racing itself.
 */

/** The ticker wakes hourly; a template is evaluated when its catalogue moved. */
const TICK_MS = 60 * 60_000;
/** Discoveries examined per template per run — a bounded unit of work. */
const MAX_PER_RUN = 500;

export interface EvaluationOutcome {
  templateId: string;
  templateName: string;
  examined: number;
  decisions: Record<DiscoveryDecision | 'not_applicable', number>;
  monitored: number;
  failed: number;
}

@Injectable()
export class DiscoveryEvaluationService {
  private readonly logger = new Logger(DiscoveryEvaluationService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly budget: DiscoveryBudgetService,
    private readonly watchlist: DiscoveryWatchlistService,
    private readonly rules: DiscoveryRuleService,
    private readonly intake: DiscoveryIntakeService,
  ) {}

  @Interval('media_discovery_evaluate', TICK_MS)
  async tick(): Promise<void> {
    try {
      await this.runAll();
    } catch (err) {
      // An unhandled rejection in an @Interval takes the interval down with it,
      // and the sweep then stops forever with nothing saying it has.
      this.logger.error(`Discovery evaluation tick failed: ${(err as Error).message}`);
    }
  }

  /** Every enabled template. Disabled ones are not evaluated at all. */
  async runAll(now = new Date()): Promise<EvaluationOutcome[]> {
    if (this.running) {
      this.logger.warn('Discovery evaluation already running — skipping this tick');
      return [];
    }
    this.running = true;
    try {
      const templates = await this.prisma.discoveryTemplate.findMany({ where: { enabled: true } });
      const out: EvaluationOutcome[] = [];
      for (const template of templates) out.push(await this.runTemplate(template, now));
      return out;
    } finally {
      this.running = false;
    }
  }

  async runTemplate(template: DiscoveryTemplate, now = new Date()): Promise<EvaluationOutcome> {
    const decisions: EvaluationOutcome['decisions'] = {
      auto_monitor: 0, notify: 0, ignore: 0, needs_review: 0, not_applicable: 0,
    };
    const outcome: EvaluationOutcome = {
      templateId: template.id,
      templateName: template.name,
      examined: 0,
      decisions,
      monitored: 0,
      failed: 0,
    };

    /*
     * Only titles this template has not already decided about.
     *
     * Re-deciding an ignored title on every tick would rewrite the same
     * evaluation hourly and bury the inbox in noise. A template EDIT is the thing
     * that should cause a re-run, and that is an explicit action rather than a
     * side effect of a sweep.
     */
    const rows = await this.prisma.discoveredMedia.findMany({
      where: { evaluations: { none: { templateId: template.id } } },
      include: { releaseDates: true },
      orderBy: { lastSeenAt: 'desc' },
      take: MAX_PER_RUN,
    });
    outcome.examined = rows.length;
    if (!rows.length) return outcome;

    // Read once, then spend locally: a single pass must not out-race its own cap.
    const budget = await this.budget.state(template.id, template, now);
    let remaining = Math.min(budget.remainingToday, budget.remainingThisWeek);

    const profile = template.storageProfileId
      ? await this.prisma.storageProfile.findUnique({
          where: { id: template.storageProfileId },
          include: { movieLibrary: true, tvLibrary: true },
        })
      : null;

    for (const row of rows) {
      const verdict = evaluateDiscovery(
        this.toPolicyMedia(row),
        template as unknown as PolicyTemplate,
        { now, autoAddBudgetExhausted: remaining <= 0 },
      );

      const key = verdict.applies ? verdict.decision : 'not_applicable';
      decisions[key] += 1;

      /*
       * A template with no opinion is RECORDED but does not touch the title.
       *
       * Skipping the write entirely was the first instinct and it starves the
       * sweep: the "already decided" filter is `evaluations: { none: … }`, so a
       * title with no row is re-fetched on every tick and consumes the page
       * budget forever. Measured — a second pass re-examined the same 500 rows,
       * 407 of them not applicable, and once a template accumulates a page's
       * worth of those, genuinely new titles are never reached at all.
       *
       * So the evaluation row is written (it is the audit trail, and it is what
       * makes progress measurable) while `DiscoveredMedia` is left alone — its
       * `discoveryStatus` stays `new` and it never appears in the inbox as though
       * this template had judged it.
       */
      if (!verdict.applies) {
        await this.record(row.id, template.id, verdict, {
          watchlistItemId: null,
          rssRuleId: null,
          failureReason: null,
        });
        continue;
      }

      const acted = verdict.decision === 'auto_monitor'
        ? await this.act(row, template, profile, verdict)
        : { watchlistItemId: null, rssRuleId: null, failureReason: null as string | null };

      if (verdict.decision === 'auto_monitor') {
        if (acted.watchlistItemId) {
          outcome.monitored += 1;
          remaining -= 1; // spent only when monitoring really happened
        } else {
          outcome.failed += 1;
        }
      }

      await this.record(row.id, template.id, verdict, acted);
      await this.prisma.discoveredMedia
        .update({
          where: { id: row.id },
          data: {
            decision: verdict.decision,
            decisionReason: acted.failureReason ?? verdict.reason,
            evaluatedAt: now,
            matchedTemplateId: template.id,
            discoveryStatus: this.statusFor(verdict.decision, acted),
            ...(acted.watchlistItemId ? { watchlistItemId: acted.watchlistItemId } : {}),
            ...(acted.rssRuleId ? { rssRuleId: acted.rssRuleId } : {}),
          },
        })
        .catch((err) => this.logger.warn(`Could not stamp ${row.id}: ${(err as Error).message}`));
    }

    return outcome;
  }

  /**
   * Perform an auto-monitor: watchlist, then rule, then directory.
   *
   * A rule or directory failure does NOT undo the watchlist entry. The entry is
   * what causes acquisition; the other two make it better. Rolling back a correct
   * entry because a convenience failed would be losing the useful half.
   */
  private async act(
    row: { id: string; title: string; year: number | null; mediaType: string; externalIds: unknown },
    template: DiscoveryTemplate,
    profile: {
      id: string;
      stagingRoot: string;
      movieLibraryId: string | null;
      tvLibraryId: string | null;
      movieLibrary: { path: string } | null;
      tvLibrary: { path: string } | null;
    } | null,
    _verdict: PolicyVerdict,
  ): Promise<{ watchlistItemId: string | null; rssRuleId: string | null; failureReason: string | null }> {
    const media = {
      id: row.id,
      title: row.title,
      year: row.year,
      mediaType: row.mediaType,
      externalIds: (row.externalIds ?? {}) as Record<string, string>,
    };
    const failures: string[] = [];

    let watchlistItemId: string | null = null;
    try {
      const link = await this.watchlist.linkOrCreate(media, {
        // The library the profile files THIS media type into, by id.
        targetLibraryId:
          row.mediaType === 'movie' ? profile?.movieLibraryId : profile?.tvLibraryId,
      });
      watchlistItemId = link.watchlistItemId;
      if (link.note) failures.push(link.note);
    } catch (err) {
      failures.push(`Watchlist entry failed: ${(err as Error).message}`);
      return { watchlistItemId: null, rssRuleId: null, failureReason: failures.join('; ') };
    }

    let rssRuleId: string | null = null;
    try {
      const acquisition = template.acquisitionTemplateId
        ? await this.prisma.acquisitionRuleTemplate.findUnique({
            where: { id: template.acquisitionTemplateId },
            include: { candidates: true },
          })
        : null;
      const generated = await this.rules.generate({ media, template, acquisition });
      rssRuleId = generated.ruleId;
      if (generated.reason) failures.push(generated.reason);
      // Attach the rule to the entry that was just created or reused.
      if (generated.ruleId) {
        await this.watchlist.linkOrCreate(media, { rssRuleId: generated.ruleId });
      }
    } catch (err) {
      failures.push(`Rule generation failed: ${(err as Error).message}`);
    }

    if (template.createIntakeDirectory && profile && template.pathTemplate) {
      try {
        const provisioned = await this.intake.provision({
          stagingRoot: profile.stagingRoot,
          pathTemplate: template.pathTemplate,
          tokens: {
            title: row.title,
            tvshow: row.mediaType === 'movie' ? null : row.title,
            movie: row.mediaType === 'movie' ? row.title : null,
            year: row.year,
          },
          libraryPaths: [profile.movieLibrary?.path, profile.tvLibrary?.path].filter(
            (p): p is string => Boolean(p),
          ),
        });
        if (!provisioned.ok) failures.push(`Intake directory: ${provisioned.detail}`);
      } catch (err) {
        failures.push(`Intake directory failed: ${(err as Error).message}`);
      }
    }

    return {
      watchlistItemId,
      rssRuleId,
      failureReason: failures.length ? failures.join('; ') : null,
    };
  }

  /** Where the title sits in the inbox afterwards. */
  private statusFor(
    decision: DiscoveryDecision,
    acted: { watchlistItemId: string | null },
  ): string {
    if (decision === 'auto_monitor') {
      // An auto-monitor that produced no entry is NOT monitored, whatever it
      // decided — it belongs in review, where somebody will see it.
      return acted.watchlistItemId ? 'monitored' : 'needs_review';
    }
    if (decision === 'notify') return 'notified';
    if (decision === 'needs_review') return 'needs_review';
    return 'ignored';
  }

  private async record(
    discoveredMediaId: string,
    templateId: string,
    verdict: PolicyVerdict,
    acted: { watchlistItemId: string | null; rssRuleId: string | null; failureReason: string | null },
  ): Promise<void> {
    try {
      await this.prisma.discoveryEvaluation.create({
        data: {
          discoveredMediaId,
          templateId,
          decision: verdict.decision,
          reason: acted.failureReason ?? verdict.reason,
          trace: verdict.trace as object,
          watchlistItemId: acted.watchlistItemId,
          rssRuleId: acted.rssRuleId,
          failureReason: acted.failureReason,
        },
      });
    } catch (err) {
      this.logger.warn(`Could not record evaluation for ${discoveredMediaId}: ${(err as Error).message}`);
    }
  }

  private toPolicyMedia(row: {
    mediaType: string; title: string; genres: string[]; originalLanguage: string | null;
    countries: string[]; network: string | null; streamingService: string | null; studio: string | null;
    popularity: number | null; rating: number | null; voteCount: number | null;
    identityStatus: string; confidence: number;
    releaseDates: Array<{ releaseType: string; date: Date | null; region: string | null }>;
  }) {
    return {
      mediaType: row.mediaType,
      title: row.title,
      genres: row.genres,
      originalLanguage: row.originalLanguage,
      countries: row.countries,
      network: row.network,
      streamingService: row.streamingService,
      studio: row.studio,
      popularity: row.popularity,
      rating: row.rating,
      voteCount: row.voteCount,
      identityStatus: row.identityStatus,
      confidence: row.confidence,
      releaseDates: row.releaseDates.map((d) => ({
        releaseType: d.releaseType,
        date: d.date ? d.date.toISOString().slice(0, 10) : null,
        region: d.region,
      })),
    };
  }
}
