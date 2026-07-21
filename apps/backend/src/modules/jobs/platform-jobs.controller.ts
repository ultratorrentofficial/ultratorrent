import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { PlatformJob } from '@prisma/client';
import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';
import { PlatformJobsQueryService } from './platform/platform-jobs-query.service';
import { PlatformJobService } from './platform/platform-job.service';
import { PlatformSchedulesService } from './platform/platform-schedules.service';
import { PlatformWorkersService } from './platform/platform-workers.service';
import { JobRegistry } from './platform/job-registry.service';
import { JobListQueryDto, JobEventsQueryDto, BulkJobActionDto } from './dto/job-query.dto';
import { PROGRESS_THROTTLE_MS, STALL_THRESHOLD_MS, STALL_SCAN_INTERVAL_MS, DEFAULT_MAX_ATTEMPTS } from './platform/job-constants';

type JobAction = 'cancel' | 'pause' | 'resume' | 'retry' | 'rerun';

/**
 * The Unified Jobs Center REST surface (`/api/jobs/*`), reading the normalized
 * `platform_jobs` model. Coexists with the legacy read-only aggregator (`GET /api/jobs`,
 * still serving the workspace widgets until producer migration completes). Every route
 * is authenticated + RBAC-gated; visibility is enforced per-job in the query service,
 * and actions additionally require the job's own permission — a user can never cancel/
 * retry a job they could not have initiated. Actions are audited.
 */
@ApiTags('jobs-center')
@ApiBearerAuth()
@Controller('jobs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PlatformJobsController {
  constructor(
    private readonly query: PlatformJobsQueryService,
    private readonly jobs: PlatformJobService,
    private readonly registry: JobRegistry,
    private readonly schedules: PlatformSchedulesService,
    private readonly workers: PlatformWorkersService,
    private readonly audit: AuditService,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────
  @Get('overview')
  @RequirePermissions(PERMISSIONS.JOBS_VIEW)
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.query.overview(user);
  }

  @Get('catalog')
  @RequirePermissions(PERMISSIONS.JOBS_VIEW)
  catalog() {
    // Registered job-type metadata only (no handlers) — safe to expose.
    return this.registry.list().map((d) => ({
      type: d.type,
      moduleKey: d.moduleKey,
      workspaceKey: d.workspaceKey,
      labelKey: d.labelKey,
      descriptionKey: d.descriptionKey,
      requiredPermission: d.requiredPermission,
      capabilities: d.capabilities,
    }));
  }

  @Get('list')
  @RequirePermissions(PERMISSIONS.JOBS_VIEW)
  list(@CurrentUser() user: AuthenticatedUser, @Query() q: JobListQueryDto) {
    return this.query.list(user, q);
  }

  // ── Schedules / Workers / Settings (read-only, honest) — before :id ─────────
  @Get('schedules')
  @RequirePermissions(PERMISSIONS.JOBS_VIEW)
  scheduleList() {
    return this.schedules.list();
  }

  @Get('workers')
  @RequirePermissions(PERMISSIONS.JOBS_VIEW_WORKERS)
  workerList() {
    return this.workers.list();
  }

  @Get('settings')
  @RequirePermissions(PERMISSIONS.JOBS_MANAGE_SETTINGS)
  settings() {
    // The actual runtime tuning values (single source: job-constants). Read-only —
    // these are fixed today; the surface reports what the engine truly uses.
    return {
      progressThrottleMs: PROGRESS_THROTTLE_MS,
      stallThresholdMs: STALL_THRESHOLD_MS,
      stallScanIntervalMs: STALL_SCAN_INTERVAL_MS,
      defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
      editable: false,
    };
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.JOBS_VIEW)
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.query.get(user, id);
  }

  @Get(':id/events')
  @RequirePermissions(PERMISSIONS.JOBS_VIEW)
  events(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Query() q: JobEventsQueryDto) {
    return this.query.events(user, id, q);
  }

  @Get(':id/children')
  @RequirePermissions(PERMISSIONS.JOBS_VIEW)
  children(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.query.children(user, id);
  }

  // ── Bulk (declared BEFORE :id routes so "bulk" isn't captured as an :id) ─────
  @Post('bulk/cancel')
  @RequirePermissions(PERMISSIONS.JOBS_BULK_MANAGE, PERMISSIONS.JOBS_CANCEL)
  bulkCancel(@CurrentUser() user: AuthenticatedUser, @Body() body: BulkJobActionDto, @Req() req: Request) {
    return this.bulk(user, body.jobIds, 'cancel', req);
  }

  @Post('bulk/retry')
  @RequirePermissions(PERMISSIONS.JOBS_BULK_MANAGE, PERMISSIONS.JOBS_RETRY)
  bulkRetry(@CurrentUser() user: AuthenticatedUser, @Body() body: BulkJobActionDto, @Req() req: Request) {
    return this.bulk(user, body.jobIds, 'retry', req);
  }

  @Post('bulk/rerun')
  @RequirePermissions(PERMISSIONS.JOBS_BULK_MANAGE, PERMISSIONS.JOBS_RERUN)
  bulkRerun(@CurrentUser() user: AuthenticatedUser, @Body() body: BulkJobActionDto, @Req() req: Request) {
    return this.bulk(user, body.jobIds, 'rerun', req);
  }

  // ── Single-job actions ──────────────────────────────────────────────────────
  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.JOBS_CANCEL)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Req() req: Request) {
    return this.act(user, id, 'cancel', req);
  }

  @Post(':id/pause')
  @RequirePermissions(PERMISSIONS.JOBS_PAUSE)
  pause(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Req() req: Request) {
    return this.act(user, id, 'pause', req);
  }

  @Post(':id/resume')
  @RequirePermissions(PERMISSIONS.JOBS_RESUME)
  resume(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Req() req: Request) {
    return this.act(user, id, 'resume', req);
  }

  @Post(':id/retry')
  @RequirePermissions(PERMISSIONS.JOBS_RETRY)
  retry(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Req() req: Request) {
    return this.act(user, id, 'retry', req);
  }

  @Post(':id/rerun')
  @RequirePermissions(PERMISSIONS.JOBS_RERUN)
  rerun(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Req() req: Request) {
    return this.act(user, id, 'rerun', req);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** A user may only act on a job whose own required permission they also hold. */
  private assertUnderlyingPermission(user: AuthenticatedUser, job: PlatformJob): void {
    if (user.roles?.includes(SystemRole.SUPER_ADMIN)) return;
    if (!job.requiredPermission) return;
    if (!(user.permissions ?? []).includes(job.requiredPermission)) {
      throw new ForbiddenException(`This job requires ${job.requiredPermission}`);
    }
  }

  private async runAction(job: PlatformJob, action: JobAction): Promise<{ ok: boolean; jobId?: string; reason?: string }> {
    switch (action) {
      case 'cancel': {
        if (!job.cancellable) return { ok: false, reason: 'not_cancellable' };
        return { ok: await this.jobs.requestCancel(job.id) };
      }
      case 'pause': {
        if (!job.pausable) return { ok: false, reason: 'not_pausable' };
        return { ok: await this.jobs.requestPause(job.id) };
      }
      case 'resume': {
        const r = await this.jobs.resume(job.id);
        return r ? { ok: true, jobId: r.jobId } : { ok: false, reason: 'not_resumable' };
      }
      case 'retry': {
        if (!job.retryable) return { ok: false, reason: 'not_retryable' };
        const r = await this.jobs.retry(job.id);
        return r ? { ok: true, jobId: r.jobId } : { ok: false, reason: 'not_failed' };
      }
      case 'rerun': {
        const r = await this.jobs.rerun(job.id, job.createdById ?? undefined);
        return { ok: true, jobId: r.jobId };
      }
    }
  }

  private async act(user: AuthenticatedUser, id: string, action: JobAction, req: Request) {
    const job = await this.query.requireVisible(user, id);
    this.assertUnderlyingPermission(user, job);
    const result = await this.runAction(job, action);
    if (!result.ok && result.reason === 'not_cancellable') throw new BadRequestException(result.reason);
    await this.audit.record({
      userId: user.id,
      action: `jobs.${action}`,
      objectType: 'platform_job',
      objectId: id,
      result: result.ok ? 'success' : 'failure',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { type: job.type, reason: result.reason, newJobId: result.jobId },
    });
    return result;
  }

  private async bulk(user: AuthenticatedUser, jobIds: string[], action: JobAction, req: Request) {
    const succeeded: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const id of [...new Set(jobIds)]) {
      try {
        const job = await this.query.requireVisible(user, id);
        this.assertUnderlyingPermission(user, job);
        const r = await this.runAction(job, action);
        if (r.ok) succeeded.push(id);
        else failed.push({ id, reason: r.reason ?? 'failed' });
      } catch (e) {
        failed.push({ id, reason: e instanceof ForbiddenException ? 'forbidden' : 'not_found' });
      }
    }
    await this.audit.record({
      userId: user.id,
      action: `jobs.bulk_${action}`,
      objectType: 'platform_job',
      result: failed.length === 0 ? 'success' : 'failure',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { requested: jobIds.length, succeeded: succeeded.length, failed: failed.length },
    });
    // BulkResult-compatible envelope (mirrors the files bulk pattern).
    return { total: jobIds.length, succeeded, failed, level: failed.length === 0 ? 'success' : succeeded.length > 0 ? 'partial' : 'failed' };
  }
}
