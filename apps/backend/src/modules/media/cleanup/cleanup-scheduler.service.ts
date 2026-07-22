import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { statfs } from 'node:fs/promises';
import { NOTIFICATION_BUS_CHANNEL } from '@ultratorrent/shared';
import { parseExpression } from 'cron-parser';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { FilePathService } from '../../files/file-path.service';
import { CandidateDiscoveryService } from './candidate-discovery.service';
import type { CleanupPolicyDocument } from './domain/policy-document';
import {
  breakerIsOpen, cronIsDue, recordRunOutcome, shouldRelievePressure,
  type BreakerState, type FreeSpaceReading,
} from './domain/storage-pressure';

/** How often due policies are looked for. */
const TICK_MS = 5 * 60 * 1000;

/**
 * Scheduled and storage-pressure runs.
 *
 * Everything this fires is a DISCOVERY run — it produces candidates, and for an
 * approval-required policy a human still decides. Nothing here removes a file, and
 * nothing here approves a plan; automatic destinations are a Phase 10 concern that
 * still routes through the same plan/execute path.
 *
 * The tick selects due work rather than holding timers, matching every other
 * recurring sweep in the platform: a restart replays no backlog and a paused
 * container does not wake up owing a thousand runs.
 */
@Injectable()
export class CleanupSchedulerService {
  private readonly logger = new Logger(CleanupSchedulerService.name);
  /** Per-policy breaker. In memory on purpose: a restart is a legitimate reset. */
  private readonly breakers = new Map<string, BreakerState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly paths: FilePathService,
    private readonly discovery: CandidateDiscoveryService,
    private readonly eventBus: EventEmitter2,
  ) {}

  @Interval('library_cleanup_scheduler', TICK_MS)
  async tick(): Promise<void> {
    try {
      await this.runScheduled();
      await this.runStoragePressure();
    } catch (err) {
      this.logger.error(`Cleanup scheduler tick failed: ${(err as Error).message}`);
    }
  }

  // ── cron-scheduled policies ────────────────────────────────────────────────
  async runScheduled(now = new Date()): Promise<number> {
    const policies = await this.prisma.mediaCleanupPolicy.findMany({
      where: { enabled: true, scheduleCron: { not: null }, archivedAt: null },
    });

    let fired = 0;
    for (const policy of policies) {
      if (!policy.publishedVersionId) continue; // never run an unpublished policy
      if (this.breakerOpen(policy.id, now)) continue;

      let previousFiring: Date | null = null;
      try {
        previousFiring = parseExpression(policy.scheduleCron!, { currentDate: now }).prev().toDate();
      } catch (err) {
        // A malformed expression must not stop the sweep for every other policy.
        this.logger.warn(`Policy ${policy.id} has an unparseable schedule "${policy.scheduleCron}": ${(err as Error).message}`);
        continue;
      }

      if (!cronIsDue({ previousFiring, lastRunAt: policy.lastRunAt, now })) continue;
      await this.fire(policy.id, 'scheduled', { cron: policy.scheduleCron });
      fired += 1;
    }
    return fired;
  }

  // ── storage pressure ───────────────────────────────────────────────────────
  async runStoragePressure(now = new Date()): Promise<number> {
    const policies = await this.prisma.mediaCleanupPolicy.findMany({
      where: { enabled: true, freeSpaceTriggerPercent: { not: null }, archivedAt: null },
    });

    let fired = 0;
    for (const policy of policies) {
      if (!policy.publishedVersionId) continue;
      if (this.breakerOpen(policy.id, now)) continue;

      const version = await this.prisma.mediaCleanupPolicyVersion.findUnique({
        where: { id: policy.publishedVersionId },
      });
      const document = version?.document as unknown as CleanupPolicyDocument | undefined;
      if (!document) continue;

      // The denormalized column is only a cheap selector; the DOCUMENT is
      // authoritative, and a version that never enabled storage pressure must not
      // be fired by a stale column left on the policy row.
      const pressure = document.storagePressure;
      if (!pressure?.enabled) continue;

      const reading = await this.readFreeSpace(await this.pathsForPolicy(document));
      const decision = shouldRelievePressure(reading, {
        triggerBelowPercent: pressure.triggerBelowFreePercent ?? policy.freeSpaceTriggerPercent!,
        stopAtPercent: pressure.stopAtFreePercent,
        maxItemsPerRun: document.action?.maxItemsPerRun,
        maxReclaimBytesPerRun: pressure.maxReclaimBytes ?? document.action?.maxReclaimBytesPerRun,
        maxRuntimeSeconds: pressure.maxRuntimeSeconds,
      });

      if (!decision.fire) continue;
      await this.fire(policy.id, 'storage_pressure', {
        reason: decision.reason,
        targetBytes: decision.targetBytes,
        freePercent: reading?.freePercent ?? null,
      });
      fired += 1;
    }
    return fired;
  }

  /**
   * Free space for the paths a policy actually covers, taken through the STORAGE
   * boundary — a library legitimately sits outside the narrowed browse root, and
   * G18 was measuring the wrong filesystem because of it.
   *
   * When a policy spans several filesystems the TIGHTEST reading wins: pressure on
   * any one of them is pressure, and averaging would hide a full disk behind an
   * empty one.
   */
  async readFreeSpace(paths: string[]): Promise<FreeSpaceReading | null> {
    let tightest: FreeSpaceReading | null = null;
    for (const p of paths) {
      try {
        const abs = this.paths.assertWithinHardRoots(p);
        const fs = await statfs(abs);
        const totalBytes = fs.blocks * fs.bsize;
        // `bavail`, not `bfree`: the reserved-for-root blocks are not space this
        // process can ever use, and counting them makes a trigger fire late.
        const availableBytes = fs.bavail * fs.bsize;
        if (totalBytes <= 0) continue;
        const reading: FreeSpaceReading = {
          availableBytes, totalBytes,
          freePercent: (availableBytes / totalBytes) * 100,
        };
        if (!tightest || reading.freePercent < tightest.freePercent) tightest = reading;
      } catch (err) {
        this.logger.debug(`Could not read free space for ${p}: ${(err as Error).message}`);
      }
    }
    return tightest;
  }

  /** The library paths a policy's scope covers; all hard roots when unscoped. */
  private async pathsForPolicy(document: CleanupPolicyDocument): Promise<string[]> {
    const scope = document.scope ?? {};
    const where: Record<string, unknown> = {};
    if (scope.libraryIds?.length) where.id = { in: scope.libraryIds };
    if (scope.libraryKinds?.length) where.kind = { in: scope.libraryKinds };

    if (Object.keys(where).length) {
      const libraries = await this.prisma.mediaLibrary.findMany({ where, select: { path: true } });
      const paths = libraries.map((l) => l.path).filter(Boolean);
      if (paths.length) return paths;
    }
    if (scope.pathPrefixes?.length) return scope.pathPrefixes;
    return this.paths.hardRoots;
  }

  // ── shared ─────────────────────────────────────────────────────────────────
  private async fire(policyId: string, trigger: string, metadata: Record<string, unknown>) {
    try {
      const run = await this.discovery.startRun(policyId, { simulate: false, trigger });
      await this.prisma.mediaCleanupPolicy.update({
        where: { id: policyId }, data: { lastRunAt: new Date() },
      });
      // Awaited: a scan is read-only, and letting two ticks overlap on one policy
      // would double the work for no benefit.
      await this.discovery.executeRun(run.id);

      const finished = await this.prisma.mediaCleanupRun.findUnique({
        where: { id: run.id }, select: { status: true },
      });
      const ok = finished?.status !== 'failed';
      this.record(policyId, ok);

      await this.audit.record({
        action: `library_cleanup.run.${trigger}`,
        objectType: 'media_cleanup_run', objectId: run.id,
        result: ok ? 'success' : 'failure',
        metadata: { policyId, ...metadata },
      });
      this.emit('media.cleanup.run.triggered', { runId: run.id, policyId, trigger, ...metadata });
    } catch (err) {
      this.record(policyId, false);
      this.logger.error(`${trigger} run for policy ${policyId} failed: ${(err as Error).message}`);
    }
  }

  private breakerOpen(policyId: string, now: Date): boolean {
    const state = this.breakers.get(policyId);
    if (!state) return false;
    const open = breakerIsOpen(state, now.getTime());
    if (open) {
      this.logger.warn(
        `Automatic cleanup for policy ${policyId} is paused after ${state.consecutiveFailures} consecutive failures`,
      );
    }
    return open;
  }

  private record(policyId: string, ok: boolean): void {
    const previous = this.breakers.get(policyId) ?? { consecutiveFailures: 0, openedAt: null };
    const next = recordRunOutcome(previous, ok, Date.now());
    this.breakers.set(policyId, next);
    if (next.openedAt && !previous.openedAt) {
      this.logger.error(
        `Pausing automatic cleanup for policy ${policyId}: ${next.consecutiveFailures} consecutive failures. Manual runs are unaffected.`,
      );
    }
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    try {
      this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, { event, payload, at: new Date().toISOString() });
    } catch (err) {
      this.logger.debug(`emit ${event} failed: ${(err as Error).message}`);
    }
  }
}
