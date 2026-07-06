import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MODULE_IDS, WS_EVENTS } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { NotificationChannelService } from './channel.service';
import { getNotificationProvider } from './provider-registry';
import type { NotificationKind } from './notification-provider';

/** Periodically health-checks enabled channels and emits provider up/down events. */
@Injectable()
export class NotificationProviderHealthService {
  private readonly logger = new Logger(NotificationProviderHealthService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly registry: ModuleRegistryService,
    private readonly channels: NotificationChannelService,
  ) {}

  @Interval('notification_provider_health', 5 * 60_000)
  async checkAll(): Promise<void> {
    if (this.running) return;
    if (!this.registry.getStatus(MODULE_IDS.NOTIFICATION_CENTER)?.enabled) return;
    this.running = true;
    try {
      const rows = await this.prisma.notificationChannel.findMany({ where: { enabled: true } });
      for (const ch of rows) {
        try {
          const provider = getNotificationProvider(ch.provider as NotificationKind);
          const health = await provider.healthCheck(this.channels.decryptConfig(ch));
          const was = ch.healthStatus;
          await this.prisma.notificationChannel.update({
            where: { id: ch.id },
            data: { healthStatus: health.status, lastHealthCheckAt: new Date(), lastError: health.error ?? null },
          });
          if (was !== health.status) {
            const evt = health.ok ? WS_EVENTS.NOTIFICATION_PROVIDER_ONLINE : WS_EVENTS.NOTIFICATION_PROVIDER_OFFLINE;
            this.realtime.broadcast(evt, { channelId: ch.id, provider: ch.provider, status: health.status, at: new Date().toISOString() });
          }
        } catch (e) {
          this.logger.warn(`health check failed for channel ${ch.id}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
