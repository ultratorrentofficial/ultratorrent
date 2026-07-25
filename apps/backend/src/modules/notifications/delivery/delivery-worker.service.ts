import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { isNotificationPresentation, type ConnectableChannelType } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { MailTransportService } from '../../../infrastructure/mail/mail-transport.service';
import { NotificationChannelService } from '../channels/notification-channel.service';
import { renderEmailHtml, renderEmailSubject, renderEmailText } from '../providers/email-renderer';

/** Bounded, and not user-configurable — retries are an implementation detail. */
const MAX_ATTEMPTS = 3;
/** Backoff per attempt number, in seconds. */
const BACKOFF_SECONDS = [60, 300, 900];
/** How many deliveries one tick drains, so a backlog cannot monopolise a tick. */
const BATCH = 20;

/**
 * Sends queued external deliveries.
 *
 * Asynchronous by design: a provider being slow or down must never block the
 * in-app notification, another channel, another user, or the operation that
 * produced the event.
 *
 * Every precondition is **re-checked at send time**, not trusted from when the
 * delivery was queued: a user can deactivate, disconnect a channel or turn the
 * event off in between, and sending anyway would deliver something they have
 * since declined.
 */
@Injectable()
export class NotificationDeliveryWorker {
  private readonly logger = new Logger(NotificationDeliveryWorker.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: NotificationChannelService,
    private readonly mail: MailTransportService,
  ) {}

  @Interval('notification_delivery_worker', 30_000)
  async tick(): Promise<void> {
    if (this.running) return; // a long tick must never overlap the next
    this.running = true;
    try {
      await this.drain();
    } catch (err) {
      this.logger.warn(`Delivery sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Process everything currently due. Exposed for tests. */
  async drain(): Promise<{ sent: number; failed: number; cancelled: number }> {
    const due = await this.prisma.userNotificationDelivery.findMany({
      where: { status: { in: ['pending', 'failed'] }, nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });

    let sent = 0;
    let failed = 0;
    let cancelled = 0;

    for (const delivery of due) {
      try {
        const outcome = await this.attempt(delivery);
        if (outcome === 'sent') sent += 1;
        else if (outcome === 'cancelled') cancelled += 1;
        else failed += 1;
      } catch (err) {
        // Contained: one delivery's failure is not the next one's problem.
        failed += 1;
        this.logger.warn(`Delivery ${delivery.id} threw: ${(err as Error).message}`);
      }
    }
    return { sent, failed, cancelled };
  }

  private async attempt(delivery: {
    id: string; userId: string; notificationId: string | null;
    channelType: string; attempts: number;
  }): Promise<'sent' | 'failed' | 'cancelled'> {
    // Still an active account? Deactivation between queue and send must stop it.
    const user = await this.prisma.user.findUnique({
      where: { id: delivery.userId },
      select: { isActive: true },
    });
    if (!user?.isActive) return this.cancel(delivery.id, 'user_inactive');

    const destination = await this.channels.resolveDestination(
      delivery.userId,
      delivery.channelType as ConnectableChannelType,
    );
    // Disconnected, disabled, unverified, or an unreadable config after a key
    // rotation. All terminal — retrying cannot fix any of them.
    if (!destination) return this.cancel(delivery.id, 'no_verified_connection');

    const notification = delivery.notificationId
      ? await this.prisma.userNotification.findUnique({
          where: { id: delivery.notificationId },
          select: { presentation: true, title: true },
        })
      : null;
    if (!notification) return this.cancel(delivery.id, 'notification_missing');

    const presentation = isNotificationPresentation(notification.presentation)
      ? notification.presentation
      : null;

    const attemptNo = delivery.attempts + 1;
    await this.prisma.userNotificationDelivery.update({
      where: { id: delivery.id },
      data: { status: 'sending', attempts: attemptNo },
    });

    try {
      if (delivery.channelType === 'email') {
        await this.mail.send({
          to: destination.address,
          subject: presentation ? renderEmailSubject(presentation) : notification.title,
          html: presentation ? renderEmailHtml(presentation) : `<p>${notification.title}</p>`,
          text: presentation ? renderEmailText(presentation) : notification.title,
        });
      } else {
        // Telegram and Discord land in Phases 5-6. Cancelled rather than retried:
        // three attempts at something unimplemented is three identical failures.
        return this.cancel(delivery.id, 'channel_not_implemented');
      }

      await this.prisma.userNotificationDelivery.update({
        where: { id: delivery.id },
        data: {
          // `provider_accepted`, never `delivered`: SMTP acknowledges that the
          // relay took the message, not that a person received it.
          status: 'provider_accepted',
          sentAt: new Date(),
          completedAt: new Date(),
          lastError: null,
        },
      });
      await this.channels.recordSuccess(delivery.userId, delivery.channelType as ConnectableChannelType);
      return 'sent';
    } catch (err) {
      const message = (err as Error).message ?? 'send failed';
      await this.channels.recordFailure(
        delivery.userId, delivery.channelType as ConnectableChannelType, message,
      );

      const exhausted = attemptNo >= MAX_ATTEMPTS;
      await this.prisma.userNotificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'failed',
          lastError: message.slice(0, 500),
          nextAttemptAt: exhausted
            ? null
            : new Date(Date.now() + BACKOFF_SECONDS[attemptNo - 1] * 1000),
          completedAt: exhausted ? new Date() : null,
        },
      });
      return 'failed';
    }
  }

  private async cancel(id: string, reason: string): Promise<'cancelled'> {
    await this.prisma.userNotificationDelivery.update({
      where: { id },
      data: {
        status: 'cancelled',
        suppressedReason: reason,
        nextAttemptAt: null,
        completedAt: new Date(),
      },
    });
    return 'cancelled';
  }
}
