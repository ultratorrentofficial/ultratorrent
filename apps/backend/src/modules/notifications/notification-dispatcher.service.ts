import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { preferenceAllows, type DomainEventEnvelope } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { getNotificationEvent } from './notification-catalog';
import { NotificationPreferenceService } from './notification-preference.service';
import { NotificationRecipientResolver } from './recipient-resolver.service';
import { buildFallbackPresentation } from './notification-presentation';

/** What one dispatch did, for tests and the admin health view. */
export interface DispatchSummary {
  eventKey: string;
  audience: number;
  created: number;
  skipped: number;
}

/**
 * Turns a domain event into personal in-app notifications.
 *
 * The pipeline, in order:
 *
 *   catalogued? → fixed recipient strategy → eligible local users →
 *   personal preference → one owned in-app row each
 *
 * Two properties are load-bearing:
 *
 * **Per-user isolation.** One recipient failing — a preference read erroring, a
 * unique-constraint collision — never affects another. Each is handled in its own
 * try/catch.
 *
 * **Never throws at the bus.** A notification failure must not break the
 * operation that produced the event, and must not stop the other subscribers
 * (automation, workflow waits) from seeing it.
 *
 * Phase 2 creates in-app rows only. External channels are queued here in Phase 4+.
 */
@Injectable()
export class NotificationDispatcher implements OnModuleInit {
  private readonly logger = new Logger(NotificationDispatcher.name);
  private unsubscribe?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    private readonly recipients: NotificationRecipientResolver,
    private readonly preferences: NotificationPreferenceService,
    private readonly realtime: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe('notification-dispatcher', async (envelope) => {
      // The summary is for tests and diagnostics; the bus wants nothing back.
      await this.dispatch(envelope);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  async dispatch(envelope: DomainEventEnvelope): Promise<DispatchSummary> {
    const summary: DispatchSummary = {
      eventKey: envelope.eventKey,
      audience: 0,
      created: 0,
      skipped: 0,
    };

    const definition = getNotificationEvent(envelope.eventKey);
    // Not every domain event is a notification. Automation and workflows read the
    // same bus, so an uncatalogued event is normal — not a warning.
    if (!definition) return summary;

    try {
      const audience = await this.recipients.resolve(definition, envelope);
      summary.audience = audience.length;
      if (!audience.length) return summary;

      const preferences = await this.preferences.effectiveForMany(audience, definition.key);

      for (const userId of audience) {
        const preference = preferences.get(userId);
        if (!preference || !preferenceAllows(preference, 'in_app')) {
          summary.skipped += 1;
          continue;
        }
        try {
          const created = await this.createInApp(userId, definition, envelope);
          if (created) summary.created += 1;
          else summary.skipped += 1;
        } catch (err) {
          summary.skipped += 1;
          this.logger.warn(
            `In-app create for ${userId}/${definition.key} failed: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`Dispatch of ${envelope.eventKey} failed: ${(err as Error).message}`);
    }
    return summary;
  }

  /**
   * Create one owned notification, idempotently.
   *
   * `(userId, eventId)` is unique, so a redelivered domain event collides here
   * instead of notifying the same person twice. A collision is a no-op, not an
   * error.
   */
  private async createInApp(
    userId: string,
    definition: ReturnType<typeof getNotificationEvent> & object,
    envelope: DomainEventEnvelope,
  ): Promise<boolean> {
    const presentation = buildFallbackPresentation(definition, envelope);

    try {
      const row = await this.prisma.userNotification.create({
        data: {
          userId,
          eventId: envelope.id,
          eventKey: definition.key,
          category: definition.category,
          severity: definition.severity,
          title: presentation.title,
          body: presentation.body,
          deepLink: presentation.deepLink,
          resourceType: envelope.resourceType ?? null,
          resourceId: envelope.resourceId ?? null,
        },
      });

      // Personal room only. The gateway derives it from the JWT subject on
      // connect, so this cannot be subscribed to by anyone else.
      this.realtime.toUser(userId, 'account.notification.created', {
        id: row.id,
        eventKey: row.eventKey,
        category: row.category,
        severity: row.severity,
        title: row.title,
        createdAt: row.createdAt.toISOString(),
      });
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return false; // already delivered
      throw err;
    }
  }
}
