import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { NotificationRecipientEligibilityService } from '../recipient-eligibility.service';
import { getEventDefinition } from '../catalog/notification-catalog';
import { decideRetry, type DeliveryErrorClass } from './delivery-policy';
import { PersonalTransmitter } from './personal-transmitter.service';

/** Deliveries claimed per tick. Bounds provider load and worker runtime. */
const BATCH_SIZE = 25;
/** Concurrent provider calls. Small on purpose — see the class comment. */
const CONCURRENCY = 4;

export interface DrainSummary {
  claimed: number;
  accepted: number;
  retried: number;
  failed: number;
  deadLettered: number;
  skipped: number;
}

/**
 * Drains the personal delivery queue.
 *
 * Concurrency is deliberately low. These are third-party APIs with per-app rate
 * limits, and the failure mode of parallelism here is not a slow queue — it is a
 * rate-limited or banned integration that stops delivering for everybody. A small
 * pool with backoff recovers from a burst; a large one amplifies it.
 *
 * Every attempt **re-checks the preconditions** rather than trusting what was true
 * when the delivery was queued: an account can be deactivated, a connection revoked
 * or disabled, and a retry minutes later must not still deliver. That is the
 * "delivery after deactivation" failure this engine is required not to have.
 */
@Injectable()
export class NotificationDeliveryWorker {
  private readonly logger = new Logger(NotificationDeliveryWorker.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly transmitter: PersonalTransmitter,
    private readonly eligibility: NotificationRecipientEligibilityService,
  ) {}

  /** Scheduled drain. Re-entrancy guarded so a slow tick cannot overlap itself. */
  @Interval('personal_notification_delivery', 30_000)
  scheduled(): void {
    void this.drain().catch((err) =>
      this.logger.warn(`Delivery drain failed: ${(err as Error).message}`),
    );
  }

  async drain(now = new Date()): Promise<DrainSummary> {
    const summary: DrainSummary = { claimed: 0, accepted: 0, retried: 0, failed: 0, deadLettered: 0, skipped: 0 };
    if (this.running) return summary;
    this.running = true;
    try {
      const due = await this.prisma.userNotificationDelivery.findMany({
        where: {
          status: { in: ['queued', 'retry_scheduled'] },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: { nextAttemptAt: 'asc' },
        take: BATCH_SIZE,
      });
      summary.claimed = due.length;
      if (!due.length) return summary;

      // Fixed-size worker pool over the batch.
      const queue = [...due];
      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          try {
            await this.attempt(item, summary);
          } catch (err) {
            // One delivery's failure must never abort the drain.
            this.logger.warn(`Delivery ${item.id} raised: ${(err as Error).message}`);
          }
        }
      });
      await Promise.all(workers);
    } finally {
      this.running = false;
    }
    return summary;
  }

  private async attempt(delivery: any, summary: DrainSummary): Promise<void> {
    // --- preconditions, re-checked at attempt time -------------------------
    if (!(await this.eligibility.isEligible(delivery.userId))) {
      await this.terminate(delivery, 'recipient_ineligible', 'account is no longer eligible');
      summary.skipped += 1;
      return;
    }
    const connection = await this.prisma.userNotificationChannel.findFirst({
      where: { id: delivery.channelId ?? '', userId: delivery.userId, deletedAt: null },
    });
    if (!connection || !connection.enabled) {
      await this.terminate(delivery, 'invalid_connection', 'connection revoked or disabled');
      summary.skipped += 1;
      return;
    }
    if (!connection.verifiedAt) {
      await this.terminate(delivery, 'unverified_connection', 'connection is not verified');
      summary.skipped += 1;
      return;
    }

    const attemptNo = delivery.attempts + 1;
    const definition = getEventDefinition(delivery.eventKey);
    const subject = definition ? definition.titleKey : delivery.eventKey;

    const startedAt = Date.now();
    await this.prisma.userNotificationDelivery.update({
      where: { id: delivery.id }, data: { status: 'sending', attempts: attemptNo },
    });

    const result = await this.transmitter.transmit(
      delivery.channelType, connection.encryptedConfig, subject, subject,
    );
    const durationMs = Date.now() - startedAt;

    await this.prisma.userNotificationDeliveryAttempt.create({
      data: {
        deliveryId: delivery.id,
        attempt: attemptNo,
        status: result.ok ? 'provider_accepted' : 'failed',
        errorClass: result.errorClass ?? null,
        error: result.error ?? null,
        durationMs,
      },
    });

    if (result.ok) {
      // `provider_accepted`, NOT `delivered`: the provider took the message, which
      // is not the same as a person receiving it.
      await this.prisma.userNotificationDelivery.update({
        where: { id: delivery.id },
        data: { status: 'provider_accepted', sentAt: new Date(), completedAt: new Date(), lastError: null, errorClass: null },
      });
      await this.prisma.userNotificationChannel.update({
        where: { id: connection.id },
        data: { lastSuccessAt: new Date(), consecutiveFailures: 0 },
      });
      summary.accepted += 1;
      return;
    }

    const cls = (result.errorClass ?? 'unknown') as DeliveryErrorClass;
    const decision = decideRetry(cls, attemptNo, result.retryAfterSeconds);

    await this.prisma.userNotificationChannel.update({
      where: { id: connection.id },
      data: { lastFailureAt: new Date(), consecutiveFailures: { increment: 1 } },
    });

    if (decision.retry) {
      await this.prisma.userNotificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'retry_scheduled',
          nextAttemptAt: new Date(Date.now() + (decision.delayMs ?? 60_000)),
          lastError: result.error ?? null, errorClass: cls,
        },
      });
      summary.retried += 1;
      return;
    }

    await this.prisma.userNotificationDelivery.update({
      where: { id: delivery.id },
      data: { status: decision.status, completedAt: new Date(), lastError: result.error ?? null, errorClass: cls },
    });
    if (decision.deadLetter) {
      // Kept beyond the delivery row: "why did this never arrive" is the question
      // actually asked, and it is unanswerable once the evidence is gone.
      await this.prisma.notificationDeadLetter.create({
        data: {
          userId: delivery.userId, eventKey: delivery.eventKey, channelType: delivery.channelType,
          errorClass: cls, error: result.error ?? null, attempts: attemptNo,
        },
      });
      summary.deadLettered += 1;
    }
    summary.failed += 1;
  }

  /** Close a delivery that can never succeed, without another provider call. */
  private async terminate(delivery: any, status: string, reason: string): Promise<void> {
    await this.prisma.userNotificationDelivery.update({
      where: { id: delivery.id },
      data: { status, completedAt: new Date(), suppressedReason: reason, lastError: reason },
    });
  }
}
