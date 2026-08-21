import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DOMAIN_EVENTS } from '@ultratorrent/shared';
import { DomainEventBus } from '../../domain-events/domain-event-bus.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { FilesService } from '../../files/files.service';
import { FilePathService } from '../../files/file-path.service';
import { pathExists, statSafe } from '../../files/file-fs.util';
import { ProtectionService } from './protection.service';
import { QuarantineService } from './quarantine.service';
import { CandidateDiscoveryService } from './candidate-discovery.service';
import { CleanupJobBridge } from './cleanup-job.bridge';
import { canTransition, type PlanAction } from './domain/plan-contract';

/**
 * Plan execution — the only code in the subsystem that touches the filesystem.
 *
 * Every safety property established earlier is re-established HERE, immediately
 * before each file is touched, because everything checked at discovery or approval
 * describes a world that may have moved on. In order, per action:
 *
 *   1. the plan is still approved and not expired
 *   2. the file still exists, is still inside the hard roots, is not a system path
 *   3. nothing protects it NOW (mandatory re-check #3 of 3)
 *   4. the item is not locked, has no active job, is not being played
 *   5. its fingerprint still matches the one approved — anything else is drift
 *
 * A failed check SKIPS that action with a stated reason. It never guesses, never
 * "fixes" the mismatch, and never proceeds on a file it cannot vouch for. Each row
 * is journalled `running` BEFORE the filesystem call, so a crash mid-execution
 * leaves evidence of what was in flight rather than an untraceable gap.
 */
@Injectable()
export class PlanExecutorService {
  private readonly logger = new Logger(PlanExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly protections: ProtectionService,
    private readonly quarantine: QuarantineService,
    private readonly discovery: CandidateDiscoveryService,
    private readonly files: FilesService,
    private readonly paths: FilePathService,
    private readonly jobBridge: CleanupJobBridge,
    // Appended, and resolved lazily below: importing MediaModule here would
    // close a module cycle that only fails at bootstrap.
    private readonly moduleRef: ModuleRef,
    private readonly bus: DomainEventBus,
  ) {}

  /**
   * Execute an approved plan. Returns counts; per-action outcomes live on the rows.
   * Executing is idempotent by construction: only `pending` actions are considered,
   * and the plan leaves `approved` before any file is touched.
   */
  async execute(planId: string, user: AuthenticatedUser) {
    const plan = await this.prisma.mediaCleanupPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new BadRequestException('Cleanup plan not found');
    if (!canTransition(plan.status as never, 'executing')) {
      throw new BadRequestException(`Plan is ${plan.status} and cannot be executed`);
    }
    // Re-checked here as well as at approval: a plan can expire in the window
    // between being approved and being run.
    if (plan.expiresAt && plan.expiresAt.getTime() <= Date.now()) {
      await this.prisma.mediaCleanupPlan.update({
        where: { id: planId }, data: { status: 'expired' },
      });
      throw new BadRequestException('This plan expired before it ran; re-run the policy.');
    }

    const jobId = await this.jobBridge.startExecutionJob(planId, `Cleanup plan ${planId.slice(0, 8)}`, user.id);
    await this.prisma.mediaCleanupPlan.update({
      where: { id: planId },
      data: { status: 'executing', executedAt: new Date(), executionJobId: jobId },
    });

    const actions = await this.prisma.mediaCleanupAction.findMany({
      where: { planId, status: 'pending' },
      orderBy: { sourcePath: 'asc' },
    });

    /*
     * Seeding media is never purged.
     *
     * Deleting the library copy of a hardlink import frees nothing — the
     * torrent still holds the bytes — and breaks the seed, which is the worst
     * of both outcomes. Asked once for the whole plan rather than per action,
     * because it is one call to the engine.
     *
     * Checked HERE rather than at plan time on purpose: a plan approved
     * yesterday can name a file that started seeding since.
     */
    const seeding = await this.seedingGuard(actions);
    if (seeding.unknown && actions.length) {
      /*
       * Raised once for the run, not per file: the cause is a single
       * unreachable engine, and an inbox with one entry per action would bury
       * the fact rather than report it.
       *
       * Told at all because the safe answer is invisible otherwise — the file
       * simply stays, the plan says it should have gone, and nobody knows why.
       */
      this.bus.publish({
        eventKey: DOMAIN_EVENTS.LIBRARY_CLEANUP_SEEDING_UNVERIFIED,
        resourceType: 'media_cleanup_plan',
        resourceId: planId,
        payload: { planId, skipped: actions.length },
      });
    }

    let completed = 0, skipped = 0, failed = 0;
    let reclaimed = 0n;

    for (const action of actions) {
      try {
        if (seeding.unknown || seeding.blocked.has(action.id)) {
          await this.prisma.mediaCleanupAction.update({
            where: { id: action.id },
            data: {
              status: 'skipped',
              // Two different facts, and an operator needs to tell them apart:
              // "this is seeding" is settled, "we could not ask" is not.
              skipReason: seeding.unknown ? 'seeding_unknown' : 'seeding',
              completedAt: new Date(),
            },
          });
          skipped += 1;
          continue;
        }
        const outcome = await this.executeAction(action, plan, user);
        if (outcome.status === 'completed') {
          completed += 1;
          reclaimed += BigInt(outcome.bytes ?? 0);
        } else {
          skipped += 1;
        }
      } catch (err) {
        failed += 1;
        const message = (err as Error).message;
        this.logger.error(`Cleanup action ${action.id} failed: ${message}`);
        await this.prisma.mediaCleanupAction.update({
          where: { id: action.id },
          data: { status: 'failed', errorCode: 'execution_error', errorMessage: message, completedAt: new Date() },
        }).catch(() => undefined);
      }
    }

    // `partial` is not a lesser `completed`: it says some files were deliberately
    // left alone, which is the outcome an operator most needs to notice.
    const status = failed > 0 ? 'partial' : skipped > 0 ? 'partial' : 'completed';
    const updated = await this.prisma.mediaCleanupPlan.update({
      where: { id: planId },
      data: {
        status,
        actualReclaimBytes: reclaimed,
        errorSummary: failed ? `${failed} action(s) failed` : null,
      },
    });

    await this.jobBridge.finish(jobId, status);
    await this.audit.record({
      userId: user.id, action: 'library_cleanup.plan.executed',
      objectType: 'media_cleanup_plan', objectId: planId,
      metadata: { destination: plan.action, completed, skipped, failed, reclaimedBytes: reclaimed.toString() },
    });

    return { ...updated, completed, skipped, failed };
  }

  // ── one file ───────────────────────────────────────────────────────────────
  /**
   * Which actions in this plan name media a live torrent is still seeding.
   *
   * `unknown` when the engine could not be asked: the run then skips
   * everything rather than assuming nothing is seeding. Deleting something that
   * might still be seeding is the direction that cannot be undone, and a purge
   * that waits for the next run costs nothing.
   */
  private async seedingGuard(
    actions: Array<{ id: string; sourcePath: string; mediaItemId: string | null }>,
  ): Promise<{ blocked: Set<string>; unknown: boolean }> {
    const blocked = new Set<string>();
    if (!actions.length) return { blocked, unknown: false };

    const { MediaLinkageService } = await import('../media-linkage.service');
    const linkage = this.moduleRef.get(MediaLinkageService, { strict: false });

    const live = await linkage.liveHashesStrict();
    if (!live) return { blocked, unknown: true };
    if (!live.size) return { blocked, unknown: false };

    const torrents = await linkage.torrentsForPaths(actions.map((a) => a.sourcePath));
    for (const t of torrents) {
      if (!live.has((t.torrentHash ?? '').toLowerCase())) continue;
      const payload = t.sourcePath ?? '';
      for (const action of actions) {
        const p = action.sourcePath;
        const related =
          (action.mediaItemId && (t.itemIds ?? []).includes(action.mediaItemId)) ||
          p === payload ||
          // A file inside the payload, or a folder containing it: either way the
          // same bytes are being seeded.
          (payload && p.startsWith(`${payload}/`)) ||
          (p && payload.startsWith(`${p}/`));
        if (related) blocked.add(action.id);
      }
    }
    return { blocked, unknown: false };
  }

  private async executeAction(
    action: {
      id: string; sourcePath: string; pinnedFingerprint: string; actionType: string;
      mediaItemId: string | null; mediaFileId: string | null; fileSizeBytes: bigint;
    },
    plan: { id: string; runId: string; policyVersionId: string; action: string; retentionDays: number | null },
    user: AuthenticatedUser,
  ): Promise<{ status: 'completed' | 'skipped'; bytes?: number }> {
    const skip = async (reason: string) => {
      await this.prisma.mediaCleanupAction.update({
        where: { id: action.id },
        data: { status: 'skipped', skipReason: reason, completedAt: new Date() },
      });
      return { status: 'skipped' as const };
    };

    // 1. Path confinement, through the storage boundary. Re-derived from the
    //    recorded path rather than trusted, because the row is a snapshot.
    let abs: string;
    try {
      abs = this.paths.assertWithinHardRoots(action.sourcePath);
      this.paths.storageSafety.assertDeletable(abs);
    } catch {
      return skip('outside_roots');
    }

    // 2. Still there?
    if (!(await pathExists(abs))) return skip('vanished');

    // 3. Protection, re-checked immediately before the filesystem step. This is the
    //    mandatory one: discovery's answer is minutes-to-days old, and a protection
    //    placed in that window exists precisely to stop this.
    const verdict = await this.protections.evaluate({
      mediaItemId: action.mediaItemId ?? undefined,
      mediaFileId: action.mediaFileId ?? undefined,
      path: abs,
    });
    if (verdict.isProtected) return skip(verdict.hasLegalHold ? 'legal_hold' : 'protected');

    // 4. Live state that must never be acted through.
    if (action.mediaItemId) {
      const item = await this.prisma.mediaItem.findUnique({
        where: { id: action.mediaItemId }, select: { locked: true },
      });
      if (item?.locked) return skip('locked');

      const busy = await this.prisma.platformJob.count({
        where: {
          mediaItemId: action.mediaItemId,
          status: { in: ['scheduled', 'queued', 'waiting', 'blocked', 'running', 'pausing', 'paused', 'retrying', 'cancelling'] },
        },
      });
      if (busy > 0) return skip('active_job');
    }

    // 5. Fingerprint drift. A file replaced, resized, re-probed, moved or newly
    //    watched since approval is NOT the file that was approved.
    const drift = await this.detectDrift(action, plan);
    if (drift) {
      await this.prisma.mediaCleanupAction.update({
        where: { id: action.id },
        data: { status: 'skipped', skipReason: 'fingerprint_drift', errorMessage: drift, completedAt: new Date() },
      });
      return { status: 'skipped' };
    }

    // Journal `running` BEFORE the filesystem call, mirroring duplicate resolution:
    // a crash here must leave evidence of what was in flight.
    const info = await statSafe(abs);
    const bytes = info ? Number(info.size) : Number(action.fileSizeBytes);
    await this.prisma.mediaCleanupAction.update({
      where: { id: action.id },
      data: { status: 'running', startedAt: new Date() },
    });

    let destination: string | null = null;
    switch (action.actionType as PlanAction) {
      case 'quarantine': {
        const q = await this.quarantine.quarantine({
          absPath: abs,
          fingerprint: action.pinnedFingerprint,
          actionId: action.id, planId: plan.id, runId: plan.runId,
          policyVersionId: plan.policyVersionId,
          mediaItemId: action.mediaItemId, mediaFileId: action.mediaFileId,
          retentionDays: plan.retentionDays,
          userId: user.id,
        });
        destination = q.quarantinePath;
        break;
      }
      case 'trash': {
        // The one call that removes anything, and it goes through the platform's
        // own path-safe seam in STORAGE scope — cleanup never unlinks by itself.
        const result = await this.files.remove(
          { path: this.paths.storageSafety.toRelative(abs), permanent: false },
          { userId: user.id },
          'storage',
        );
        destination = result.path ?? null;
        break;
      }
      case 'permanent_delete':
        // Unreachable: the policy validator refuses it as a destination and the
        // plan contract refuses to resolve it. Explicit so a future caller sees why.
        throw new BadRequestException('Permanent deletion is not a plan destination');
      default:
        throw new BadRequestException(`Unknown cleanup action "${action.actionType}"`);
    }

    await this.prisma.mediaCleanupAction.update({
      where: { id: action.id },
      data: { status: 'completed', destinationPath: destination, reclaimedBytes: BigInt(bytes), completedAt: new Date() },
    });
    await this.prisma.mediaCleanupCandidate.updateMany({
      where: { id: (await this.candidateIdFor(action.id)) ?? '__none__' },
      data: { status: action.actionType === 'quarantine' ? 'quarantined' : 'trashed' },
    });

    return { status: 'completed', bytes };
  }

  /**
   * Has the world moved since this was approved?
   *
   * Deliberately delegates to the discovery service so the hash compared here is
   * produced by the same code that produced the pinned one. Recomputing it
   * independently would be the classic silent failure: two implementations that
   * drift apart mean either nothing is ever cleaned, or a changed file is deleted
   * as though it were the approved one.
   *
   * Fails CLOSED — if the fingerprint cannot be recomputed at all, that is drift.
   */
  private async detectDrift(
    action: { pinnedFingerprint: string; mediaFileId: string | null },
    plan: { policyVersionId: string },
  ): Promise<string | null> {
    if (!action.mediaFileId) return 'the action records no media file to verify';

    const now = await this.discovery.fingerprintNow(action.mediaFileId, plan.policyVersionId);
    if (!now) return 'the media file or policy version no longer exists';
    if (now.fingerprint === action.pinnedFingerprint) return null;
    return 'the file no longer matches the state that was approved';
  }

  private async candidateIdFor(actionId: string): Promise<string | null> {
    const row = await this.prisma.mediaCleanupAction.findUnique({
      where: { id: actionId }, select: { candidateId: true },
    });
    return row?.candidateId ?? null;
  }

}
