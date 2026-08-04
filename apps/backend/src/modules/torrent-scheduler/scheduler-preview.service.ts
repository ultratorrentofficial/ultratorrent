import { Injectable, Logger } from '@nestjs/common';
import { TorrentState } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { SchedulerCapabilityService } from './scheduler-capability.service';
import { classify } from './domain/classification';
import { scoreTorrent } from './domain/priority';
import { planEngine, type PlannerTorrent, type EngineActivityPlan } from './domain/planner';
import {
  resolveEffectivePolicy,
  type TorrentSchedulingPolicy,
  type SchedulingPolicyScopeType,
} from './domain/policy';

/**
 * Build the plan for an engine, without touching anything.
 *
 * Reads the persisted `TorrentSnapshot` rows that `TorrentSyncService` already
 * maintains rather than polling the engine again: the snapshot is the normalized
 * state the rest of the application trusts, and a second poll would both add
 * load and let the preview disagree with what every other screen shows.
 *
 * This is the whole of Observe Only. The same function backs the enforced plan
 * later, so what an operator validates here is what enforcement would do — a
 * preview computed by a different code path would be a guess about the real one.
 */
@Injectable()
export class SchedulerPreviewService {
  private readonly logger = new Logger(SchedulerPreviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly capabilities: SchedulerCapabilityService,
  ) {}

  /** Policies as the pure resolver wants them. */
  private async loadPolicies(): Promise<TorrentSchedulingPolicy[]> {
    const rows = await this.prisma.torrentSchedulerPolicy.findMany({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      scope: { type: r.scopeType as SchedulingPolicyScopeType, id: r.scopeId },
      // A NULL column is "explicitly unlimited"; the resolver needs `undefined`
      // to mean inherit, and Prisma gives null for both. A column that was never
      // set is indistinguishable from one set to unlimited at the storage layer,
      // so the presence of the ROW at a scope is what makes it a decision.
      maxConcurrentDownloads: r.maxConcurrentDownloads,
      maxConcurrentSeeds: r.maxConcurrentSeeds,
      maxTotalActive: r.maxTotalActive,
      maxDownloadRateKbps: r.maxDownloadRateKbps,
      maxUploadRateKbps: r.maxUploadRateKbps,
      reserveDownloadBandwidthPercent: r.reserveDownloadBandwidthPercent ?? undefined,
      reserveSeedBandwidthPercent: r.reserveSeedBandwidthPercent ?? undefined,
      seedPolicy: (r.seedPolicy as unknown as TorrentSchedulingPolicy['seedPolicy']) ?? undefined,
    }));
  }

  /**
   * Plan one engine from its current snapshots.
   *
   * Returns null when the engine is unknown to the registry — an engine that
   * cannot be resolved has no capabilities, and planning against
   * `UNKNOWN_QUEUE_CAPABILITIES` would produce a page of "cannot pause" noise
   * rather than an answer.
   */
  async previewEngine(engineId: string, now = new Date()): Promise<EngineActivityPlan | null> {
    let kind;
    try {
      kind = this.registry.get(engineId).kind;
    } catch {
      return null;
    }
    const caps = this.capabilities.for(kind);

    const [snapshots, policies, parked] = await Promise.all([
      this.prisma.torrentSnapshot.findMany({ where: { engineId } }),
      this.loadPolicies(),
      this.prisma.parkedTorrent.findMany({ where: { engineId }, select: { hash: true } }),
    ]);
    // Parking owns these torrents; the scheduler must not contend for them.
    const parkedHashes = new Set(parked.map((p) => p.hash.toLowerCase()));

    const torrents: PlannerTorrent[] = snapshots.map((s) => {
      const complete = s.progress >= 1;
      const classification = classify(
        {
          state: s.state as TorrentState,
          progress: s.progress,
          downloadRate: s.downloadRate,
          uploadRate: s.uploadRate,
          parked: parkedHashes.has(s.hash.toLowerCase()),
          // Phase 3 has no scheduler-owned pause state, because nothing has ever
          // paused anything. Every pause therefore reads as "not ours", which is
          // the safe reading: the planner will not resume it.
        },
        caps,
      );

      const policy = resolveEffectivePolicy(policies, {
        torrentHash: s.hash,
        engineId,
        categoryId: s.categoryId,
      });

      return {
        hash: s.hash,
        engineId,
        occupancy: classification.occupancy,
        complete,
        addedAt: s.addedAt,
        policy,
        decision: scoreTorrent({
          torrentHash: s.hash,
          progress: s.progress,
          ageMinutes: s.addedAt ? (now.getTime() - s.addedAt.getTime()) / 60_000 : undefined,
        }),
      };
    });

    return planEngine(engineId, torrents, caps, { now });
  }

  /** Plan every engine the registry knows about. */
  async previewAll(now = new Date()): Promise<EngineActivityPlan[]> {
    const plans: EngineActivityPlan[] = [];
    for (const provider of this.registry.list()) {
      try {
        const plan = await this.previewEngine(provider.engineId, now);
        if (plan) plans.push(plan);
      } catch (err) {
        // One engine's failure must not deny the operator the others' plans.
        this.logger.warn(
          `Scheduler preview failed for ${provider.engineId}: ${(err as Error).message}`,
        );
      }
    }
    return plans;
  }
}
