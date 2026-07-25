import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { AccountNotificationsController } from './account-notifications.controller';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationPreferenceService } from './notification-preference.service';
import { NotificationRecipientEligibilityService } from './recipient-eligibility.service';
import { NotificationRecipientResolver } from './recipient-resolver.service';

/**
 * Personal notifications.
 *
 * One module, not a dozen. The system it replaces spread the same concerns
 * across ~60 files, and the cost was that no single place answered "what happens
 * when this event fires".
 *
 * It resolves recipients, applies personal preferences and creates owned in-app
 * notifications. It deliberately contains **no** provider HTTP, SMTP or channel
 * markup — those arrive in Phases 4-6 behind their own module.
 */
@Module({
  imports: [RealtimeModule],
  providers: [
    NotificationRecipientEligibilityService,
    NotificationRecipientResolver,
    NotificationPreferenceService,
    NotificationInboxService,
    NotificationDispatcher,
  ],
  controllers: [AccountNotificationsController],
  exports: [NotificationRecipientEligibilityService, NotificationInboxService],
})
export class NotificationsModule {}
