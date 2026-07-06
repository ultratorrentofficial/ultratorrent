import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { NotificationDelivery } from '@prisma/client';
import { MODULE_IDS, WS_EVENTS } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { NotificationChannelService } from './channel.service';
import { getNotificationProvider } from './provider-registry';
import { cardToText } from './notification-provider';
import type { NotificationCard, NotificationKind, NotificationMessage } from './notification-provider';

const BATCH = 25;

/** Request to enqueue one delivery (produced by the rule pipeline). */
export interface EnqueueInput {
  event: string;
  eventId?: string | null;
  ruleId?: string | null;
  channelId: string;
  provider: NotificationKind;
  recipientId?: string | null;
  destination?: string | null;
  templateId?: string | null;
  subject?: string | null;
  card: NotificationCard;
  body: string; // channel-primary rendered body (markdown for telegram, else text)
  priority?: number;
  severity?: string;
  dedupeKey?: string | null;
  dedupeWindowSec?: number;
  maxAttempts?: number;
  scheduledFor?: Date | null;
}

function nowInZone(tz?: string | null): { h: number; m: number } {
  const d = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || 'UTC' }).formatToParts(d);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? d.getUTCHours());
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? d.getUTCMinutes());
    return { h: h % 24, m };
  } catch {
    return { h: d.getUTCHours(), m: d.getUTCMinutes() };
  }
}

interface QuietHours { enabled?: boolean; start?: string; end?: string; timezone?: string }

/** True if `now` falls inside the quiet window (supports windows crossing midnight). */
export function inQuietHours(q: QuietHours | null | undefined, at = nowInZone(q?.timezone)): boolean {
  if (!q?.enabled || !q.start || !q.end) return false;
  const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return (h % 24) * 60 + (m || 0); };
  const cur = at.h * 60 + at.m;
  const s = toMin(q.start);
  const e = toMin(q.end);
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e; // crosses midnight
}

@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly registry: ModuleRegistryService,
    private readonly channels: NotificationChannelService,
  ) {}

  /** Create a delivery + queue row, honoring the dedup window. Returns the delivery or null if deduped. */
  async enqueue(input: EnqueueInput): Promise<NotificationDelivery | null> {
    if (input.dedupeKey && input.dedupeWindowSec && input.dedupeWindowSec > 0) {
      const since = new Date(Date.now() - input.dedupeWindowSec * 1000);
      const dup = await this.prisma.notificationDelivery.findFirst({
        where: { dedupeKey: input.dedupeKey, channelId: input.channelId, recipientId: input.recipientId ?? undefined, createdAt: { gte: since } },
      });
      if (dup) return null;
    }
    const delivery = await this.prisma.notificationDelivery.create({
      data: {
        event: input.event,
        eventId: input.eventId ?? null,
        ruleId: input.ruleId ?? null,
        channelId: input.channelId,
        provider: input.provider,
        recipientId: input.recipientId ?? null,
        destination: input.destination ?? null,
        templateId: input.templateId ?? null,
        subject: input.subject ?? null,
        renderedBody: input.body,
        card: input.card as object,
        priority: input.priority ?? 0,
        severity: input.severity ?? 'info',
        status: 'queued',
        maxAttempts: input.maxAttempts ?? 3,
        dedupeKey: input.dedupeKey ?? null,
        scheduledFor: input.scheduledFor ?? null,
        nextAttemptAt: input.scheduledFor ?? new Date(),
      },
    });
    await this.prisma.notificationQueue.create({
      data: { deliveryId: delivery.id, priority: delivery.priority, scheduledFor: delivery.nextAttemptAt ?? new Date() },
    });
    this.realtime.broadcast(WS_EVENTS.NOTIFICATION_QUEUE_UPDATED, { at: new Date().toISOString() });
    return delivery;
  }

  private messageFromDelivery(d: NotificationDelivery): NotificationMessage {
    const card = (d.card as unknown as NotificationCard) ?? { title: d.subject ?? 'Notification' };
    const body = d.renderedBody ?? cardToText(card);
    return {
      subject: d.subject,
      card,
      text: body,
      markdown: d.provider === 'telegram' ? body : null,
      html: null,
    };
  }

  /** Worker: process due deliveries. Gated on the module being enabled. */
  @Interval('notification_delivery_worker', 10_000)
  async processQueue(): Promise<void> {
    if (this.running) return;
    if (!this.registry.getStatus(MODULE_IDS.NOTIFICATION_CENTER)?.enabled) return;
    this.running = true;
    try {
      const due = await this.prisma.notificationDelivery.findMany({
        where: { status: { in: ['queued', 'retrying', 'throttled'] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        take: BATCH,
      });
      for (const d of due) {
        await this.processOne(d).catch((e) => this.logger.warn(`delivery ${d.id} failed: ${e instanceof Error ? e.message : e}`));
      }
    } finally {
      this.running = false;
    }
  }

  private async reschedule(d: NotificationDelivery, ms: number, status: string, reason?: string): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id: d.id },
      data: { status, nextAttemptAt: new Date(Date.now() + ms), error: reason ?? d.error },
    });
    await this.prisma.notificationQueue.updateMany({ where: { deliveryId: d.id }, data: { scheduledFor: new Date(Date.now() + ms) } });
  }

  private async processOne(d: NotificationDelivery): Promise<void> {
    const channel = d.channelId ? await this.prisma.notificationChannel.findUnique({ where: { id: d.channelId } }) : null;
    if (!channel || !channel.enabled) {
      await this.finish(d, 'skipped', 'channel missing or disabled');
      return;
    }

    // Quiet hours (unless the delivery was already forced past them via override at enqueue).
    const recipient = d.recipientId ? await this.prisma.notificationRecipient.findUnique({ where: { id: d.recipientId } }) : null;
    const quiet = (channel.quietHours as QuietHours) || (recipient?.quietHours as QuietHours);
    if (inQuietHours(recipient?.quietHours as QuietHours) || inQuietHours(channel.quietHours as QuietHours)) {
      await this.reschedule(d, 15 * 60_000, 'throttled', 'quiet hours');
      return;
    }
    void quiet;

    // Per-channel rate limit.
    if (channel.rateLimitPerMin && channel.rateLimitPerMin > 0) {
      const sentLastMin = await this.prisma.notificationDelivery.count({
        where: { channelId: channel.id, status: { in: ['sent', 'delivered'] }, sentAt: { gte: new Date(Date.now() - 60_000) } },
      });
      if (sentLastMin >= channel.rateLimitPerMin) {
        await this.reschedule(d, 60_000, 'throttled', 'rate limited');
        return;
      }
    }

    await this.prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: 'sending', attempts: { increment: 1 } } });

    const provider = getNotificationProvider(channel.provider as NotificationKind);
    const config = this.channels.decryptConfig(channel);
    const addr = { email: d.destination, phone: d.destination, telegramChatId: d.destination, whatsappNumber: d.destination, raw: d.destination };
    const result = await provider.send(config, addr, this.messageFromDelivery(d));

    if (result.ok) {
      await this.finish(d, 'sent', null, result.providerMessageId);
      await this.prisma.notificationChannel.update({ where: { id: channel.id }, data: { sentCount: { increment: 1 }, healthStatus: 'online' } });
      this.realtime.broadcast(WS_EVENTS.NOTIFICATION_SENT, { id: d.id, event: d.event, channelId: channel.id, at: new Date().toISOString() });
    } else {
      const attempts = d.attempts + 1;
      if (attempts < d.maxAttempts) {
        const backoff = Math.min(30 * 60_000, 30_000 * 2 ** (attempts - 1));
        await this.reschedule({ ...d, attempts }, backoff, 'retrying', result.error);
        this.realtime.broadcast(WS_EVENTS.NOTIFICATION_RETRY, { id: d.id, attempts, at: new Date().toISOString() });
      } else {
        await this.finish(d, 'failed', result.error ?? 'send failed');
        await this.prisma.notificationChannel.update({ where: { id: channel.id }, data: { failedCount: { increment: 1 }, lastError: result.error ?? null } });
        this.realtime.broadcast(WS_EVENTS.NOTIFICATION_FAILED, { id: d.id, event: d.event, channelId: channel.id, error: result.error, at: new Date().toISOString() });
      }
    }
  }

  private async finish(d: NotificationDelivery, status: string, error: string | null, providerMessageId?: string): Promise<void> {
    const now = new Date();
    await this.prisma.notificationDelivery.update({
      where: { id: d.id },
      data: {
        status,
        error,
        providerMessageId: providerMessageId ?? d.providerMessageId,
        sentAt: status === 'sent' || status === 'delivered' ? now : d.sentAt,
        failedAt: status === 'failed' ? now : d.failedAt,
      },
    });
    await this.prisma.notificationQueue.deleteMany({ where: { deliveryId: d.id } });
  }

  /** Requeue a failed/cancelled delivery for another attempt (manual retry). */
  async retry(id: string): Promise<NotificationDelivery> {
    const d = await this.prisma.notificationDelivery.update({
      where: { id },
      data: { status: 'queued', nextAttemptAt: new Date(), error: null, maxAttempts: { increment: 1 } },
    });
    await this.prisma.notificationQueue.upsert({
      where: { deliveryId: id },
      create: { deliveryId: id, priority: d.priority, scheduledFor: new Date() },
      update: { scheduledFor: new Date() },
    });
    return d;
  }
}
