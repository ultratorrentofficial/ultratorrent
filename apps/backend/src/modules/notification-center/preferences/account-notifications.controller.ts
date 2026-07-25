import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
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
  ) {}

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
