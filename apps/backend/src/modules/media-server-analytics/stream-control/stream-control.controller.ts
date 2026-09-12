import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS as P } from '@ultratorrent/shared';
import { AuthenticatedUser, CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { StreamControlSettingsService, StreamControlSettingsPatch } from './stream-control-settings.service';
import { StreamPolicyService, StreamPolicyInput } from './stream-policy.service';
import { StreamEnforcementService } from './stream-enforcement.service';

/**
 * Concurrent Stream Control admin API. Reads are gated on `stream_limits.read` /
 * `enforcement.read`; every mutation on `stream_limits.manage` and is audited.
 */
@ApiTags('media-server-analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('media-server-analytics/stream-control')
export class StreamControlController {
  constructor(
    private readonly settings: StreamControlSettingsService,
    private readonly policy: StreamPolicyService,
    private readonly enforcement: StreamEnforcementService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private ctx(user: AuthenticatedUser, req: Request) {
    return { userId: user.id, ipAddress: req.ip ?? undefined, userAgent: req.headers['user-agent'] ?? undefined };
  }

  @Get('settings')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_STREAM_LIMITS_READ)
  getSettings() {
    return this.settings.read();
  }

  @Patch('settings')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_STREAM_LIMITS_MANAGE)
  async updateSettings(@Body() body: StreamControlSettingsPatch, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const next = await this.settings.update(body ?? {});
    await this.audit.record({ ...this.ctx(user, req), action: 'media_server_analytics.stream_settings.updated', objectType: 'stream_control_settings', metadata: { ...next } });
    return next;
  }

  /** The Stream Limits roster — only viewers an admin has configured (override,
   * exemption, or link), with their live count. Not a list of every viewer. */
  @Get('policies')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_STREAM_LIMITS_READ)
  async policies() {
    const [subjects, status] = await Promise.all([this.policy.listConfiguredSubjects(), this.enforcement.status()]);
    const live = new Map(status.subjects.map((s) => [s.mediaAnalyticsUserId, s]));
    return subjects.map((subj) => ({
      mediaAnalyticsUserId: subj.id,
      kind: subj.kind,
      providerUserId: subj.providerUserId,
      displayName: subj.displayName,
      exemptFromLimits: subj.exemptFromLimits,
      groupId: subj.groupId,
      policy: subj.policy,
      activeStreams: live.get(subj.id)?.activeStreams ?? 0,
      limit: live.get(subj.id)?.limit ?? null,
      overLimit: live.get(subj.id)?.overLimit ?? false,
    }));
  }

  /** Viewers the admin can add an override for (known, not yet configured). */
  @Get('candidates')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_STREAM_LIMITS_READ)
  candidates() {
    return this.policy.candidates();
  }

  /** Add an override for a viewer picked from the candidate list. Resolves (and
   * only now creates) the canonical subject, then applies the override/exemption. */
  @Post('policies')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_STREAM_LIMITS_MANAGE)
  async addPolicy(
    @Body() body: StreamPolicyInput & { kind: string; providerUserId: string; displayName?: string; exempt?: boolean },
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const subject = await this.policy.resolveSubject(body?.kind, body?.providerUserId, body?.displayName);
    if (!subject) throw new BadRequestException('Unknown viewer — pick one from the candidate list.');
    if (body.exempt) await this.policy.setExempt(subject.id, true);
    else await this.policy.putUserPolicy(subject.id, body);
    await this.audit.record({ ...this.ctx(user, req), action: 'media_server_analytics.stream_policy.updated', objectType: 'media_stream_policy', objectId: subject.id, metadata: { added: true, exempt: !!body.exempt, maxConcurrentStreams: body.maxConcurrentStreams } });
    return { mediaAnalyticsUserId: subject.id };
  }

  /** Link two or more subjects as one person (cross-product identity). */
  @Post('link')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_STREAM_LIMITS_MANAGE)
  async link(@Body() body: { mediaUserIds?: string[] }, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const groupId = await this.policy.linkSubjects(body?.mediaUserIds ?? []);
    await this.audit.record({ ...this.ctx(user, req), action: 'media_server_analytics.stream_identity.linked', objectType: 'media_analytics_user', metadata: { mediaUserIds: body?.mediaUserIds, groupId } });
    return { groupId };
  }

  /** Remove a subject from its link group. */
  @Post('policies/:mediaUserId/unlink')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_STREAM_LIMITS_MANAGE)
  async unlink(@Param('mediaUserId') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    await this.policy.unlinkSubject(id);
    await this.audit.record({ ...this.ctx(user, req), action: 'media_server_analytics.stream_identity.unlinked', objectType: 'media_analytics_user', objectId: id });
    return { ok: true };
  }

  @Get('policies/:mediaUserId')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_STREAM_LIMITS_READ)
  getPolicy(@Param('mediaUserId') id: string) {
    return this.policy.subject(id);
  }

  @Put('policies/:mediaUserId')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_STREAM_LIMITS_MANAGE)
  async putPolicy(@Param('mediaUserId') id: string, @Body() body: StreamPolicyInput, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const row = await this.policy.putUserPolicy(id, body ?? {});
    await this.audit.record({ ...this.ctx(user, req), action: 'media_server_analytics.stream_policy.updated', objectType: 'media_stream_policy', objectId: id, metadata: { maxConcurrentStreams: row.maxConcurrentStreams, action: row.enforcementAction, scope: row.scope } });
    return row;
  }

  @Patch('policies/:mediaUserId/exempt')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_STREAM_LIMITS_MANAGE)
  async setExempt(@Param('mediaUserId') id: string, @Body() body: { exempt?: boolean }, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const subject = await this.policy.setExempt(id, !!body?.exempt);
    await this.audit.record({ ...this.ctx(user, req), action: 'media_server_analytics.stream_policy.exempt_changed', objectType: 'media_analytics_user', objectId: id, metadata: { exempt: !!body?.exempt } });
    return subject;
  }

  @Delete('policies/:mediaUserId')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_STREAM_LIMITS_MANAGE)
  async deletePolicy(@Param('mediaUserId') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    await this.policy.deleteUserPolicy(id);
    await this.audit.record({ ...this.ctx(user, req), action: 'media_server_analytics.stream_policy.deleted', objectType: 'media_stream_policy', objectId: id });
    return { ok: true };
  }

  @Get('status')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_ENFORCEMENT_READ)
  status() {
    return this.enforcement.status();
  }

  /** Enforcement history, newest first, with optional filters. */
  @Get('events')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_ENFORCEMENT_READ)
  async events(@Query() q: Record<string, string>) {
    const take = Math.min(200, Math.max(1, Number.parseInt(q.pageSize ?? '50', 10) || 50));
    const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
    const where: Record<string, unknown> = {};
    if (q.mediaUserId) where.mediaAnalyticsUserId = q.mediaUserId;
    if (q.mediaServerId) where.mediaServerId = q.mediaServerId;
    if (q.provider) where.provider = q.provider;
    if (q.action) where.action = q.action;
    if (q.result) where.result = q.result;
    if (q.from || q.to) {
      where.detectedAt = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }
    const [rows, total] = await Promise.all([
      this.prisma.mediaStreamEnforcementEvent.findMany({ where, orderBy: { detectedAt: 'desc' }, skip: (page - 1) * take, take }),
      this.prisma.mediaStreamEnforcementEvent.count({ where }),
    ]);
    // The event stores the subject's id, not a name. Resolve the canonical
    // display name so the history shows WHO was enforced (falling back to the raw
    // provider user id when there is no linked subject).
    const userIds = [...new Set(rows.map((r) => r.mediaAnalyticsUserId).filter((id): id is string => Boolean(id)))];
    const users = userIds.length
      ? await this.prisma.mediaAnalyticsUser.findMany({
          where: { id: { in: userIds } },
          select: { id: true, displayName: true, providerUserId: true },
        })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.displayName ?? u.providerUserId]));
    const items = rows.map((r) => ({
      ...r,
      displayName: (r.mediaAnalyticsUserId ? nameById.get(r.mediaAnalyticsUserId) : null) ?? r.providerUserId ?? null,
    }));
    return { items, total, page, pageSize: take };
  }
}
