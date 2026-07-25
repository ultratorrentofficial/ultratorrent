import { Global, Module } from '@nestjs/common';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { MailTransportService } from './mail-transport.service';

/**
 * The shared outbound mail transport.
 *
 * `@Global` because sending is infrastructure: newsletters and personal
 * notifications both send, and neither should have to import the other's module
 * to do it. There is exactly one transport — a second SMTP configuration would
 * be two things to keep working.
 */
@Global()
@Module({
  // SecretCipher is registered locally rather than globally, matching every
  // other module that needs it (engine, media-server-analytics, two-factor).
  providers: [SecretCipher, MailTransportService],
  exports: [MailTransportService],
})
export class MailModule {}
