import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { createHash } from 'node:crypto';
import {
  NOTIFICATION_BUS_CHANNEL, SEVERITY_RANK,
  type DomainEventEnvelope, type NotificationSeverity,
} from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { getEventDefinition } from '../catalog/notification-catalog';
import { NotificationAudienceResolver, type ResolvableEvent } from '../catalog/audience-resolver.service';
import { UserNotificationPreferenceService } from '../preferences/user-preference.service';
import { isWithinQuietHours, quietHoursEndAt } from '../schedule/quiet-hours';

export interface DispatchSummary {
  eventKey: string;
  candidates: number;
  recipients: number;
  inAppCreated: number;
  deliveriesQueued: number;
  suppressed: Array<{ userId: string; reason: string }>;
}

/**
 * Turns one domain event into personal notifications.
 *
 * The pipeline, in order:
 *
 *   catalogue validation → audience → eligibility + RBAC → per-user preference →
 *   in-app record (if routed) → one delivery row PER ROUTE → queued
 *
 * Two properties are load-bearing:
 *
 * **Per-user isolation.** One user's failure — a disabled preference, a missing
 * connection, a provider error — never affects another's. Each recipient is
 * processed independently and a throw is contained to that user.
 *
 * **Per-route isolation.** Choosing two Telegram destinations produces two delivery
 * rows, retried separately, so one broken destination cannot silence the other.
 *
 * Suppressions are RECORDED with a reason rather than inferred, because "I didn't
 * get notified" is otherwise unanswerable.
 */
@Injectable()
export class PersonalNotificationDispatcher {
  private readonly logger = new Logger(PersonalNotificationDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audience: NotificationAudienceResolver,
    private readonly preferences: UserNotificationPreferenceService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Bus subscriber — the cutover point.
   *
   * Producers already emit registered events onto `NOTIFICATION_BUS_CHANNEL`; until
   * now the legacy Notification Center was the *sole* subscriber, which is why the
   * personal engine sat inert. Subscribing here is what turns it on, and it needs no
   * producer changes: both engines observe the same bus, so the legacy path keeps
   * working while the personal one runs beside it.
   *
   * An event the personal catalogue does not register is ignored silently — the
   * legacy engine may still handle it, and logging a warning per bus event would
   * drown the log during the transition.
   */
  @OnEvent(NOTIFICATION_BUS_CHANNEL, { async: true })
  async onDomainEvent(envelope: DomainEventEnvelope): Promise<void> {
    if (!envelope?.event) return;
    if (!getEventDefinition(envelope.event)) return;
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;
    await this.dispatch({
      eventKey: envelope.event,
      payload,
      // Producers put the acting user under one of these when there is one. A value
      // that is not a local account is dropped by eligibility, so an id from another
      // namespace (a media-server user id) cannot become a recipient.
      actorUserId: (payload.actorUserId as string) ?? null,
      subjectUserId: (payload.subjectUserId as string) ?? null,
      resourceOwnerUserId: (payload.resourceOwnerUserId as string) ?? null,
      eventId: envelope.dedupeKey ?? undefined,
    });
  }

  /**
   * Dispatch one event.
   *
   * Never throws at the caller: a notification failure must not break the operation
   * that produced the event. A torrent finished whether or not anyone was told.
   */
  async dispatch(event: ResolvableEvent & { eventId?: string }): Promise<DispatchSummary> {
    const summary: DispatchSummary = {
      eventKey: event.eventKey, candidates: 0, recipients: 0,
      inAppCreated: 0, deliveriesQueued: 0, suppressed: [],
    };
    try {
      const definition = getEventDefinition(event.eventKey);
      if (!definition) return summary; // resolver logs; fail closed

      const resolved = await this.audience.resolve(event);
      summary.candidates = resolved.stats.candidates;
      if (!resolved.userIds.length) return summary;

      for (const userId of resolved.userIds) {
        try {
          const added = await this.dispatchToUser(userId, definition.key, definition.severity, event, summary);
          if (added) summary.recipients += 1;
        } catch (err) {
          // Contained: this user's failure is not the next user's problem.
          this.logger.warn(`Dispatch to user ${userId} for ${event.eventKey} failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.error(`Dispatch of ${event.eventKey} failed: ${(err as Error).message}`);
    }
    return summary;
  }

  private async dispatchToUser(
    userId: string,
    eventKey: string,
    severity: NotificationSeverity,
    event: ResolvableEvent & { eventId?: string },
    summary: DispatchSummary,
  ): Promise<boolean> {
    const pref = await this.preferences.effectiveFor(userId, eventKey);

    if (!pref.enabled || pref.deliveryMode === 'disabled') {
      summary.suppressed.push({ userId, reason: 'preference_disabled' });
      return false;
    }
    if (pref.minSeverity && SEVERITY_RANK[severity] < SEVERITY_RANK[pref.minSeverity]) {
      summary.suppressed.push({ userId, reason: 'below_min_severity' });
      return false;
    }
    // A profile-wide pause suppresses everything until it lapses.
    const profile = await this.prisma.userNotificationProfile.findUnique({ where: { userId } });
    if (profile?.pausedUntil && profile.pausedUntil.getTime() > Date.now()) {
      summary.suppressed.push({ userId, reason: 'paused' });
      return false;
    }
    if (!pref.routes.length) {
      summary.suppressed.push({ userId, reason: 'no_route' });
      return false;
    }

    // Quiet hours, evaluated in the RECIPIENT's timezone. `bypass` is what makes a
    // security alert reach someone at 3am; `suppress` drops the event entirely;
    // `digest` and `respect` both defer it, differing only in what releases it.
    const inQuietHours = profile ? isWithinQuietHours(profile as never, new Date()) : false;
    let deferUntil: Date | null = null;
    if (inQuietHours && pref.quietHoursBehavior !== 'bypass') {
      if (pref.quietHoursBehavior === 'suppress') {
        summary.suppressed.push({ userId, reason: 'quiet_hours' });
        return false;
      }
      deferUntil = quietHoursEndAt(profile as never, new Date());
    }

    const definition = getEventDefinition(eventKey)!;
    const dedupeBase = this.dedupeKeyFor(userId, eventKey, event);

    // --- in-app -----------------------------------------------------------
    let notificationId: string | null = null;
    const inAppRoute = pref.routes.find((r) => r.channelType === 'in_app');
    if (inAppRoute) {
      notificationId = await this.createInApp(userId, definition.key, definition.category, severity, event, dedupeBase);
      if (notificationId) summary.inAppCreated += 1;
    }

    // --- external routes --------------------------------------------------
    for (const route of pref.routes) {
      if (route.channelType === 'in_app') continue;
      if (!route.channelConnectionId) {
        summary.suppressed.push({ userId, reason: 'no_route' });
        continue;
      }
      // Only a verified, enabled, still-existing connection may be sent to.
      const connection = await this.prisma.userNotificationChannel.findFirst({
        where: { id: route.channelConnectionId, userId, deletedAt: null },
        select: { id: true, enabled: true, verifiedAt: true },
      });
      if (!connection || !connection.enabled) {
        summary.suppressed.push({ userId, reason: 'no_verified_connection' });
        continue;
      }
      if (!connection.verifiedAt) {
        // Recorded as a delivery in a terminal state rather than dropped, so the
        // user can see WHY nothing arrived on a channel they selected.
        await this.queue(userId, notificationId, eventKey, route.channelType, connection.id,
          `${dedupeBase}:${route.channelType}:${connection.id}`, 'unverified_connection');
        continue;
      }
      const queued = await this.queue(userId, notificationId, eventKey, route.channelType, connection.id,
        `${dedupeBase}:${route.channelType}:${connection.id}`, null, deferUntil);
      if (queued) summary.deliveriesQueued += 1;
    }

    return true;
  }

  /**
   * Stable idempotency key.
   *
   * The bus can redeliver, and a duplicate dispatch must not produce a second
   * notification. Built from the event id when one exists (exact), else from the
   * event key plus a digest of the payload (best effort but stable).
   */
  private dedupeKeyFor(userId: string, eventKey: string, event: ResolvableEvent & { eventId?: string }): string {
    if (event.eventId) return `${eventKey}:${event.eventId}`;
    const digest = createHash('sha256')
      .update(JSON.stringify(event.payload ?? {}))
      .digest('hex')
      .slice(0, 16);
    return `${eventKey}:${digest}`;
  }

  /** Create the in-app record, or bump the group count if it is a repeat. */
  private async createInApp(
    userId: string, eventKey: string, category: string, severity: NotificationSeverity,
    event: ResolvableEvent, dedupeKey: string,
  ): Promise<string | null> {
    const definition = getEventDefinition(eventKey)!;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const title = String(payload.title ?? payload.mediaTitle ?? definition.titleKey);

    try {
      const existing = await this.prisma.userNotification.findFirst({ where: { userId, dedupeKey } });
      if (existing) {
        // A repeat within the dedupe window increments rather than inserting, so a
        // flapping source cannot flood one person's inbox.
        await this.prisma.userNotification.update({
          where: { id: existing.id },
          data: { groupCount: { increment: 1 }, lastAt: new Date(), readAt: null },
        });
        return existing.id;
      }
      const row = await this.prisma.userNotification.create({
        data: {
          userId, eventKey, category, severity, title,
          body: payload.message ? String(payload.message) : null,
          deepLink: definition.deepLinkTemplate ?? null,
          payload: payload as object,
          dedupeKey,
        },
      });
      // Personal room only — derived from JWT identity on connect, never from a
      // client-supplied id, so this cannot be subscribed to by anyone else.
      this.realtime.toUser(userId, 'account.notification.created', {
        id: row.id, eventKey, severity, title, at: row.createdAt.toISOString(),
      });
      return row.id;
    } catch (err) {
      this.logger.warn(`In-app creation failed for ${userId}/${eventKey}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Enqueue one external delivery, idempotently. */
  private async queue(
    userId: string, notificationId: string | null, eventKey: string,
    channelType: string, channelId: string, dedupeKey: string,
    terminalStatus: string | null,
    deferUntil: Date | null = null,
  ): Promise<boolean> {
    try {
      await this.prisma.userNotificationDelivery.create({
        data: {
          userId, notificationId, eventKey, channelType, channelId, dedupeKey,
          status: terminalStatus ?? 'queued',
          suppressedReason: terminalStatus ? 'no_verified_connection' : null,
          completedAt: terminalStatus ? new Date() : null,
          // A deferred delivery is queued now but not due until quiet hours end.
          nextAttemptAt: terminalStatus ? null : (deferUntil ?? new Date()),
        },
      });
      return terminalStatus === null;
    } catch (err) {
      // The unique (userId, dedupeKey) index is the idempotency guarantee: a
      // redelivered event collides here instead of duplicating the notification.
      if ((err as { code?: string }).code === 'P2002') return false;
      throw err;
    }
  }
}
