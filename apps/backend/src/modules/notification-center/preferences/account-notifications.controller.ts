import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { AuthenticatedUser, CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { NotificationRecipientEligibilityService } from '../recipient-eligibility.service';
import {
  UserNotificationPreferenceService,
  type PreferencePatch,
  type RouteInput,
} from './user-preference.service';
import { PersonalChannelService } from '../channels/personal-channel.service';
import { NotificationInboxService, type InboxQuery } from '../inbox/inbox.service';
import { NotificationProfileService, type ProfilePatch } from '../schedule/notification-profile.service';
import type { ConnectionBackedChannelType } from '@ultratorrent/shared';

const P = PERMISSIONS;

/**
 * Self-service notification preferences.
 *
 * **Every route derives the acting user from the JWT.** There is deliberately no
 * `:userId` parameter anywhere on this controller — not even an optional one — so
 * there is no shape of request that can address another person's preferences. That
 * is a stronger guarantee than checking ownership on a supplied id, because it
 * cannot be forgotten on a route added later.
 *
 * Eligibility is asserted per request rather than assumed from the token: an account
 * can be deactivated while a session is still alive, and a deactivated account must
 * not keep editing what it will never receive.
 */
@ApiTags('account-notifications')
@ApiBearerAuth()
@Controller('account/notifications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AccountNotificationsController {
  constructor(
    private readonly preferences: UserNotificationPreferenceService,
    private readonly eligibility: NotificationRecipientEligibilityService,
    private readonly channels: PersonalChannelService,
    private readonly inbox: NotificationInboxService,
    private readonly profile: NotificationProfileService,
  ) {}

  // --- profile: timezone, quiet hours, digests, pause ----------------------
  @Get('profile')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  async getProfile(@CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.profile.get(userId);
  }

  @Patch('profile')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_OWN)
  async updateProfile(@Body() body: ProfilePatch, @CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.profile.update(userId, body ?? {});
  }

  @Post('pause')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_OWN)
  async pause(@Body() body: { until?: string }, @CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.profile.pause(userId, body?.until);
  }

  @Post('resume')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_OWN)
  async resume(@CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.profile.resume(userId);
  }

  // --- personal inbox ------------------------------------------------------
  @Get('inbox')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  async listInbox(@Query() q: InboxQuery, @CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.inbox.list(userId, q ?? {});
  }

  // Static before dynamic, so these are not captured as `:notificationId`.
  @Get('inbox/unread-count')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  async unreadCount(@CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.inbox.unreadCount(userId);
  }

  @Post('inbox/mark-all-read')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  async markAllRead(@CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.inbox.markAllRead(userId);
  }

  @Post('inbox/archive-read')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  async archiveRead(@CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.inbox.archiveRead(userId);
  }

  @Post('inbox/:notificationId/read')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  async markRead(@Param('notificationId') id: string, @CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.inbox.setRead(userId, id, true);
  }

  @Post('inbox/:notificationId/unread')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  async markUnread(@Param('notificationId') id: string, @CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.inbox.setRead(userId, id, false);
  }

  @Post('inbox/:notificationId/archive')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  async archiveOne(@Param('notificationId') id: string, @CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.inbox.archive(userId, id);
  }

  // --- personal channel connections ---------------------------------------
  @Get('channels')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  async listChannels(@CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.channels.list(userId);
  }

  @Post('channels')
  @RequirePermissions(P.NOTIFICATIONS_CHANNELS_MANAGE_OWN)
  async createChannel(
    @Body() body: { type: ConnectionBackedChannelType; name?: string; config?: Record<string, unknown> },
    @CurrentUser() u: AuthenticatedUser,
  ) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.channels.create(userId, body);
  }

  // Static before dynamic: `channels/telegram/link` must not be captured by
  // `channels/:channelId`.
  @Post('channels/telegram/link')
  @RequirePermissions(P.NOTIFICATIONS_CHANNELS_MANAGE_OWN)
  async startTelegramLink(@Body() body: { name?: string }, @CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.channels.startTelegramLink(userId, body?.name ?? 'Telegram');
  }

  @Get('channels/:channelId')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  async getChannel(@Param('channelId') channelId: string, @CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.channels.get(userId, channelId);
  }

  @Patch('channels/:channelId')
  @RequirePermissions(P.NOTIFICATIONS_CHANNELS_MANAGE_OWN)
  async renameChannel(
    @Param('channelId') channelId: string,
    @Body() body: { name?: string },
    @CurrentUser() u: AuthenticatedUser,
  ) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.channels.rename(userId, channelId, body?.name ?? '');
  }

  @Delete('channels/:channelId')
  @RequirePermissions(P.NOTIFICATIONS_CHANNELS_MANAGE_OWN)
  async deleteChannel(@Param('channelId') channelId: string, @CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.channels.remove(userId, channelId);
  }

  @Post('channels/:channelId/test')
  @RequirePermissions(P.NOTIFICATIONS_SEND_TEST)
  async testChannel(@Param('channelId') channelId: string, @CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.channels.test(userId, channelId);
  }

  @Post('channels/:channelId/enable')
  @RequirePermissions(P.NOTIFICATIONS_CHANNELS_MANAGE_OWN)
  async enableChannel(@Param('channelId') channelId: string, @CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.channels.setEnabled(userId, channelId, true);
  }

  @Post('channels/:channelId/disable')
  @RequirePermissions(P.NOTIFICATIONS_CHANNELS_MANAGE_OWN)
  async disableChannel(@Param('channelId') channelId: string, @CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.channels.setEnabled(userId, channelId, false);
  }

  @Post('channels/:channelId/default')
  @RequirePermissions(P.NOTIFICATIONS_CHANNELS_MANAGE_OWN)
  async defaultChannel(@Param('channelId') channelId: string, @CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.channels.makeDefault(userId, channelId);
  }

  /** The event matrix: every active event with this user's effective settings. */
  @Get('events')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  async events(@CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.preferences.listEvents(userId);
  }

  // Static routes are declared BEFORE the parameterized ones below: Nest matches in
  // declaration order, so `preferences/bulk` would otherwise be captured by
  // `preferences/:eventKey` with eventKey="bulk".
  @Post('preferences/bulk')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_OWN)
  async bulk(
    @Body() body: { eventKeys?: string[]; action?: Record<string, unknown> },
    @CurrentUser() u: AuthenticatedUser,
  ) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.preferences.bulk(userId, body?.eventKeys ?? [], body?.action as never);
  }

  @Post('preferences/reset')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_OWN)
  async resetAll(@CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.preferences.resetAll(userId);
  }

  @Get('preferences/:eventKey')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  async preference(@Param('eventKey') eventKey: string, @CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.preferences.effectiveFor(userId, eventKey);
  }

  @Put('preferences/:eventKey')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_OWN)
  async setPreference(
    @Param('eventKey') eventKey: string,
    @Body() body: PreferencePatch,
    @CurrentUser() u: AuthenticatedUser,
  ) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.preferences.setPreference(userId, eventKey, body ?? {});
  }

  @Put('preferences/:eventKey/routes')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_OWN)
  async setRoutes(
    @Param('eventKey') eventKey: string,
    @Body() body: { routes?: RouteInput[] },
    @CurrentUser() u: AuthenticatedUser,
  ) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.preferences.setRoutes(userId, eventKey, body?.routes ?? []);
  }

  @Post('preferences/:eventKey/reset')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_OWN)
  async resetEvent(@Param('eventKey') eventKey: string, @CurrentUser() u: AuthenticatedUser) {
    const userId = await this.eligibility.assertEligible(u?.id);
    return this.preferences.resetEvent(userId, eventKey);
  }
}
