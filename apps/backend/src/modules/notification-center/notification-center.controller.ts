import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { NotificationChannelService } from './channel.service';
import { NotificationRecipientService } from './recipient.service';
import { RecipientProvisioningService } from './recipient-provisioning.service';
import { NotificationAdminService } from './notification-admin.service';
import { NotificationDeliveryService } from './delivery.service';

const P = PERMISSIONS;

/**
 * Notification Center API (supersedes the legacy `/api/notifications` surface).
 * Core module, RBAC-gated per-route. Secrets are always redacted in responses.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class NotificationCenterController {
  constructor(
    private readonly channels: NotificationChannelService,
    private readonly recipients: NotificationRecipientService,
    private readonly admin: NotificationAdminService,
    private readonly delivery: NotificationDeliveryService,
    private readonly provisioning: RecipientProvisioningService,
  ) {}

  // --- dashboard + providers ----------------------------------------------
  @Get('dashboard')
  @RequirePermissions(P.NOTIFICATIONS_VIEW)
  dashboard() {
    return this.admin.dashboard();
  }

  @Get('providers')
  @RequirePermissions(P.NOTIFICATIONS_VIEW)
  providers() {
    return this.channels.providers();
  }

  // --- channels ------------------------------------------------------------
  @Get('channels')
  @RequirePermissions(P.NOTIFICATIONS_VIEW)
  listChannels() {
    return this.channels.list();
  }
  @Post('channels')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_CHANNELS)
  createChannel(@Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.channels.create(body ?? {}, u?.id);
  }
  @Get('channels/:id')
  @RequirePermissions(P.NOTIFICATIONS_VIEW)
  getChannel(@Param('id') id: string) {
    return this.channels.get(id);
  }
  @Patch('channels/:id')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_CHANNELS)
  updateChannel(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.channels.update(id, body ?? {}, u?.id);
  }
  @Delete('channels/:id')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_CHANNELS)
  deleteChannel(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.channels.remove(id, u?.id);
  }
  @Post('channels/:id/test')
  @RequirePermissions(P.NOTIFICATIONS_SEND_TEST)
  testChannel(@Param('id') id: string) {
    return this.channels.testConnection(id);
  }

  // --- recipients ----------------------------------------------------------
  @Get('recipients')
  @RequirePermissions(P.NOTIFICATIONS_VIEW)
  listRecipients() {
    return this.recipients.listRecipients();
  }
  @Post('recipients')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_RECIPIENTS)
  createRecipient(@Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.recipients.createRecipient(body ?? {}, u?.id);
  }
  @Patch('recipients/:id')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_RECIPIENTS)
  updateRecipient(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.recipients.updateRecipient(id, body ?? {}, u?.id);
  }
  @Delete('recipients/:id')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_RECIPIENTS)
  deleteRecipient(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.recipients.removeRecipient(id, u?.id);
  }

  // --- groups --------------------------------------------------------------
  @Get('groups')
  @RequirePermissions(P.NOTIFICATIONS_VIEW)
  listGroups() {
    return this.recipients.listGroups();
  }
  @Post('groups')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_GROUPS)
  createGroup(@Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.recipients.createGroup(body ?? {}, u?.id);
  }
  @Delete('groups/:id')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_GROUPS)
  deleteGroup(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.recipients.removeGroup(id, u?.id);
  }
  @Put('groups/:id/members')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_GROUPS)
  setGroupMembers(@Param('id') id: string, @Body() body: { recipientIds?: string[] }, @CurrentUser() u: AuthenticatedUser) {
    return this.recipients.setGroupMembers(id, body?.recipientIds ?? [], u?.id);
  }

  // --- templates -----------------------------------------------------------
  @Get('templates')
  @RequirePermissions(P.NOTIFICATIONS_VIEW)
  listTemplates() {
    return this.admin.listTemplates();
  }
  @Post('templates')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_TEMPLATES)
  createTemplate(@Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.admin.createTemplate(body ?? {}, u?.id);
  }
  @Patch('templates/:id')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_TEMPLATES)
  updateTemplate(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.admin.updateTemplate(id, body ?? {}, u?.id);
  }
  @Delete('templates/:id')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_TEMPLATES)
  deleteTemplate(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.admin.removeTemplate(id, u?.id);
  }
  @Post('templates/preview')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_TEMPLATES)
  previewTemplate(@Body() body: Record<string, never>) {
    return this.admin.previewTemplate(body ?? {});
  }

  // --- rules ---------------------------------------------------------------
  @Get('rules')
  @RequirePermissions(P.NOTIFICATIONS_VIEW)
  listRules() {
    return this.admin.listRules();
  }
  @Get('rules/:id')
  @RequirePermissions(P.NOTIFICATIONS_VIEW)
  getRule(@Param('id') id: string) {
    return this.admin.getRule(id);
  }
  @Post('rules')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_RULES)
  createRule(@Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.admin.createRule(body ?? {}, u?.id);
  }
  @Patch('rules/:id')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_RULES)
  updateRule(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.admin.updateRule(id, body ?? {}, u?.id);
  }
  @Delete('rules/:id')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_RULES)
  deleteRule(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.admin.removeRule(id, u?.id);
  }

  // --- history + queue -----------------------------------------------------
  @Get('history')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_HISTORY)
  history(@Query() q: { page?: string; pageSize?: string; status?: string; channelId?: string; event?: string }) {
    return this.admin.history(q ?? {});
  }
  @Get('queue')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_HISTORY)
  queue(@Query() q: { page?: string; pageSize?: string }) {
    return this.admin.queue(q ?? {});
  }
  @Post('history/:id/retry')
  @RequirePermissions(P.NOTIFICATIONS_RETRY)
  retry(@Param('id') id: string) {
    return this.delivery.retry(id);
  }

  // --- preferences ---------------------------------------------------------
  @Get('preferences/:recipientId')
  @RequirePermissions(P.NOTIFICATIONS_VIEW)
  preferences(@Param('recipientId') recipientId: string) {
    return this.admin.listPreferences(recipientId);
  }
  @Put('preferences')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_PREFERENCES)
  setPreference(@Body() body: { recipientId: string; event: string; channel?: string | null; enabled: boolean }, @CurrentUser() u: AuthenticatedUser) {
    return this.admin.setPreference(body, u?.id);
  }

  // --- routing profiles ----------------------------------------------------
  @Get('routing/:recipientId')
  @RequirePermissions(P.NOTIFICATIONS_VIEW)
  routing(@Param('recipientId') recipientId: string) {
    return this.admin.listRouting(recipientId);
  }
  @Put('routing')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_PREFERENCES)
  setRouting(@Body() body: { recipientId: string; event: string; channelIds: string[] }, @CurrentUser() u: AuthenticatedUser) {
    return this.admin.setRouting(body, u?.id);
  }
  @Post('recipients/reconcile')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_RECIPIENTS)
  reconcileRecipients() {
    return this.provisioning.reconcile();
  }

  // --- settings ------------------------------------------------------------
  @Get('settings')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_SETTINGS)
  getSettings() {
    return this.admin.getSettings();
  }
  @Patch('settings')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_SETTINGS)
  updateSettings(@Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.admin.updateSettings(body ?? {}, u?.id);
  }

  // --- manual test send ----------------------------------------------------
  @Post('test')
  @RequirePermissions(P.NOTIFICATIONS_SEND_TEST)
  test(@Body() body: { channelId: string; recipientId?: string; address?: never; templateId?: string; variables?: never }, @CurrentUser() u: AuthenticatedUser) {
    return this.admin.testSend(body, u?.id);
  }
}
