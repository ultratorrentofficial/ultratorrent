import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { NotificationRecipientEligibilityService } from './recipient-eligibility.service';
import { NotificationPreferenceService, type PreferencePatch } from './notification-preference.service';
import { NotificationInboxService, type InboxQuery } from './notification-inbox.service';
import { allNotificationEvents } from './notification-catalog';

const P = PERMISSIONS;

/**
 * Self-service notifications.
 *
 * **No route on this controller takes a user id.** Not even an optional one —
 * the acting user always comes from the JWT. That is a stronger guarantee than
 * checking ownership against a supplied id, because it cannot be forgotten on a
 * route someone adds later.
 *
 * Eligibility is asserted per request rather than trusted from the token: an
 * account can be deactivated while a session is still alive, and a deactivated
 * account must not keep editing preferences for notifications it will never get.
 */
@ApiTags('account-notifications')
@ApiBearerAuth()
@Controller('account/notifications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AccountNotificationsController {
  constructor(
    private readonly eligibility: NotificationRecipientEligibilityService,
    private readonly preferences: NotificationPreferenceService,
    private readonly inbox: NotificationInboxService,
  ) {}

  // --- events + preferences -------------------------------------------------

  /** The catalogue alone — what events exist, for rendering the table headers. */
  @Get('events')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  listEvents() {
    return { events: allNotificationEvents() };
  }

  /** The Events table: every event with this user's answer. */
  @Get('preferences')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  async listPreferences(@CurrentUser() u: AuthenticatedUser) {
    await this.eligibility.assertEligible(u.id);
    return { rows: await this.preferences.listFor(u.id) };
  }

  @Put('preferences/:eventKey')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_OWN)
  async updatePreference(
    @CurrentUser() u: AuthenticatedUser,
    @Param('eventKey') eventKey: string,
    @Body() body: PreferencePatch,
  ) {
    await this.eligibility.assertEligible(u.id);
    return this.preferences.update(u.id, eventKey, body ?? {});
  }

  @Post('preferences/bulk')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_OWN)
  async bulkUpdate(
    @CurrentUser() u: AuthenticatedUser,
    @Body() body: { eventKeys?: string[]; patch?: PreferencePatch },
  ) {
    await this.eligibility.assertEligible(u.id);
    return this.preferences.updateMany(u.id, body?.eventKeys ?? [], body?.patch ?? {});
  }

  // --- inbox ----------------------------------------------------------------
  // Static routes are declared before dynamic ones so `/inbox/unread-count` is
  // never captured by `/inbox/:id`.

  @Get('inbox')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  listInbox(@CurrentUser() u: AuthenticatedUser, @Query() q: InboxQuery) {
    return this.inbox.list(u.id, q ?? {});
  }

  @Get('inbox/unread-count')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  unreadCount(@CurrentUser() u: AuthenticatedUser) {
    return this.inbox.unreadCount(u.id);
  }

  @Post('inbox/mark-all-read')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_OWN)
  markAllRead(@CurrentUser() u: AuthenticatedUser) {
    return this.inbox.markAllRead(u.id);
  }

  @Post('inbox/:id/read')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_OWN)
  markRead(@CurrentUser() u: AuthenticatedUser, @Param('id') id: string) {
    return this.inbox.setRead(u.id, id, true);
  }

  @Post('inbox/:id/unread')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_OWN)
  markUnread(@CurrentUser() u: AuthenticatedUser, @Param('id') id: string) {
    return this.inbox.setRead(u.id, id, false);
  }

  @Post('inbox/:id/archive')
  @RequirePermissions(P.NOTIFICATIONS_MANAGE_OWN)
  archive(@CurrentUser() u: AuthenticatedUser, @Param('id') id: string) {
    return this.inbox.archive(u.id, id);
  }
}
