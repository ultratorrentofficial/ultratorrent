import { Module } from '@nestjs/common';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { RealtimeModule } from '../realtime/realtime.module';
import { AccountNotificationsController } from './account-notifications.controller';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationPreferenceService } from './notification-preference.service';
import { NotificationRecipientEligibilityService } from './recipient-eligibility.service';
import { NotificationRecipientResolver } from './recipient-resolver.service';
import { NotificationChannelService } from './channels/notification-channel.service';
import { NotificationDeliveryWorker } from './delivery/delivery-worker.service';
import { TelegramLinkingService } from './channels/telegram-linking.service';

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
    SecretCipher,
    NotificationRecipientEligibilityService,
    NotificationRecipientResolver,
    NotificationPreferenceService,
    NotificationInboxService,
    NotificationDispatcher,
    NotificationChannelService,
    NotificationDeliveryWorker,
    TelegramLinkingService,
  ],
  controllers: [AccountNotificationsController],
  exports: [NotificationRecipientEligibilityService, NotificationInboxService],
})
export class NotificationsModule {}
