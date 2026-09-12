import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS as P } from '@ultratorrent/shared';
import { AuthenticatedUser, CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { AuditService } from '../../audit/audit.service';
import { HouseholdService } from './household.service';
import { HouseholdQueryService } from './household-query.service';
import { HouseholdSettingsService, HouseholdSettingsPatch } from './household-settings.service';

/**
 * Household & Sharing admin API. Reads gate on `household.read`; review dispositions
 * on `household.review`; home/network config on `household.manage`. Every mutation is
 * audited. NOTHING here terminates a stream — Stream Control is the only enforcer.
 */
@ApiTags('media-server-analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('media-server-analytics/household')
export class HouseholdController {
  constructor(
    private readonly household: HouseholdService,
    private readonly query: HouseholdQueryService,
    private readonly settings: HouseholdSettingsService,
    private readonly audit: AuditService,
  ) {}

  private ctx(user: AuthenticatedUser, req: Request) {
    return { userId: user.id, ipAddress: req.ip ?? undefined, userAgent: req.headers['user-agent'] ?? undefined };
  }
  private log(user: AuthenticatedUser, req: Request, action: string, objectId?: string, metadata?: Record<string, unknown>) {
    return this.audit.record({ ...this.ctx(user, req), action: `media_server_analytics.household.${action}`, objectType: 'media_household', objectId, metadata });
  }

  @Get('overview')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_READ)
  overview() { return this.query.overview(); }

  @Get('users')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_READ)
  users(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.query.users(Number.parseInt(page ?? '1', 10) || 1, Number.parseInt(pageSize ?? '50', 10) || 50);
  }

  @Get('users/:id')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_READ)
  user(@Param('id') id: string) { return this.query.user(id); }

  @Get('reviews')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_READ)
  reviews(@Query('status') status?: string, @Query('riskLevel') riskLevel?: string) {
    return this.query.reviews({ status, riskLevel });
  }

  @Get('networks')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_READ)
  networks() { return this.query.networks(); }

  @Get('networks/:fingerprint/users')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_READ)
  networkUsers(@Param('fingerprint') fingerprint: string) { return this.query.networkUsers(fingerprint); }

  @Get('settings')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_READ)
  getSettings() { return this.settings.read(); }

  @Put('settings')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_MANAGE)
  async updateSettings(@Body() body: HouseholdSettingsPatch, @CurrentUser() u: AuthenticatedUser, @Req() r: Request) {
    const next = await this.settings.update(body ?? {});
    await this.log(u, r, 'settings_updated', undefined, { ...next });
    return next;
  }

  // --- Home control (manage) ------------------------------------------------
  @Post('users/:id/set-home')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_MANAGE)
  async setHome(@Param('id') id: string, @Body() body: { networkId: string }, @CurrentUser() u: AuthenticatedUser, @Req() r: Request) {
    await this.household.setHome(id, body.networkId);
    await this.log(u, r, 'home_set', id, { networkId: body.networkId });
    return { ok: true };
  }
  @Post('users/:id/lock-home')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_MANAGE)
  async lockHome(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser, @Req() r: Request) {
    await this.household.lockHome(id, true); await this.log(u, r, 'home_locked', id); return { ok: true };
  }
  @Post('users/:id/unlock-home')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_MANAGE)
  async unlockHome(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser, @Req() r: Request) {
    await this.household.lockHome(id, false); await this.log(u, r, 'home_unlocked', id); return { ok: true };
  }
  @Post('users/:id/relearn')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_MANAGE)
  async relearn(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser, @Req() r: Request) {
    await this.household.relearnHome(id); await this.log(u, r, 'home_relearn', id); return { ok: true };
  }
  @Post('users/:id/evaluate')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_MANAGE)
  async evaluate(@Param('id') id: string) { return (await this.query.user(id)) ? this.query.evaluateNow((await this.query.user(id))!.subjectKey) : { ok: false }; }
  @Post('users/:id/note')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_MANAGE)
  async note(@Param('id') id: string, @Body() body: { notes: string }, @CurrentUser() u: AuthenticatedUser, @Req() r: Request) {
    await this.household.addNote(id, body?.notes ?? ''); await this.log(u, r, 'note_added', id); return { ok: true };
  }

  // --- Network control (manage) ---------------------------------------------
  @Post('networks/:id/trust')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_MANAGE)
  async trust(@Param('id') id: string, @Body() body: { trusted?: boolean }, @CurrentUser() u: AuthenticatedUser, @Req() r: Request) {
    await this.household.trustNetwork(id, body?.trusted ?? true); await this.log(u, r, 'network_trusted', id, { trusted: body?.trusted ?? true }); return { ok: true };
  }
  @Post('networks/:id/ignore')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_MANAGE)
  async ignore(@Param('id') id: string, @Body() body: { ignored?: boolean }, @CurrentUser() u: AuthenticatedUser, @Req() r: Request) {
    await this.household.ignoreNetwork(id, body?.ignored ?? true); await this.log(u, r, 'network_ignored', id, { ignored: body?.ignored ?? true }); return { ok: true };
  }
  @Post('networks/:id/classification')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_MANAGE)
  async classify(@Param('id') id: string, @Body() body: { networkType: string }, @CurrentUser() u: AuthenticatedUser, @Req() r: Request) {
    await this.household.classifyNetwork(id, body.networkType); await this.log(u, r, 'network_classified', id, { networkType: body.networkType }); return { ok: true };
  }
  @Post('networks/:id/disposition')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_MANAGE)
  async disposition(@Param('id') id: string, @Body() body: { disposition: 'travel' | 'mobile' | null }, @CurrentUser() u: AuthenticatedUser, @Req() r: Request) {
    await this.household.dispositionNetwork(id, body?.disposition ?? null); await this.log(u, r, 'network_disposition', id, { disposition: body?.disposition ?? null }); return { ok: true };
  }

  // --- Review disposition (review) ------------------------------------------
  @Post('reviews/:id/disposition')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_HOUSEHOLD_REVIEW)
  async reviewDisposition(@Param('id') id: string, @Body() body: { status: string; notes?: string }, @CurrentUser() u: AuthenticatedUser, @Req() r: Request) {
    await this.household.reviewDisposition(id, body.status, u.id, body?.notes);
    await this.log(u, r, 'review_disposition', id, { status: body.status });
    return { ok: true };
  }
}
