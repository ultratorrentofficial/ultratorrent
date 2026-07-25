import {
  BadRequestException, Body, Controller, Delete, Get, NotFoundException,
  Param, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { NotificationRecipientEligibilityService } from './recipient-eligibility.service';
import { NotificationPreferenceService, type PreferencePatch } from './notification-preference.service';
import { NotificationInboxService, type InboxQuery } from './notification-inbox.service';
import { NotificationChannelService } from './channels/notification-channel.service';
import { MailTransportService } from '../../infrastructure/mail/mail-transport.service';
import { TelegramTransportService } from '../../infrastructure/telegram/telegram-transport.service';
import { TelegramLinkingService } from './channels/telegram-linking.service';
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
    private readonly channels: NotificationChannelService,
    private readonly mail: MailTransportService,
    private readonly telegram: TelegramTransportService,
    private readonly linking: TelegramLinkingService,
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


  // --- channels -------------------------------------------------------------

  /**
   * The caller's connections.
   *
   * Returns masks and health, never a destination. `platformEmailReady` tells
   * the UI whether the shared SMTP relay is configured at all, so it can explain
   * *why* email is unavailable instead of failing at test time.
   */
  @Get('channels')
  @RequirePermissions(P.NOTIFICATIONS_VIEW_OWN)
  async listChannels(@CurrentUser() u: AuthenticatedUser) {
    await this.eligibility.assertEligible(u.id);
    return {
      channels: await this.channels.list(u.id),
      platformEmailReady: await this.mail.isConfigured(),
      telegram: await this.telegram.getSettings(),
    };
  }

  /**
   * Start Telegram linking: issue a one-time code.
   *
   * The code is returned exactly once and stored only as a hash. There is
   * deliberately no endpoint that accepts a chat id — a chat id is guessable and
   * unauthenticated, so accepting one would let anyone point another person's
   * notifications at their own chat.
   */
  @Post('channels/telegram/link')
  @RequirePermissions(P.NOTIFICATIONS_CHANNELS_MANAGE_OWN)
  async linkTelegram(@CurrentUser() u: AuthenticatedUser) {
    await this.eligibility.assertEligible(u.id);
    const settings = await this.telegram.getSettings();
    if (!settings.configured) {
      throw new BadRequestException('Telegram is not configured on this server yet.');
    }
    const { code, expiresInSeconds } = this.linking.issueCode(u.id);
    return { code, expiresInSeconds, botUsername: settings.botUsername };
  }

  /**
   * Finish linking: look for the code among the bot's recent messages.
   *
   * Polled here rather than by a background worker — linking is user-initiated
   * and happens once per person, so a permanent poller would hold a connection
   * open for a feature nobody uses twice.
   */
  @Post('channels/telegram/confirm')
  @RequirePermissions(P.NOTIFICATIONS_CHANNELS_MANAGE_OWN)
  async confirmTelegram(@CurrentUser() u: AuthenticatedUser) {
    await this.eligibility.assertEligible(u.id);

    const updates = await this.telegram.getUpdates(this.linking.offset);
    const matched = this.linking.redeem(u.id, updates);
    if (!matched) {
      throw new NotFoundException('No code received yet. Send the code to the bot, then try again.');
    }

    const view = await this.channels.connectTelegram(u.id, matched.chatId, matched.username);
    // Redeeming the code already proved chat control, so this confirms rather
    // than verifies — but a greeting tells the user it worked.
    await this.telegram
      .sendMessage(matched.chatId, '✅ <b>UltraTorrent</b> is now linked to this chat.')
      .catch(() => undefined);
    return view;
  }

  /**
   * Point email at an address, then immediately prove it works.
   *
   * Connect-and-verify is one call on purpose: an address stored but never
   * tested is the failure mode where a user believes they are covered and is
   * not. A send failure leaves the connection unverified, so nothing is
   * delivered to it.
   */
  @Post('channels/email')
  @RequirePermissions(P.NOTIFICATIONS_CHANNELS_MANAGE_OWN)
  async connectEmail(@CurrentUser() u: AuthenticatedUser, @Body() body: { address?: string }) {
    await this.eligibility.assertEligible(u.id);
    if (!(await this.mail.isConfigured())) {
      throw new BadRequestException('Email is not configured on this server yet.');
    }
    await this.channels.connectEmail(u.id, body?.address ?? '');
    return this.testChannel(u, 'email');
  }

  /** Send a test to a connected channel. Success is what marks it verified. */
  @Post('channels/:type/test')
  @RequirePermissions(P.NOTIFICATIONS_CHANNELS_MANAGE_OWN)
  async testChannel(@CurrentUser() u: AuthenticatedUser, @Param('type') type: string) {
    await this.eligibility.assertEligible(u.id);
    if (type !== 'email' && type !== 'telegram') {
      // Discord arrives in Phase 6. Saying so is better than a generic failure
      // that looks like the user's fault.
      throw new BadRequestException(`The ${type} channel is not available yet.`);
    }

    const channel = type as 'email' | 'telegram';
    const destination = await this.channels.resolveForTest(u.id, channel);
    if (!destination) throw new NotFoundException(`No ${channel} connection to test.`);

    try {
      if (channel === 'email') {
        await this.mail.send({
          to: destination.address,
          subject: 'UltraTorrent — notification test',
          html: '<p>Your UltraTorrent notification email is working.</p>',
          text: 'Your UltraTorrent notification email is working.',
        });
      } else {
        await this.telegram.sendMessage(
          destination.address,
          '✅ <b>UltraTorrent</b> — your notification channel is working.',
        );
      }
    } catch (err) {
      await this.channels.recordFailure(u.id, channel, (err as Error).message);
      // The provider's message is the useful one — "chat not found" tells an
      // operator far more than "test failed".
      throw new BadRequestException((err as Error).message || 'Test message failed.');
    }
    return this.channels.markVerified(u.id, channel);
  }

  @Delete('channels/:type')
  @RequirePermissions(P.NOTIFICATIONS_CHANNELS_MANAGE_OWN)
  async disconnect(@CurrentUser() u: AuthenticatedUser, @Param('type') type: string) {
    await this.eligibility.assertEligible(u.id);
    await this.channels.disconnect(u.id, type as 'email' | 'telegram' | 'discord');
    // Drop any half-finished linking, so a stale code cannot re-link later.
    if (type === 'telegram') this.linking.cancel(u.id);
    return { ok: true };
  }


  // --- platform Telegram bot (operator configuration) ----------------------

  /**
   * Configure the shared bot.
   *
   * Guarded by `settings.manage`, not by a notification permission: this is
   * platform infrastructure, exactly like the SMTP relay. The token is verified
   * against `getMe` before it is stored, so an operator cannot save a typo and
   * discover it only when someone tries to link, and it is never returned.
   */
  @Put('platform/telegram')
  @RequirePermissions(P.SETTINGS_MANAGE)
  setTelegramBot(@Body() body: { token?: string }) {
    return this.telegram.updateSettings(body?.token ?? '');
  }

  @Get('platform/telegram')
  @RequirePermissions(P.SETTINGS_MANAGE)
  getTelegramBot() {
    return this.telegram.getSettings();
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
