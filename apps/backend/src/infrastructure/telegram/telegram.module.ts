import { Global, Module } from '@nestjs/common';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { TelegramTransportService } from './telegram-transport.service';

/**
 * The shared Telegram bot.
 *
 * `@Global` for the same reason as mail: sending is infrastructure. One bot,
 * many linked chats — a second bot would be a second token to keep working.
 */
@Global()
@Module({
  providers: [SecretCipher, TelegramTransportService],
  exports: [TelegramTransportService],
})
export class TelegramModule {}
