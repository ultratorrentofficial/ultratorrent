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
    SecretCipher,
  ],
  controllers: [NotificationCenterController],
  exports: [NotificationCenterService],
})
export class NotificationCenterModule {}
