import {
  BadRequestException, ForbiddenException, Injectable, Logger,
  NotFoundException, UnprocessableEntityException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NOTIFICATION_BUS_CHANNEL, NOTIFICATION_EVENTS, SystemRole } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { paginate, parsePage } from '../../../common/pagination';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { ProtectionService } from './protection.service';
import {
  ACTION_PERMISSION, TERMINAL_PLAN_STATUSES, canTransition, checkApproval,
  isExpired, isPlannable, resolveDestination, resolveExpiry,
  type PlanAction, type PlanStatus,
} from './domain/plan-contract';
import type { CleanupPolicyDocument } from './domain/policy-document';
import type {
  ActionListQueryDto, CancelPlanDto, CreatePlanDto, PlanListQueryDto, RejectPlanDto,
} from './dto/plan.dto';

/** Expiry sweep cadence. Frequent enough that a stale plan is not left approvable for long. */
const SWEEP_MS = 15 * 60 * 1000;

/** Candidate status mirrors the plan decision, so a run view shows what happened. */
const CANDIDATE_STATUS_FOR: Record<string, string> = {
  pending_approval: 'pending_approval',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled',
  expired: 'expired',
};

/**
 * Plans and approvals.
 *
 * A plan is the only object an execution may act on. It pins the policy version,
 * the candidate set, and each candidate's fingerprint, so what an approver saw is
 * exactly what will run — not "whatever matches at execution time". There is
 * deliberately **no update endpoint**: after creation a plan changes only through a
 * decision, which is the strongest form of immutability available.
 *
 * Nothing here touches the filesystem. Approval grants permission to act; Phase 8
 * acts, and re-checks everything again immediately before it does.
 */
@Injectable()
export class PlanService {
  private readonly logger = new Logger(PlanService.name);
  private lastSweepAt = new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly protections: ProtectionService,
    private readonly eventBus: EventEmitter2,
  ) {}

  // ── creation ───────────────────────────────────────────────────────────────
  async createPlan(runId: string, dto: CreatePlanDto, user: AuthenticatedUser) {
    const run = await this.prisma.mediaCleanupRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Cleanup run not found');

    // A simulation deliberately produces throwaway findings. Planning from one would
    // turn "what would happen" into "what will happen" without anyone deciding to.
    if (run.simulate) {
      throw new BadRequestException('A simulation cannot be planned from — run the policy for real first');
    }
    if (!['completed', 'partial'].includes(run.status)) {
      throw new BadRequestException(`Run is ${run.status}; plan from a finished run`);
    }

    const version = await this.prisma.mediaCleanupPolicyVersion.findUnique({
      where: { id: run.policyVersionId },
    });
    const document = version?.document as unknown as CleanupPolicyDocument | undefined;
    if (!document) throw new UnprocessableEntityException('The run\'s policy version is missing');

    const mode = document.action?.mode ?? 'report_only';
    if (!isPlannable(mode)) {
      throw new BadRequestException('A report-only policy exists to be read, not to remove anything');
    }

    const destination = resolveDestination(document.action.destination, dto.destination);
    if (!destination) {
      throw new BadRequestException(
        `Cannot escalate to "${dto.destination}" — the policy's destination is "${document.action.destination}"`,
      );
    }

    const candidates = await this.prisma.mediaCleanupCandidate.findMany({
      where: { id: { in: dto.candidateIds }, runId },
    });
    const found = new Set(candidates.map((c) => c.id));
    const missing = dto.candidateIds.filter((id) => !found.has(id));
    if (missing.length) {
      throw new BadRequestException(
        `${missing.length} candidate(s) do not belong to this run: ${missing.slice(0, 5).join(', ')}`,
      );
    }
    const notActionable = candidates.filter((c) => c.status !== 'candidate');
    if (notActionable.length) {
      throw new BadRequestException(
        `${notActionable.length} candidate(s) are not actionable (e.g. "${notActionable[0]!.status}")`,
      );
    }

    // One live plan per candidate. Two plans over the same file would each believe
    // they may remove it, and the second would act on a file the first already took.
    const alreadyPlanned = await this.prisma.mediaCleanupAction.findMany({
      where: {
        candidateId: { in: dto.candidateIds },
        plan: { status: { notIn: [...TERMINAL_PLAN_STATUSES] } },
      },
      select: { candidateId: true, planId: true },
    });
    if (alreadyPlanned.length) {
      throw new BadRequestException(
        `${alreadyPlanned.length} candidate(s) are already in an open plan (e.g. plan ${alreadyPlanned[0]!.planId})`,
      );
    }

    // Protection re-check #2 of 3 (evaluation → HERE → immediately before the fs
    // call). A protection placed since discovery must not be planned over.
    const protectedNow = new Set<string>();
    for (const c of candidates) {
      const verdict = await this.protections.evaluate({
        mediaItemId: c.mediaItemId ?? undefined,
        mediaFileId: c.mediaFileId ?? undefined,
        mediaLibraryId: c.mediaLibraryId ?? undefined,
        path: c.path,
      });
      if (verdict.isProtected) protectedNow.add(c.id);
    }

    const actionable = candidates.filter((c) => !protectedNow.has(c.id));
    if (!actionable.length) {
      throw new UnprocessableEntityException('Every selected candidate is now protected — nothing to plan');
    }

    const estimated = actionable.reduce((n, c) => n + BigInt(c.estimatedReclaimBytes ?? 0), 0n);

    // The policy's own caps bind the plan. A policy that says "at most 200 files"
    // must not be satisfiable by hand-picking 5000 in one plan.
    const caps = document.action;
    if (caps.maxItemsPerRun != null && actionable.length > caps.maxItemsPerRun) {
      throw new UnprocessableEntityException(
        `Plan holds ${actionable.length} files; the policy caps a run at ${caps.maxItemsPerRun}`,
      );
    }
    if (caps.maxReclaimBytesPerRun != null && estimated > BigInt(caps.maxReclaimBytesPerRun)) {
      throw new UnprocessableEntityException(
        `Plan reclaims ${estimated} bytes; the policy caps a run at ${caps.maxReclaimBytesPerRun}`,
      );
    }

    const now = new Date();
    const plan = await this.prisma.$transaction(async (tx) => {
      const created = await tx.mediaCleanupPlan.create({
        data: {
          runId,
          policyVersionId: run.policyVersionId,
          status: 'pending_approval',
          action: destination,
          retentionDays: dto.retentionDays ?? document.action.retentionDays ?? null,
          candidateCount: actionable.length,
          estimatedReclaimBytes: estimated,
          createdById: user.id,
          expiresAt: resolveExpiry(now, dto.expiresInHours),
        },
      });

      await tx.mediaCleanupAction.createMany({
        data: candidates.map((c) => ({
          planId: created.id,
          candidateId: c.id,
          mediaItemId: c.mediaItemId,
          mediaFileId: c.mediaFileId,
          actionType: destination,
          // A candidate protected since discovery is recorded as a SKIPPED action
          // rather than dropped: the plan should show the whole intent, including
          // what was refused and why.
          status: protectedNow.has(c.id) ? 'skipped' : 'pending',
          skipReason: protectedNow.has(c.id) ? 'protected' : null,
          sourcePath: c.path,
          pinnedFingerprint: c.fingerprint,
          fileSizeBytes: c.fileSizeBytes,
        })),
      });

      await tx.mediaCleanupCandidate.updateMany({
        where: { id: { in: actionable.map((c) => c.id) } },
        data: { status: 'pending_approval' },
      });
      return created;
    });

    await this.audit.record({
      userId: user.id,
      action: 'library_cleanup.plan.created',
      objectType: 'media_cleanup_plan',
      objectId: plan.id,
      metadata: {
        runId,
        policyVersionId: run.policyVersionId,
        destination,
        requestedDestination: dto.destination ?? null,
        candidateCount: actionable.length,
        skippedProtected: protectedNow.size,
        estimatedReclaimBytes: estimated.toString(),
        notes: dto.notes ?? null,
      },
    });

    this.emit(NOTIFICATION_EVENTS.LIBRARY_CLEANUP_PLAN_PENDING_APPROVAL, {
      planId: plan.id,
      runId,
      destination,
      candidateCount: actionable.length,
      estimatedReclaimBytes: estimated.toString(),
      expiresAt: plan.expiresAt?.toISOString() ?? null,
    }, `cleanup-plan:${plan.id}`);

    return { ...plan, skippedProtected: protectedNow.size };
  }

  // ── reads ──────────────────────────────────────────────────────────────────
  async getPlan(planId: string) {
    const plan = await this.prisma.mediaCleanupPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Cleanup plan not found');
    const byStatus = await this.prisma.mediaCleanupAction.groupBy({
      by: ['status'], where: { planId }, _count: { _all: true },
    });
    return {
      ...plan,
      expired: isExpired(plan.expiresAt, new Date()),
      actionCounts: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
    };
  }

  async listPlans(query: PlanListQueryDto) {
    const params = parsePage(query.page, query.pageSize, 25, 200);
    const where: Record<string, unknown> = {};
    if (query.runId) where.runId = query.runId;
    if (query.status) where.status = query.status;
    return paginate(this.prisma.mediaCleanupPlan, { where, orderBy: { createdAt: 'desc' } }, params);
  }

  async listActions(planId: string, query: ActionListQueryDto) {
    await this.getPlan(planId);
    const params = parsePage(query.page, query.pageSize, 50, 200);
    const where: Record<string, unknown> = { planId };
    if (query.status) where.status = query.status;
    return paginate(this.prisma.mediaCleanupAction, { where, orderBy: { sourcePath: 'asc' } }, params);
  }

  // ── decisions ──────────────────────────────────────────────────────────────
  async approve(planId: string, user: AuthenticatedUser) {
    const plan = await this.load(planId);
    const now = new Date();

    // The plan may have waited days. Anything protected in the meantime drops out
    // here rather than being carried into execution.
    const newlyProtected = await this.refreshProtections(planId);
    const actionable = await this.prisma.mediaCleanupAction.count({
      where: { planId, status: 'pending' },
    });

    const verdict = checkApproval({
      status: plan.status as PlanStatus,
      action: plan.action as PlanAction,
      expiresAt: plan.expiresAt,
      now,
      holderPermissions: user.permissions ?? [],
      superAdmin: (user.roles ?? []).includes(SystemRole.SUPER_ADMIN),
      actionableCount: actionable,
    });

    if (!verdict.allowed) {
      await this.audit.record({
        userId: user.id, action: 'library_cleanup.plan.approve_refused',
        objectType: 'media_cleanup_plan', objectId: planId, result: 'failure',
        metadata: { reason: verdict.reason, missingPermission: verdict.missingPermission ?? null },
      });
      switch (verdict.reason) {
        case 'missing_permission':
          throw new ForbiddenException(
            `Approving a "${plan.action}" plan additionally requires ${ACTION_PERMISSION[plan.action as PlanAction]}`,
          );
        case 'expired':
          throw new BadRequestException('This plan expired; its snapshot is too old to act on. Re-run the policy.');
        case 'nothing_to_do':
          throw new UnprocessableEntityException('Nothing left to act on — every file is protected or already skipped');
        default:
          throw new BadRequestException(`Plan is ${plan.status} and cannot be approved`);
      }
    }

    const updated = await this.transition(plan, 'approved', {
      approvedById: user.id, approvedAt: now,
      candidateCount: actionable,
    });

    // Self-approval is permitted — most installs have one operator, and a workflow
    // nobody can complete is worse than one that is recorded honestly — but it is
    // audited under its own action so a reviewer can find it.
    const selfApproved = plan.createdById === user.id;
    await this.audit.record({
      userId: user.id,
      action: selfApproved ? 'library_cleanup.plan.self_approved' : 'library_cleanup.plan.approved',
      objectType: 'media_cleanup_plan', objectId: planId,
      metadata: {
        destination: plan.action, actionableCount: actionable,
        newlyProtected, createdById: plan.createdById,
      },
    });

    this.emit(NOTIFICATION_EVENTS.LIBRARY_CLEANUP_PLAN_APPROVED, {
      planId, destination: plan.action, candidateCount: actionable,
      approvedBy: user.username, selfApproved,
    }, `cleanup-plan:${planId}`);

    return { ...updated, newlyProtected };
  }

  async reject(planId: string, dto: RejectPlanDto, user: AuthenticatedUser) {
    const plan = await this.load(planId);
    if (!canTransition(plan.status as PlanStatus, 'rejected')) {
      throw new BadRequestException(`Plan is ${plan.status} and cannot be rejected`);
    }
    const updated = await this.transition(plan, 'rejected', {
      rejectedById: user.id, rejectedAt: new Date(), rejectionReason: dto.reason,
    });
    await this.audit.record({
      userId: user.id, action: 'library_cleanup.plan.rejected',
      objectType: 'media_cleanup_plan', objectId: planId,
      metadata: { reason: dto.reason },
    });
    this.emit(NOTIFICATION_EVENTS.LIBRARY_CLEANUP_PLAN_REJECTED, {
      planId, reason: dto.reason, rejectedBy: user.username,
    }, `cleanup-plan:${planId}`);
    return updated;
  }

  async cancel(planId: string, dto: CancelPlanDto, user: AuthenticatedUser) {
    const plan = await this.load(planId);
    if (!canTransition(plan.status as PlanStatus, 'cancelled')) {
      throw new BadRequestException(`Plan is ${plan.status} and cannot be cancelled`);
    }
    const updated = await this.transition(plan, 'cancelled', {
      errorSummary: dto.reason ?? null,
    });
    await this.audit.record({
      userId: user.id, action: 'library_cleanup.plan.cancelled',
      objectType: 'media_cleanup_plan', objectId: planId,
      metadata: { reason: dto.reason ?? null, previousStatus: plan.status },
    });
    return updated;
  }

  // ── expiry ─────────────────────────────────────────────────────────────────
  /**
   * A plan expires because its fingerprints decay: the longer it waits, the less
   * its snapshot describes what is on disk. An APPROVED plan expires too — approval
   * is not a licence that outlives the evidence it was granted on.
   */
  @Interval('library_cleanup_plan_expiry', SWEEP_MS)
  async sweepExpiry(): Promise<void> {
    const now = new Date();
    this.lastSweepAt = now;
    try {
      const due = await this.prisma.mediaCleanupPlan.findMany({
        where: { status: { in: ['pending_approval', 'approved'] }, expiresAt: { lte: now } },
        select: { id: true, status: true, runId: true, candidateCount: true },
      });
      for (const plan of due) {
        await this.transition({ id: plan.id, status: plan.status } as never, 'expired', {});
        await this.audit.record({
          action: 'library_cleanup.plan.expired',
          objectType: 'media_cleanup_plan', objectId: plan.id,
          metadata: { previousStatus: plan.status, candidateCount: plan.candidateCount },
        });
        this.emit(NOTIFICATION_EVENTS.LIBRARY_CLEANUP_PLAN_EXPIRED, {
          planId: plan.id, runId: plan.runId, previousStatus: plan.status,
          candidateCount: plan.candidateCount,
        }, `cleanup-plan:${plan.id}`);
      }
      if (due.length) this.logger.log(`Expired ${due.length} cleanup plan(s)`);
    } catch (err) {
      this.logger.error(`Plan expiry sweep failed: ${(err as Error).message}`);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private async load(planId: string) {
    const plan = await this.prisma.mediaCleanupPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Cleanup plan not found');
    return plan;
  }

  /**
   * Re-evaluate protections for everything still pending and skip what is now
   * covered. Returns how many dropped out, so the caller can report it rather than
   * silently approving fewer files than the operator selected.
   */
  private async refreshProtections(planId: string): Promise<number> {
    const pending = await this.prisma.mediaCleanupAction.findMany({
      where: { planId, status: 'pending' },
      select: { id: true, mediaItemId: true, mediaFileId: true, sourcePath: true },
    });
    let skipped = 0;
    for (const action of pending) {
      const verdict = await this.protections.evaluate({
        mediaItemId: action.mediaItemId ?? undefined,
        mediaFileId: action.mediaFileId ?? undefined,
        path: action.sourcePath,
      });
      if (!verdict.isProtected) continue;
      await this.prisma.mediaCleanupAction.update({
        where: { id: action.id },
        data: { status: 'skipped', skipReason: verdict.hasLegalHold ? 'legal_hold' : 'protected' },
      });
      skipped += 1;
    }
    return skipped;
  }

  /** One place that writes a plan status, so the state machine cannot be bypassed. */
  private async transition(
    plan: { id: string; status: string },
    to: PlanStatus,
    data: Record<string, unknown>,
  ) {
    if (!canTransition(plan.status as PlanStatus, to)) {
      throw new BadRequestException(`Cannot move a plan from ${plan.status} to ${to}`);
    }
    const updated = await this.prisma.mediaCleanupPlan.update({
      where: { id: plan.id },
      data: { status: to, ...data },
    });
    const candidateStatus = CANDIDATE_STATUS_FOR[to];
    if (candidateStatus) {
      const actions = await this.prisma.mediaCleanupAction.findMany({
        where: { planId: plan.id, status: 'pending' },
        select: { candidateId: true },
      });
      if (actions.length) {
        await this.prisma.mediaCleanupCandidate.updateMany({
          where: { id: { in: actions.map((a) => a.candidateId) } },
          data: { status: candidateStatus },
        });
      }
    }
    return updated;
  }

  private emit(event: string, payload: Record<string, unknown>, dedupeKey?: string): void {
    try {
      this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, {
        event, dedupeKey, payload, at: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.debug(`emit ${event} failed: ${(err as Error).message}`);
    }
  }
}
