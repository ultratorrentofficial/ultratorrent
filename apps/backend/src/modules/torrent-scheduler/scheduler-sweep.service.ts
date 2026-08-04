import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { SchedulerPreviewService } from './scheduler-preview.service';
import { SchedulerReconciliationService } from './scheduler-reconciliation.service';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { DOMAIN_EVENTS } from '@ultratorrent/shared';

/** How often a plan is recalculated. Minutes, not seconds: nothing acts on it. */
const TICK_MS = 60_000;

/** Decisions older than this are pruned, so history cannot grow without bound. */
const RETENTION_DAYS = 14;

export type SchedulerMode = 'native' | 'observe' | 'managed';

/**
 * Recalculate each engine's plan on a timer and record what it would do.
 *
 * **An observing engine is never changed.** Reconciliation runs only for
 * `managed`, and reaching that mode requires the guarded activation flow — a
 * capability check, a preview of the exact torrents affected, and an explicit
 * confirmation. An engine in `observe` produces a plan and a record, and no
 * provider call whatsoever.
 *
 * Engines in `native` mode are skipped entirely. An installation that never opted
 * in does no scheduler work at all — not even planning — because planning that
 * nobody asked for still costs a query per engine per minute.
 */
@Injectable()
export class SchedulerSweepService {
  private readonly logger = new Logger(SchedulerSweepService.name);
  /** Claimed synchronously so a slow sweep cannot overlap the next tick. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly preview: SchedulerPreviewService,
    private readonly reconciliation: SchedulerReconciliationService,
    private readonly bus: DomainEventBus,
  ) {}

  @Interval('torrent_scheduler_sweep', TICK_MS)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sweep();
    } catch (err) {
      this.logger.warn(`Scheduler sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Modes by engine id. An engine with no row is `native`. */
  async modes(): Promise<Map<string, SchedulerMode>> {
    const rows = await this.prisma.torrentSchedulerEngineConfig.findMany();
    return new Map(rows.map((r) => [r.engineId, r.mode as SchedulerMode]));
  }

  private async sweep(): Promise<void> {
    const modes = await this.modes();
    // Read before writing, so a health change can be recognised as a CHANGE.
    // Publishing from the new value alone would announce "healthy" every minute.
    const priorHealth = new Map(
      (await this.prisma.torrentSchedulerEngineConfig.findMany({
        select: { engineId: true, healthState: true },
      })).map((r) => [r.engineId, r.healthState]),
    );
    const engines = this.registry
      .list()
      .filter((p) => (modes.get(p.engineId) ?? 'native') !== 'native');

    if (!engines.length) return; // nobody opted in; do nothing at all

    for (const provider of engines) {
      const engineId = provider.engineId;
      const mode = modes.get(engineId) ?? 'native';
      const started = Date.now();
      try {
        const plan = await this.preview.previewEngine(engineId);
        if (!plan) continue;

        const proposed = plan.decisions.filter((d) => d.action !== 'none').length;

        // The one line that separates observing from enforcing.
        let applied = 0;
        const limitations = [...plan.limitations];
        if (mode === 'managed') {
          const outcome = await this.reconciliation.apply(plan, this.registry.get(engineId));
          applied = outcome.applied;
          for (const l of outcome.limitations) {
            if (!limitations.some((x) => x.code === l.code)) limitations.push(l);
          }
          for (const f of outcome.failures) {
            this.bus.publish({
              eventKey: DOMAIN_EVENTS.TORRENT_SCHEDULER_ACTION_FAILED,
              resourceType: 'torrent',
              resourceId: f.hash,
              payload: { engineId, torrentHash: f.hash, action: f.action, error: f.error },
            });
          }
          if (outcome.failed || outcome.unverified) {
            this.logger.warn(
              `Scheduler applied ${outcome.applied}/${outcome.attempted} on ${engineId} `
                + `(${outcome.failed} failed, ${outcome.unverified} unconfirmed)`,
            );
          }
        }

        await this.prisma.torrentSchedulerDecision.create({
          data: {
            engineId,
            mode,
            summary: plan.summary as unknown as object,
            limitations: limitations.length ? (limitations as unknown as object) : undefined,
            proposedActions: proposed,
            // Zero while observing, and the gap between the two numbers is what
            // enforcement would change. Non-zero only once enforcement is on.
            appliedActions: applied,
            durationMs: Date.now() - started,
            result: 'ok',
          },
        });

        const healthState = limitations.length ? 'provider_limited' : 'healthy';
        await this.markSwept(engineId, {
          healthState,
          healthDetail: limitations.map((l) => l.code).join(',') || null,
          success: true,
        });
        this.announceHealth(engineId, healthState, priorHealth.get(engineId));

        // A seed that met its target is worth telling automation about once,
        // not every minute for as long as it stays complete. The catalogue's
        // dedupe window does that; this only has to publish honestly.
        for (const d of plan.decisions) {
          if (d.reasonCode !== 'seed_target_reached') continue;
          this.bus.publish({
            eventKey: DOMAIN_EVENTS.TORRENT_SCHEDULER_SEED_TARGET_REACHED,
            resourceType: 'torrent',
            resourceId: d.hash,
            payload: { engineId, torrentHash: d.hash, ratio: d.values?.ratio ?? null },
          });
        }
      } catch (err) {
        const message = (err as Error).message;
        this.logger.warn(`Scheduler sweep failed for ${engineId}: ${message}`);
        // One engine failing must not stop the others, and the failure is
        // recorded rather than leaving a stale "healthy" from the last success.
        await this.markSwept(engineId, {
          healthState: 'degraded',
          healthDetail: message.slice(0, 500),
          success: false,
        }).catch(() => undefined);
        this.announceHealth(engineId, 'degraded', priorHealth.get(engineId));
      }
    }

    await this.pruneHistory().catch((err) =>
      this.logger.debug(`Scheduler history prune failed: ${(err as Error).message}`),
    );
  }

  /**
   * Publish a health change, and only a change.
   *
   * The sweep runs every minute and re-derives the same health each time. An
   * event per tick would be noise an operator learns to ignore, which is worse
   * than no event at all — so the comparison against the previously STORED state
   * is what makes this an event rather than a heartbeat.
   */
  private announceHealth(engineId: string, next: string, previous: string | undefined): void {
    if (previous === next) return;
    this.bus.publish({
      eventKey: DOMAIN_EVENTS.TORRENT_SCHEDULER_HEALTH_CHANGED,
      resourceType: 'torrent_engine',
      resourceId: engineId,
      payload: { engineId, healthState: next, previousHealthState: previous ?? null },
    });
  }

  private async markSwept(
    engineId: string,
    opts: { healthState: string; healthDetail: string | null; success: boolean },
  ): Promise<void> {
    const now = new Date();
    await this.prisma.torrentSchedulerEngineConfig.upsert({
      where: { engineId },
      create: {
        engineId,
        // Reached only if a config row vanished mid-sweep; `native` is the safe
        // value to recreate with, never an enforcing mode.
        mode: 'native',
        lastSweepAt: now,
        lastSuccessfulSweepAt: opts.success ? now : null,
        healthState: opts.healthState,
        healthDetail: opts.healthDetail,
      },
      update: {
        lastSweepAt: now,
        ...(opts.success ? { lastSuccessfulSweepAt: now } : {}),
        healthState: opts.healthState,
        healthDetail: opts.healthDetail,
      },
    });
  }

  private async pruneHistory(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await this.prisma.torrentSchedulerDecision.deleteMany({
      where: { generatedAt: { lt: cutoff } },
    });
  }
}
