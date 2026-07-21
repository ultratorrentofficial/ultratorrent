import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PlatformJob, Prisma } from '@prisma/client';
import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { parsePage, pageOf, type Page } from '../../../common/pagination';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { ACTIVE_STATUSES, type JobStatus } from './job-status';
import type { JobListQueryDto, JobEventsQueryDto } from '../dto/job-query.dto';

/** A job as returned to a list (sanitized — no raw input/checkpoint). */
export interface JobListItem {
  id: string;
  type: string;
  name: string | null;
  moduleKey: string;
  workspaceKey: string | null;
  status: JobStatus;
  phase: string | null;
  progressPercent: number;
  source: string;
  resourceType: string | null;
  resourceId: string | null;
  priority: number;
  attempt: number;
  maxAttempts: number;
  createdById: string | null;
  workerId: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  capabilities: { cancellable: boolean; pausable: boolean; resumable: boolean; retryable: boolean };
}

/** A job's full detail (sanitized). */
export interface JobDetail extends JobListItem {
  description: string | null;
  correlationId: string | null;
  parentJobId: string | null;
  rootJobId: string | null;
  scheduleId: string | null;
  libraryId: string | null;
  mediaItemId: string | null;
  progressCurrent: number | null;
  progressTotal: number | null;
  progressUnit: string | null;
  statusMessageKey: string | null;
  statusMessageParams: unknown;
  scheduledFor: Date | null;
  heartbeatAt: Date | null;
  failedAt: Date | null;
  cancelledAt: Date | null;
  pausedAt: Date | null;
  retryAt: Date | null;
  timeoutSeconds: number | null;
  requiredPermission: string | null;
  visibilityScope: string;
  inputSummary: unknown;
  resultSummary: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  warnings: unknown;
  metrics: unknown;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Read side of the Jobs Center: RBAC-scoped, paginated queries over `platform_jobs`,
 * mapping rows to sanitized DTOs (never exposing `inputData`/`checkpoint`). A viewer
 * sees a job only if they may — public jobs, their own, jobs with no required
 * permission, or jobs whose owning-module permission they hold; `jobs.view_all`
 * (or super-admin) widens this but never bypasses the field-level sanitization here.
 */
@Injectable()
export class PlatformJobsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Whether the user can, in principle, see all jobs. */
  private canViewAll(user: AuthenticatedUser): boolean {
    return (
      user.roles?.includes(SystemRole.SUPER_ADMIN) ||
      (user.permissions ?? []).includes(PERMISSIONS.JOBS_VIEW_ALL) ||
      (user.permissions ?? []).includes(PERMISSIONS.JOBS_ADMIN)
    );
  }

  /** The Prisma visibility clause for a user (empty object = unrestricted). */
  visibilityWhere(user: AuthenticatedUser): Prisma.PlatformJobWhereInput {
    if (this.canViewAll(user)) return {};
    const held = user.permissions ?? [];
    return {
      OR: [
        { visibilityScope: 'public' },
        { createdById: user.id },
        { requiredPermission: null },
        { requiredPermission: { in: held } },
      ],
    };
  }

  async list(user: AuthenticatedUser, q: JobListQueryDto): Promise<Page<JobListItem>> {
    const { skip, take, page, pageSize } = parsePage(q.page, q.pageSize, 25, 200);
    const where = this.buildWhere(user, q);
    const orderBy = { [q.sort ?? 'createdAt']: q.order ?? 'desc' } as Prisma.PlatformJobOrderByWithRelationInput;
    const [rows, total] = await Promise.all([
      this.prisma.platformJob.findMany({ where, orderBy, skip, take }),
      this.prisma.platformJob.count({ where }),
    ]);
    return pageOf(rows.map((r) => this.toListItem(r)), total, { skip, take, page, pageSize });
  }

  async overview(user: AuthenticatedUser): Promise<Record<string, unknown>> {
    const where = this.visibilityWhere(user);
    const grouped = await this.prisma.platformJob.groupBy({ by: ['status'], where, _count: { _all: true } });
    const byStatus: Record<string, number> = {};
    for (const g of grouped) byStatus[g.status] = g._count._all;
    const active = [...ACTIVE_STATUSES].reduce((n, s) => n + (byStatus[s] ?? 0), 0);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [completedToday, failedToday, cancelledToday] = await Promise.all([
      this.prisma.platformJob.count({ where: { ...where, status: { in: ['completed', 'completed_with_warnings'] }, completedAt: { gte: startOfDay } } }),
      this.prisma.platformJob.count({ where: { ...where, status: 'failed', failedAt: { gte: startOfDay } } }),
      this.prisma.platformJob.count({ where: { ...where, status: 'cancelled', cancelledAt: { gte: startOfDay } } }),
    ]);
    const finishedToday = completedToday + failedToday;
    const successRate = finishedToday > 0 ? Math.round((completedToday / finishedToday) * 100) : null;

    return {
      byStatus,
      running: byStatus['running'] ?? 0,
      queued: byStatus['queued'] ?? 0,
      waiting: byStatus['waiting'] ?? 0,
      blocked: byStatus['blocked'] ?? 0,
      scheduled: byStatus['scheduled'] ?? 0,
      failed: byStatus['failed'] ?? 0,
      active,
      completedToday,
      failedToday,
      cancelledToday,
      successRate,
    };
  }

  async get(user: AuthenticatedUser, id: string): Promise<JobDetail> {
    const job = await this.prisma.platformJob.findFirst({ where: { AND: [{ id }, this.visibilityWhere(user)] } });
    if (!job) throw new NotFoundException('Job not found');
    return this.toDetail(job);
  }

  /** Load a job for an action, enforcing visibility (throws NotFound if not visible). */
  async requireVisible(user: AuthenticatedUser, id: string): Promise<PlatformJob> {
    const job = await this.prisma.platformJob.findFirst({ where: { AND: [{ id }, this.visibilityWhere(user)] } });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  async events(user: AuthenticatedUser, id: string, q: JobEventsQueryDto) {
    if (!(user.permissions ?? []).includes(PERMISSIONS.JOBS_VIEW_EVENTS) && !this.canViewAll(user)) {
      throw new ForbiddenException('Missing permission: jobs.view_events');
    }
    await this.requireVisible(user, id);
    const { skip, take, page, pageSize } = parsePage(q.page, q.pageSize, 50, 200);
    const where: Prisma.PlatformJobEventWhereInput = { jobId: id, ...(q.level ? { level: q.level } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.platformJobEvent.findMany({ where, orderBy: { sequence: 'asc' }, skip, take }),
      this.prisma.platformJobEvent.count({ where }),
    ]);
    return pageOf(rows, total, { skip, take, page, pageSize });
  }

  async children(user: AuthenticatedUser, id: string): Promise<JobListItem[]> {
    await this.requireVisible(user, id);
    const rows = await this.prisma.platformJob.findMany({
      where: { AND: [{ parentJobId: id }, this.visibilityWhere(user)] },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    return rows.map((r) => this.toListItem(r));
  }

  private buildWhere(user: AuthenticatedUser, q: JobListQueryDto): Prisma.PlatformJobWhereInput {
    const and: Prisma.PlatformJobWhereInput[] = [this.visibilityWhere(user)];
    if (q.status) and.push({ status: q.status });
    if (q.active) and.push({ status: { in: [...ACTIVE_STATUSES] } });
    if (q.moduleKey) and.push({ moduleKey: q.moduleKey });
    if (q.workspaceKey) and.push({ workspaceKey: q.workspaceKey });
    if (q.type) and.push({ type: q.type });
    if (q.source) and.push({ sourceType: q.source });
    if (q.createdById) and.push({ createdById: q.createdById });
    if (q.correlationId) and.push({ correlationId: q.correlationId });
    if (q.libraryId) and.push({ libraryId: q.libraryId });
    if (q.resourceId) and.push({ resourceId: q.resourceId });
    if (q.search) {
      const s = q.search;
      and.push({ OR: [{ name: { contains: s, mode: 'insensitive' } }, { type: { contains: s, mode: 'insensitive' } }, { id: s }, { correlationId: s }] });
    }
    return { AND: and };
  }

  private toListItem(r: PlatformJob): JobListItem {
    return {
      id: r.id,
      type: r.type,
      name: r.name,
      moduleKey: r.moduleKey,
      workspaceKey: r.workspaceKey,
      status: r.status as JobStatus,
      phase: r.phase,
      progressPercent: r.progressPercent,
      source: r.sourceType,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      priority: r.priority,
      attempt: r.attempt,
      maxAttempts: r.maxAttempts,
      createdById: r.createdById,
      workerId: r.workerId,
      queuedAt: r.queuedAt,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      capabilities: { cancellable: r.cancellable, pausable: r.pausable, resumable: r.resumable, retryable: r.retryable },
    };
  }

  private toDetail(r: PlatformJob): JobDetail {
    return {
      ...this.toListItem(r),
      description: r.description,
      correlationId: r.correlationId,
      parentJobId: r.parentJobId,
      rootJobId: r.rootJobId,
      scheduleId: r.scheduleId,
      libraryId: r.libraryId,
      mediaItemId: r.mediaItemId,
      progressCurrent: r.progressCurrent,
      progressTotal: r.progressTotal,
      progressUnit: r.progressUnit,
      statusMessageKey: r.statusMessageKey,
      statusMessageParams: r.statusMessageParams,
      scheduledFor: r.scheduledFor,
      heartbeatAt: r.heartbeatAt,
      failedAt: r.failedAt,
      cancelledAt: r.cancelledAt,
      pausedAt: r.pausedAt,
      retryAt: r.retryAt,
      timeoutSeconds: r.timeoutSeconds,
      requiredPermission: r.requiredPermission,
      visibilityScope: r.visibilityScope,
      inputSummary: r.inputSummary, // already redacted at write time
      resultSummary: r.resultSummary,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      warnings: r.warnings,
      metrics: r.metrics,
      metadata: r.metadata,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      // NOTE: inputData and checkpoint are deliberately NOT exposed.
    };
  }
}
