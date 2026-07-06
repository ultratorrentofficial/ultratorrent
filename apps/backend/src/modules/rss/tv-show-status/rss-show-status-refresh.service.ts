import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Interval } from '@nestjs/schedule';
import { MODULE_IDS, WS_EVENTS } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { AuditService } from '../../audit/audit.service';
import { ModuleRegistryService } from '../../module-registry/module-registry.service';
import { AutomationEngine } from '../../automation/automation.module';
import { TvShowStatusService } from './tv-show-status.service';
import {
  isInactiveStatus,
  type NormalizedShowStatus,
  type ShowStatusResult,
} from './tv-show-status-provider';

/**
 * Per-status re-check cadence (ms). Active shows change soonest (a new episode
 * airs, a season is announced), so we poll them daily; ended/canceled shows
 * rarely change, so we poll them monthly to avoid wasting provider quota.
 */
const CADENCE_MS: Record<string, number> = {
  continuing: 24 * 60 * 60 * 1000,
  returning: 24 * 60 * 60 * 1000,
  planned: 24 * 60 * 60 * 1000,
  on_hiatus: 7 * 24 * 60 * 60 * 1000,
  ended: 30 * 24 * 60 * 60 * 1000,
  canceled: 30 * 24 * 60 * 60 * 1000,
  unknown: 3 * 24 * 60 * 60 * 1000,
};

/**
 * Background job that keeps cached TV-show statuses fresh and propagates any
 * change to the RSS rules that snapshot them. Re-resolves each cached show once
 * its per-status cadence has elapsed; on a status change it updates every rule
 * pointing at that show, emits a status-change event, and audits it. It NEVER
 * disables a rule — surfacing the change (and letting automation react) is the
 * user's decision, not the scheduler's.
 */
@Injectable()
export class RssShowStatusRefreshService {
  private readonly logger = new Logger(RssShowStatusRefreshService.name);
  private refreshing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly showStatus: TvShowStatusService,
    private readonly registry: ModuleRegistryService,
    private readonly realtime: RealtimeGateway,
    private readonly audit: AuditService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get enabled(): boolean {
    return this.registry.getStatus(MODULE_IDS.RSS)?.enabled ?? false;
  }

  /** Hourly tick — cheap when nothing is due (a single ordered query). */
  @Interval('rss_show_status_refresh', 60 * 60 * 1000)
  async tick(): Promise<void> {
    if (!this.enabled || this.refreshing) return;
    this.refreshing = true;
    try {
      await this.refreshDue();
    } catch (err) {
      this.logger.warn(`show-status refresh failed: ${(err as Error).message}`);
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Re-resolve cached statuses whose cadence has elapsed (oldest first, bounded
   * per run) and apply any change. Returns the number of shows whose normalized
   * status actually changed. Exposed for tests.
   */
  async refreshDue(now: Date = new Date(), limit = 100): Promise<number> {
    const rows = await this.prisma.tvShowStatus.findMany({
      orderBy: { checkedAt: 'asc' },
      take: 500,
    });
    const due = rows
      .filter((r) => this.isDue(r.normalizedStatus, r.checkedAt, now))
      .slice(0, limit);

    let changed = 0;
    for (const row of due) {
      const before = row.normalizedStatus as NormalizedShowStatus;
      let fresh: ShowStatusResult | null;
      try {
        fresh = await this.showStatus.resolveByProviderId(
          row.provider,
          row.providerShowId,
          true,
        );
      } catch (err) {
        this.logger.warn(
          `refresh of ${row.provider}:${row.providerShowId} failed: ${(err as Error).message}`,
        );
        continue;
      }
      if (!fresh) continue;
      if (fresh.normalizedStatus !== before) {
        changed++;
        await this.applyChange(row.provider, row.providerShowId, before, fresh);
      }
    }
    return changed;
  }

  /** True once `checkedAt` is older than the cadence for its status. */
  isDue(status: string, checkedAt: Date, now: Date): boolean {
    const cadence = CADENCE_MS[status] ?? CADENCE_MS.unknown;
    return now.getTime() - checkedAt.getTime() >= cadence;
  }

  /**
   * Propagate a confirmed status change: refresh every rule snapshotting this
   * show, broadcast the generic change event plus the specific transition, and
   * audit it. Best-effort — a broadcast/audit failure must not abort the run.
   */
  private async applyChange(
    provider: string,
    providerShowId: string,
    before: NormalizedShowStatus,
    fresh: ShowStatusResult,
  ): Promise<void> {
    const checkedAt = new Date();
    const affected = await this.prisma.rssRule.updateMany({
      where: {
        showStatusProvider: provider,
        showStatusProviderId: providerShowId,
      },
      data: {
        showStatus: fresh.normalizedStatus,
        showStatusRecommendation: fresh.recommendation,
        showStatusCheckedAt: checkedAt,
        showLastAirDate: this.toDate(fresh.lastAirDate),
        showNextEpisodeAirDate: this.toDate(fresh.nextEpisodeAirDate),
      },
    });

    const payload = {
      provider,
      providerShowId,
      title: fresh.title,
      from: before,
      to: fresh.normalizedStatus,
      recommendation: fresh.recommendation,
      rulesAffected: affected.count,
      at: checkedAt.toISOString(),
    };

    this.realtime.broadcast(WS_EVENTS.RSS_SHOW_STATUS_CHANGED, payload);
    this.fire('rss.show_status.changed', payload);
    if (fresh.normalizedStatus === 'ended') {
      this.realtime.broadcast(WS_EVENTS.RSS_SHOW_ENDED, payload);
      this.fire('rss.show.ended', payload);
    } else if (fresh.normalizedStatus === 'canceled') {
      this.realtime.broadcast(WS_EVENTS.RSS_SHOW_CANCELED, payload);
      this.fire('rss.show.canceled', payload);
    } else if (isInactiveStatus(before) && !isInactiveStatus(fresh.normalizedStatus)) {
      this.realtime.broadcast(WS_EVENTS.RSS_SHOW_BECAME_ACTIVE, payload);
      this.fire('rss.show.became_active', payload);
    }

    await this.audit.record({
      action: 'rss.show_status.changed',
      objectType: 'tv_show_status',
      objectId: `${provider}:${providerShowId}`,
      result: 'success',
      metadata: {
        title: fresh.title,
        from: before,
        to: fresh.normalizedStatus,
        rulesAffected: affected.count,
      },
    });

    this.logger.log(
      `show-status changed: "${fresh.title}" ${before} → ${fresh.normalizedStatus} (${affected.count} rule(s))`,
    );
  }

  /**
   * Fire an RSS automation trigger with the change payload as context.
   * Resolved lazily via ModuleRef (the engine depends on RSS, so a static inject
   * would cycle) and best-effort — automation must not disrupt the refresh loop.
   */
  private fire(trigger: string, context: Record<string, unknown>): void {
    try {
      this.moduleRef
        .get(AutomationEngine, { strict: false })
        .evaluateEvent(trigger, context)
        .catch((err: unknown) =>
          this.logger.warn(`automation ${trigger} failed: ${(err as Error).message}`),
        );
    } catch (err) {
      this.logger.warn(`automation ${trigger} unavailable: ${(err as Error).message}`);
    }
  }

  private toDate(iso: string | null): Date | null {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
}
