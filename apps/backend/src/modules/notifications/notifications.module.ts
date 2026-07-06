import {
  Body,
  Controller,
  Get,
  Global,
  Injectable,
  Logger,
  Module,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NOTIFICATION_BUS_CHANNEL, WS_EVENTS } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { paginate, parsePage } from '../../common/pagination';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SettingsModule, SettingsService } from '../settings/settings.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';

export interface DispatchInput {
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  eventType?: string;
  userId?: string;
}

interface ChannelConfig {
  webhookUrl?: string;
  discordUrl?: string;
  slackUrl?: string;
  telegram?: { botToken: string; chatId: string };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly settings: SettingsService,
    private readonly eventBus: EventEmitter2,
  ) {}

  /** Persist a notification, push in-app, and fan out to external channels. */
  async dispatch(input: DispatchInput): Promise<void> {
    const record = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        level: input.level,
        title: input.title,
        message: input.message,
        eventType: input.eventType,
      },
    });

    const payload = {
      id: record.id,
      level: record.level,
      title: record.title,
      message: record.message,
      createdAt: record.createdAt.toISOString(),
    };
    if (input.userId) {
      this.realtime.toUser(input.userId, WS_EVENTS.NOTIFICATION, payload);
    } else {
      this.realtime.broadcast(WS_EVENTS.NOTIFICATION, payload);
    }

    // Supersede path: publish onto the bus so the Notification Center can apply
    // its rules/channels. The legacy in-app + fan-out above stay for back-compat.
    this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, {
      event: 'legacy.notification',
      payload: { title: input.title, message: input.message, level: input.level, eventType: input.eventType ?? null, userId: input.userId ?? null, userDisplayName: input.title },
      at: new Date().toISOString(),
    });

    await this.fanOut(input).catch((err) =>
      this.logger.warn(`External notification failed: ${err.message}`),
    );
  }

  private async fanOut(input: DispatchInput): Promise<void> {
    const cfg =
      (await this.settings.get<ChannelConfig>('notifications.channels')) ?? {};
    const text = `**${input.title}**\n${input.message}`;
    const jobs: Promise<unknown>[] = [];

    if (cfg.webhookUrl) {
      jobs.push(
        fetch(cfg.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }),
      );
    }
    if (cfg.discordUrl) {
      jobs.push(
        fetch(cfg.discordUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text }),
        }),
      );
    }
    if (cfg.slackUrl) {
      jobs.push(
        fetch(cfg.slackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        }),
      );
    }
    if (cfg.telegram?.botToken && cfg.telegram?.chatId) {
      const url = `https://api.telegram.org/bot${cfg.telegram.botToken}/sendMessage`;
      jobs.push(
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: cfg.telegram.chatId,
            text: `${input.title}\n${input.message}`,
          }),
        }),
      );
    }
    await Promise.allSettled(jobs);
  }

  async listForUser(userId: string, page?: string, pageSize?: string) {
    return paginate(
      this.prisma.notification,
      { where: { OR: [{ userId }, { userId: null }] }, orderBy: { createdAt: 'desc' } },
      parsePage(page, pageSize),
    );
  }

  async markRead(id: string, userId: string) {
    // Scope to the caller's own (or global) notifications — a user must not be
    // able to mutate another user's notification (IDOR).
    await this.prisma.notification.updateMany({
      where: { id, OR: [{ userId }, { userId: null }] },
      data: { readAt: new Date() },
    });
    return { id };
  }
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.notifications.listForUser(user.id, page, pageSize);
  }

  @Post(':id/read')
  markRead(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markRead(id, user.id);
  }
}

@Global()
@Module({
  imports: [SettingsModule],
  providers: [NotificationsService],
  controllers: [NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
