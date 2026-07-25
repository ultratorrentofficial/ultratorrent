import { Global, Module } from '@nestjs/common';
import { DiscordTransportService } from './discord-transport.service';

/**
 * Personal Discord webhooks.
 *
 * `@Global` to match the other transports, though it holds no credential of its
 * own — a webhook URL is both destination and authorisation, and belongs to the
 * user who supplied it.
 */
@Global()
@Module({
  providers: [DiscordTransportService],
  exports: [DiscordTransportService],
})
export class DiscordModule {}
