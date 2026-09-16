import { Injectable, NotFoundException } from '@nestjs/common';
import {
  TERMINAL_PLAN_STATUSES,
  survivesApproval,
  type MediaRemediationPlan,
  type MediaRemediationPlanListResult,
  type MediaRemediationPlanStep,
  type MediaRemediationSummary,
  type RemediationBlockReason,
  type RemediationFailureClass,
  type RemediationPlanStatus,
  type RemediationRiskClass,
  type RemediationStepStatus,
} from '@ultratorrent/shared';

import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { parsePage } from '../../../common/pagination';
import type { ListRemediationPlansDto } from '../dto/remediation.dto';

/**
 * The read side of remediation plans.
 *
 * Reads persisted state and NOTHING else. Opening this queue must not start
 * a plan, claim one, call a source domain or contact a provider — that is the
 * difference between a page people check and a page people learn not to open.
 * Separated from `RemediationPlanService` for the same reason
 * `RecommendationQueryService` is separate from its writer: a list endpoint
 * and a reconciliation pass have opposite risk profiles, and sharing a class
 * invites a read path that quietly writes.
 *
 * **One definition of the queue**, built once and handed to both the list and
 * the counters. A summary that disagrees with the list beneath it destroys
 * trust in both.
 */
@Injectable()
export class RemediationQueryService {
  /** Title search resolves through the projection; bound what it can match. */
  private static readonly MAX_TITLE_MATCHES = 5000;

  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(query: ListRemediationPlansDto): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (query.status) {
      where.status = query.status;
    } else {
      /*
       * Active by default. A succeeded or superseded plan is history, and
       * history does not belong in a queue of things to decide — but it stays
       * readable by asking for it explicitly, because "what did this system
       * do last week" is the question plans exist to answer.
       */
      where.status = { notIn: [...TERMINAL_PLAN_STATUSES] };
    }
    if (query.entityType) where.entityType = query.entityType;
    if (query.entityId) where.entityId = query.entityId;
    if (query.policyId) where.policyId = query.policyId;
    return where;
  }

  async list(query: ListRemediationPlansDto): Promise<MediaRemediationPlanListResult> {
    const params = parsePage(query.page, query.pageSize);
    const where = await this.withTitleSearch(this.buildWhere(query), query.q);
    if (!where) return { items: [], total: 0, page: params.page, pageSize: params.pageSize };

    const [rows, total] = await Promise.all([
      this.prisma.mediaRemediationPlan.findMany({
        where,
        include: { steps: { orderBy: { ordinal: 'asc' } } },
        // Matches the `(status, createdAt)` index: oldest decision first, so
        // a queue drains in the order things were proposed.
        orderBy: [{ createdAt: 'asc' }],
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.mediaRemediationPlan.count({ where }),
    ]);

    const titles = await this.titlesFor(rows);
    return {
      items: rows.map((r) => this.toContract(r, titles)),
      total,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  /** Counts for the overview. Same predicate as the list, by construction. */
  async summary(): Promise<MediaRemediationSummary> {
    const grouped = await this.prisma.mediaRemediationPlan.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const count = (status: string) =>
      grouped.find((g) => g.status === status)?._count._all ?? 0;

    return {
      awaitingApproval: count('proposed') + count('awaiting_approval'),
      approved: count('approved'),
      executing: count('executing'),
      waiting: count('waiting') + count('verifying'),
      blocked: count('blocked'),
      failed: count('failed'),
      recentlySucceeded: count('succeeded'),
    };
  }

  async detail(planId: string): Promise<MediaRemediationPlan> {
    const row = await this.prisma.mediaRemediationPlan.findUnique({
      where: { id: planId },
      include: { steps: { orderBy: { ordinal: 'asc' } } },
    });
    if (!row) throw new NotFoundException(`Unknown remediation plan: ${planId}`);
    const titles = await this.titlesFor([row]);
    return this.toContract(row, titles);
  }

  /**
   * Narrow by media title, resolved through the projection.
   *
   * Server-side, and bounded: filtering a paginated list in the browser would
   * filter one page and silently hide every other match. Returns null when
   * the search matched nothing at all, which the caller renders as an empty
   * page rather than as an unfiltered one.
   */
  private async withTitleSearch(
    where: Record<string, unknown>,
    q?: string,
  ): Promise<Record<string, unknown> | null> {
    const needle = q?.trim();
    if (!needle) return where;

    const matches = await this.prisma.mediaIntelligenceProjection.findMany({
      where: { title: { contains: needle, mode: 'insensitive' } },
      select: { entityType: true, entityId: true },
      take: RemediationQueryService.MAX_TITLE_MATCHES,
    });
    if (!matches.length) return null;

    return {
      ...where,
      OR: matches.map((m) => ({ entityType: m.entityType, entityId: m.entityId })),
    };
  }

  /** Titles for rendering only — denormalized, never authoritative. */
  private async titlesFor(
    rows: ReadonlyArray<{ entityType: string; entityId: string }>,
  ): Promise<Map<string, { title: string; year: number | null }>> {
    if (!rows.length) return new Map();
    const found = await this.prisma.mediaIntelligenceProjection.findMany({
      where: { OR: rows.map((r) => ({ entityType: r.entityType, entityId: r.entityId })) },
      select: { entityType: true, entityId: true, title: true, year: true },
    });
    return new Map(found.map((p) => [`${p.entityType}|${p.entityId}`, { title: p.title, year: p.year }]));
  }

  /**
   * A deliberate DTO, assembled field by field.
   *
   * Never the raw Prisma row: it carries `approvedFingerprint` and the three
   * pinned hashes, which are internal machinery an operator cannot act on and
   * a browser has no business holding.
   */
  private toContract(
    row: PlanRow,
    titles: Map<string, { title: string; year: number | null }>,
  ): MediaRemediationPlan {
    const projected = titles.get(`${row.entityType}|${row.entityId}`);
    const blockReason = (row.blockReason as RemediationBlockReason | null) ?? null;

    return {
      id: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      title: projected?.title ?? null,
      year: projected?.year ?? null,

      findingId: row.findingId,
      recommendationId: row.recommendationId,
      policyId: row.policyId,
      // Resolved by the frontend from the policy list it already loads;
      // joining here would add a query per page for a label.
      policyName: null,
      findingCode: null,

      type: row.type,
      status: row.status as RemediationPlanStatus,
      riskClass: row.riskClass as RemediationRiskClass,

      blockReason,
      /*
       * The single most important field on this DTO. It tells the UI whether
       * an Approve button should exist at all: a blocker about knowledge
       * cannot be cleared by a signature, so offering one would promise
       * something the server will refuse.
       */
      blockSurvivesApproval: blockReason !== null && survivesApproval(blockReason),

      explanation: (row.explanation ?? {}) as Record<string, unknown>,
      steps: row.steps.map((s) => this.toStep(s)),

      approvedById: row.approvedById,
      approvedByName: null,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      /*
       * Derived from the one fact that is unambiguous: a plan holding an
       * approver but no pinned fingerprint had its approval cleared by the
       * sweep when a justification moved.
       *
       * An earlier version inferred this from a combination of null
       * `approvedAt`, null fingerprint and `proposed` status — three weak
       * signals stacked into a guess. The sweep already records an
       * `approval_invalidated` history event and clears the pin; reading the
       * pin is reading what actually happened.
       */
      approvalInvalidated: row.approvedById !== null && row.approvedFingerprint === null,

      expiresAt: row.expiresAt?.toISOString() ?? null,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      supersededAt: row.supersededAt?.toISOString() ?? null,
      supersededReason: row.supersededReason,

      failureClass: (row.failureClass as RemediationFailureClass | null) ?? null,
      failureMessage: row.failureMessage,

      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toStep(s: StepRow): MediaRemediationPlanStep {
    return {
      id: s.id,
      ordinal: s.ordinal,
      kind: s.kind,
      ownerDomain: s.ownerDomain,
      capabilityId: s.capabilityId,
      requiredPermission: s.requiredPermission,
      status: s.status as RemediationStepStatus,
      inputSnapshot: (s.inputSnapshot ?? {}) as Record<string, unknown>,
      expectedPostcondition: (s.expectedPostcondition ?? {}) as Record<string, unknown>,
      attemptCount: s.attemptCount,
      failureClass: (s.failureClass as RemediationFailureClass | null) ?? null,
      failureMessage: s.failureMessage,
      skipReason: s.skipReason,
      startedAt: s.startedAt?.toISOString() ?? null,
      completedAt: s.completedAt?.toISOString() ?? null,
    };
  }
}

interface StepRow {
  id: string;
  ordinal: number;
  kind: string;
  ownerDomain: string;
  capabilityId: string | null;
  requiredPermission: string | null;
  status: string;
  inputSnapshot: unknown;
  expectedPostcondition: unknown;
  attemptCount: number;
  failureClass: string | null;
  failureMessage: string | null;
  skipReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

interface PlanRow {
  id: string;
  entityType: string;
  entityId: string;
  findingId: string | null;
  recommendationId: string | null;
  policyId: string | null;
  type: string;
  status: string;
  riskClass: string;
  blockReason: string | null;
  explanation: unknown;
  approvedById: string | null;
  approvedAt: Date | null;
  approvedFingerprint: string | null;
  recommendationFingerprint: string | null;
  expiresAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  supersededAt: Date | null;
  supersededReason: string | null;
  failureClass: string | null;
  failureMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  steps: StepRow[];
}
