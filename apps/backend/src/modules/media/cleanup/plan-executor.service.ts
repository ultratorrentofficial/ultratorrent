import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NOTIFICATION_BUS_CHANNEL } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { FilesService } from '../../files/files.service';
import { FilePathService } from '../../files/file-path.service';
import { pathExists, statSafe } from '../../files/file-fs.util';
import { ProtectionService } from './protection.service';
import { QuarantineService } from './quarantine.service';
import { CandidateDiscoveryService } from './candidate-discovery.service';
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
    private readonly eventBus: EventEmitter2,
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

    await this.prisma.mediaCleanupPlan.update({
      where: { id: planId },
      data: { status: 'executing', executedAt: new Date() },
    });
    this.emit('media.cleanup.plan.executing', { planId, action: plan.action });

    const actions = await this.prisma.mediaCleanupAction.findMany({
      where: { planId, status: 'pending' },
      orderBy: { sourcePath: 'asc' },
    });

    let completed = 0, skipped = 0, failed = 0;
    let reclaimed = 0n;

    for (const action of actions) {
      try {
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

    await this.audit.record({
      userId: user.id, action: 'library_cleanup.plan.executed',
      objectType: 'media_cleanup_plan', objectId: planId,
      metadata: { destination: plan.action, completed, skipped, failed, reclaimedBytes: reclaimed.toString() },
    });
    this.emit('media.cleanup.plan.executed', {
      planId, status, completed, skipped, failed, reclaimedBytes: reclaimed.toString(),
    });

    return { ...updated, completed, skipped, failed };
  }

  // ── one file ───────────────────────────────────────────────────────────────
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

  private emit(event: string, payload: Record<string, unknown>): void {
    try {
      this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, { event, payload, at: new Date().toISOString() });
    } catch (err) {
      this.logger.debug(`emit ${event} failed: ${(err as Error).message}`);
    }
  }
}
