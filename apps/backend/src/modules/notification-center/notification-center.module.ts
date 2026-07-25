import { Global, Module } from '@nestjs/common';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { NotificationCenterController } from './notification-center.controller';
import { NotificationCenterService } from './notification-center.service';
import { NotificationRuleEngineService } from './rule-engine.service';
import { NotificationRecipientService } from './recipient.service';
import { NotificationChannelService } from './channel.service';
import { NotificationDeliveryService } from './delivery.service';
import { NotificationProviderHealthService } from './provider-health.service';
import { NotificationAdminService } from './notification-admin.service';
import { RecipientProvisioningService } from './recipient-provisioning.service';
import { NotificationRecipientEligibilityService } from './recipient-eligibility.service';
import { NotificationAudienceResolver } from './catalog/audience-resolver.service';
import { UserNotificationPreferenceService } from './preferences/user-preference.service';
import { PersonalChannelService } from './channels/personal-channel.service';
import { PersonalNotificationDispatcher } from './delivery/personal-dispatcher.service';
import { PersonalTransmitter } from './delivery/personal-transmitter.service';
import { NotificationDeliveryWorker } from './delivery/delivery-worker.service';
import { NotificationInboxService } from './inbox/inbox.service';
import { NotificationProfileService } from './schedule/notification-profile.service';
import { AccountNotificationsController } from './preferences/account-notifications.controller';
import { NotificationSeedService } from './seed.service';

/**
 * Notification Center — the centralized, provider-driven messaging platform.
 * Global so the pipeline service is injectable app-wide; the event bus
 * (@nestjs/event-emitter, wired in AppModule) is how modules actually publish.
 */
@Global()
@Module({
  providers: [
    NotificationCenterService,
    NotificationRuleEngineService,
    NotificationRecipientService,
    NotificationChannelService,
    NotificationDeliveryService,
    NotificationProviderHealthService,
    NotificationAdminService,
    NotificationSeedService,
    RecipientProvisioningService,
    NotificationRecipientEligibilityService,
    NotificationAudienceResolver,
    UserNotificationPreferenceService,
    PersonalChannelService,
    PersonalNotificationDispatcher,
    PersonalTransmitter,
    NotificationDeliveryWorker,
    NotificationInboxService,
    NotificationProfileService,
    SecretCipher,
  ],
  controllers: [NotificationCenterController, AccountNotificationsController],
  exports: [
    NotificationCenterService,
    RecipientProvisioningService,
    NotificationRecipientEligibilityService,
    NotificationAudienceResolver,
    UserNotificationPreferenceService,
    PersonalChannelService,
    PersonalNotificationDispatcher,
    PersonalTransmitter,
    NotificationInboxService,
    NotificationProfileService,
  ],
})
export class NotificationCenterModule {}
