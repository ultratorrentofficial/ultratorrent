import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CONNECTABLE_CHANNELS, PERMISSIONS, preferenceAllows,
  type ConnectableChannelType, type DomainEventEnvelope,
} from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { getNotificationEvent } from './notification-catalog';
import { NotificationPreferenceService } from './notification-preference.service';
import { NotificationRecipientResolver } from './recipient-resolver.service';
import { buildFallbackPresentation } from './notification-presentation';
import { buildPresentation } from './presentation/presentation-builders';
import type { PresentationLocale } from './presentation/presentation-strings';

/** What one dispatch did, for tests and the admin health view. */
export interface DispatchSummary {
  eventKey: string;
  audience: number;
  created: number;
  skipped: number;
  /** External deliveries queued for the async worker. */
  queued: number;
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

  /**
   * May this recipient see playback detail (artwork, device, quality)?
   *
   * Same gate as the Live Activity dashboard. Watching habits are personal, and
   * a notification is the one surface that reaches someone who never opened it.
   * SUPER_ADMIN is matched by role, as everywhere else.
   */
  private async canViewPlaybackDetail(userId: string): Promise<boolean> {
    const row = await this.prisma.user.findFirst({
      where: {
        id: userId,
        roles: {
          some: {
            role: {
              OR: [
                { name: 'SUPER_ADMIN' },
                { permissions: { some: { permission: { key: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY } } } },
              ],
            },
          },
        },
      },
      select: { id: true },
    });
    return !!row;
  }

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
      queued: 0,
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
        if (!preference) {
          summary.skipped += 1;
          continue;
        }
        try {
          // The in-app row is also the carrier for external deliveries: it holds
          // the rendered presentation each channel projects. A user who wants
          // email but not in-app still gets a row — it is simply not surfaced.
          const wantsAnything = CONNECTABLE_CHANNELS.some((c) => preferenceAllows(preference, c))
            || preferenceAllows(preference, 'in_app');
          if (!wantsAnything) {
            summary.skipped += 1;
            continue;
          }

          const notificationId = await this.createInApp(
            userId, definition, envelope, preferenceAllows(preference, 'in_app'),
          );
          if (notificationId) summary.created += 1;
          else summary.skipped += 1;

          for (const channel of CONNECTABLE_CHANNELS) {
            if (!preferenceAllows(preference, channel)) continue;
            const queued = await this.queueDelivery(userId, notificationId, definition.key, channel);
            if (queued) summary.queued += 1;
          }
        } catch (err) {
          summary.skipped += 1;
          this.logger.warn(
            `Dispatch for ${userId}/${definition.key} failed: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`Dispatch of ${envelope.eventKey} failed: ${(err as Error).message}`);
    }
    return summary;
  }

  /**
   * Queue one external delivery.
   *
   * Idempotent on (notificationId, channelType), so a redelivered event cannot
   * send the same person the same mail twice. Queuing never throws at the
   * caller: a failure to queue email must not lose the in-app notification.
   */
  private async queueDelivery(
    userId: string,
    notificationId: string | null,
    eventKey: string,
    channelType: ConnectableChannelType,
  ): Promise<boolean> {
    if (!notificationId) return false; // nothing for the worker to render
    try {
      await this.prisma.userNotificationDelivery.create({
        data: {
          userId, notificationId, eventKey, channelType,
          status: 'pending',
          nextAttemptAt: new Date(),
        },
      });
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return false; // already queued
      this.logger.warn(`Queueing ${channelType} for ${userId} failed: ${(err as Error).message}`);
      return false;
    }
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
    surfaceInApp: boolean,
  ): Promise<string | null> {
    const fallback = buildFallbackPresentation(definition, envelope);
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;

    // Generate the id up front so the presentation can reference it for artwork.
    // The alternative — insert, build, update — leaves a window where the card
    // renders without its poster.
    const notificationId = randomUUID();
    const rich = buildPresentation({
      definition,
      envelope,
      locale: 'en-US' as PresentationLocale,
      timezone: null,
      canViewPlaybackDetail: await this.canViewPlaybackDetail(userId),
      notificationId,
    });

    try {
      const row = await this.prisma.userNotification.create({
        data: {
          id: notificationId,
          userId,
          eventId: envelope.id,
          eventKey: definition.key,
          category: definition.category,
          severity: definition.severity,
          // The plain title stays the searchable, sortable text; the rich card
          // is render context beside it.
          title: rich ? rich.summary.text.slice(0, 300) : fallback.title,
          body: fallback.body,
          deepLink: rich?.action?.href ?? fallback.deepLink,
          presentation: (rich ?? undefined) as object | undefined,
          artConnectionId: rich?.artwork ? (payload.connectionId as string) ?? null : null,
          artPath: rich?.artwork ? (payload.artPath as string) ?? null : null,
          resourceType: envelope.resourceType ?? null,
          resourceId: envelope.resourceId ?? null,
        },
      });

      // Only announce it if the user actually wants it in-app. Someone who chose
      // email only should not see a badge increment.
      if (surfaceInApp) {
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
      }
      return row.id;
    } catch (err) {
      // A redelivered event collides on (userId, eventId). Look up the existing
      // row so external deliveries still attach to it rather than being lost.
      if ((err as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.userNotification.findFirst({
          where: { userId, eventId: envelope.id },
          select: { id: true },
        });
        return existing?.id ?? null;
      }
      throw err;
    }
  }
}
