import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  requiresConnection,
  type EffectiveEventPreference,
  type EffectiveEventRoute,
  type NotificationChannelType,
  type NotificationDeliveryMode,
  type QuietHoursBehavior,
} from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import {
  activeEventDefinitions,
  getEventDefinition,
} from '../catalog/notification-catalog';
import type { NotificationEventDefinition } from '../catalog/notification-catalog.types';

/** A patch to one event's personal settings. Absent keys are left alone. */
export interface PreferencePatch {
  enabled?: boolean | null;
  deliveryMode?: NotificationDeliveryMode | null;
  quietHoursBehavior?: QuietHoursBehavior | null;
  minSeverity?: string | null;
  dedupeWindowSec?: number | null;
  aggregationWindowMin?: number | null;
}

/** One requested destination. `channelConnectionId` is null only for in-app. */
export interface RouteInput {
  channelType: NotificationChannelType;
  channelConnectionId?: string | null;
  enabled?: boolean;
  deliveryMode?: NotificationDeliveryMode | null;
}

/** An event row as the matrix renders it. */
export interface EventMatrixRow {
  definition: NotificationEventDefinition;
  preference: EffectiveEventPreference;
}

export interface BulkResult {
  applied: number;
  skipped: Array<{ eventKey: string; reason: string }>;
}

/**
 * A user's personal event preferences: what they resolve to, and how they change.
 *
 * **Storage is lazy.** Only deviations from the catalogue are stored, so a user with
 * no rows still has a complete, deterministic answer, and adding an event to the
 * catalogue is not a data migration across every account. A null column means
 * "inherit" — which is why the stored flags are nullable rather than defaulted.
 *
 * Every method takes the acting user's id from the caller (which takes it from the
 * JWT, never from a request parameter) and scopes every query by it. There is no
 * method here that can read or write another person's preferences.
 */
@Injectable()
export class UserNotificationPreferenceService {
  private readonly logger = new Logger(UserNotificationPreferenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The full event matrix for one user: every active event, with its effective
   * settings.
   *
   * Loads all overrides and routes in two queries rather than per event — the matrix
   * renders ~66 rows, and a per-row lookup would be a guaranteed N+1 on a page the
   * user opens constantly.
   */
  async listEvents(userId: string): Promise<EventMatrixRow[]> {
    const defs = activeEventDefinitions();
    const prefs = await this.prisma.userNotificationPreference.findMany({
      where: { userId },
      include: { routes: true },
    });
    const byKey = new Map(prefs.map((p) => [p.eventKey, p]));
    return defs.map((definition) => ({
      definition,
      preference: this.merge(definition, byKey.get(definition.key)),
    }));
  }

  /** Effective settings for a single event. */
  async effectiveFor(userId: string, eventKey: string): Promise<EffectiveEventPreference> {
    const definition = getEventDefinition(eventKey);
    if (!definition) throw new NotFoundException('Unknown notification event');
    const row = await this.prisma.userNotificationPreference.findUnique({
      where: { userId_eventKey: { userId, eventKey } },
      include: { routes: true },
    });
    return this.merge(definition, row ?? undefined);
  }

  /**
   * Catalogue default ⊕ stored override.
   *
   * The catalogue's `defaultPreferences.channels` becomes the default route set —
   * always in-app only, since an external channel has no connection to point at
   * until the user makes one.
   */
  private merge(
    definition: NotificationEventDefinition,
    row?: { enabled: boolean | null; deliveryMode: string | null; quietHoursBehavior: string | null;
           minSeverity: string | null; dedupeWindowSec: number | null; aggregationWindowMin: number | null;
           routesOverridden?: boolean;
           routes?: Array<{ channelType: string; channelConnectionId: string | null; enabled: boolean; deliveryMode: string | null }> },
  ): EffectiveEventPreference {
    const d = definition.defaultPreferences;
    // The flag, not the row count: a user who cleared every destination has zero
    // rows and means "nowhere", while a user who only changed the delivery mode also
    // has zero rows and means "still the default".
    const routesOverridden = row?.routesOverridden === true;

    const routes: EffectiveEventRoute[] = routesOverridden
      ? (row!.routes ?? []).map((r) => ({
          channelType: r.channelType as NotificationChannelType,
          channelConnectionId: r.channelConnectionId,
          enabled: r.enabled,
          deliveryMode: (r.deliveryMode as NotificationDeliveryMode | null) ?? null,
        }))
      : d.channels.map((channelType) => ({
          channelType,
          channelConnectionId: null,
          enabled: true,
          deliveryMode: null,
        }));

    return {
      eventKey: definition.key,
      enabled: row?.enabled ?? d.enabled,
      deliveryMode: (row?.deliveryMode as NotificationDeliveryMode) ?? d.deliveryMode,
      quietHoursBehavior: (row?.quietHoursBehavior as QuietHoursBehavior) ?? d.quietHoursBehavior,
      minSeverity: (row?.minSeverity as EffectiveEventPreference['minSeverity']) ?? null,
      dedupeWindowSec: row?.dedupeWindowSec ?? definition.deduplication?.windowSeconds ?? null,
      aggregationWindowMin: row?.aggregationWindowMin ?? definition.aggregation?.defaultWindowMinutes ?? null,
      routes,
      isDefault: !row,
    };
  }

  /** Update one event's scalar settings, creating the override row on first write. */
  async setPreference(userId: string, eventKey: string, patch: PreferencePatch): Promise<EffectiveEventPreference> {
    const definition = getEventDefinition(eventKey);
    if (!definition) throw new NotFoundException('Unknown notification event');

    const data = {
      enabled: patch.enabled ?? undefined,
      deliveryMode: patch.deliveryMode ?? undefined,
      quietHoursBehavior: patch.quietHoursBehavior ?? undefined,
      minSeverity: patch.minSeverity ?? undefined,
      dedupeWindowSec: patch.dedupeWindowSec ?? undefined,
      aggregationWindowMin: patch.aggregationWindowMin ?? undefined,
    };
    await this.prisma.userNotificationPreference.upsert({
      where: { userId_eventKey: { userId, eventKey } },
      create: { userId, eventKey, ...data },
      update: data,
    });
    await this.audit.record({
      userId, action: 'notification.preference.updated',
      objectType: 'user_notification_preference', objectId: eventKey,
      metadata: { eventKey, ...patch },
    });
    return this.effectiveFor(userId, eventKey);
  }

  /**
   * Replace one event's destinations.
   *
   * **The ownership check is the security boundary of this whole feature.** A route
   * names a connection by id, so without verifying that the connection belongs to the
   * acting user, anyone could route their own events through someone else's Telegram
   * chat or email address — reading another person's destination and, worse, sending
   * to it. The database cannot express that constraint (it spans preference → user
   * and connection → user), so it is enforced here and pinned by a regression test.
   */
  async setRoutes(userId: string, eventKey: string, routes: RouteInput[]): Promise<EffectiveEventPreference> {
    const definition = getEventDefinition(eventKey);
    if (!definition) throw new NotFoundException('Unknown notification event');

    const wanted = routes.filter((r) => r.enabled !== false);
    for (const r of wanted) {
      if (!definition.supportedChannels.includes(r.channelType)) {
        throw new BadRequestException(`Event ${eventKey} does not support the ${r.channelType} channel`);
      }
      if (requiresConnection(r.channelType) && !r.channelConnectionId) {
        throw new BadRequestException(`A ${r.channelType} route requires a connection`);
      }
      if (!requiresConnection(r.channelType) && r.channelConnectionId) {
        throw new BadRequestException('The in-app route takes no connection');
      }
    }

    const connectionIds = [...new Set(wanted.map((r) => r.channelConnectionId).filter(Boolean))] as string[];
    if (connectionIds.length) {
      const owned = await this.prisma.userNotificationChannel.findMany({
        where: { id: { in: connectionIds }, userId, deletedAt: null },
        select: { id: true, type: true },
      });
      const ownedById = new Map(owned.map((c) => [c.id, c.type]));
      // Only connection-backed routes are checked. The in-app route legitimately
      // carries no connection id, and including it here would look up `undefined`
      // and reject a perfectly valid selection.
      for (const r of wanted) {
        const id = r.channelConnectionId;
        if (!id) continue;
        if (!ownedById.has(id)) {
          this.logger.warn(`User "${userId}" attempted to route ${eventKey} via connection "${id}" they do not own.`);
          // Same message as a missing connection: distinguishing them would confirm
          // that another user's connection exists.
          throw new NotFoundException('Connection not found');
        }
        if (ownedById.get(id) !== r.channelType) {
          throw new BadRequestException('Connection type does not match the route');
        }
      }
    }

    const pref = await this.prisma.userNotificationPreference.upsert({
      where: { userId_eventKey: { userId, eventKey } },
      create: { userId, eventKey, routesOverridden: true },
      update: { routesOverridden: true },
    });
    await this.prisma.userNotificationEventRoute.deleteMany({ where: { preferenceId: pref.id } });
    if (wanted.length) {
      await this.prisma.userNotificationEventRoute.createMany({
        data: wanted.map((r) => ({
          preferenceId: pref.id,
          channelType: r.channelType,
          channelConnectionId: r.channelConnectionId ?? null,
          enabled: true,
          deliveryMode: r.deliveryMode ?? null,
        })),
        skipDuplicates: true,
      });
    }
    await this.audit.record({
      userId, action: 'notification.routes.updated',
      objectType: 'user_notification_preference', objectId: eventKey,
      metadata: { eventKey, routes: wanted.map((r) => ({ type: r.channelType, connectionId: r.channelConnectionId })) },
    });
    return this.effectiveFor(userId, eventKey);
  }

  /**
   * Apply one change across many events.
   *
   * Reports what it skipped rather than silently dropping it: asking for Telegram on
   * 40 events where 3 do not support it should say so, not quietly do 37 and look
   * like it did 40.
   */
  async bulk(
    userId: string,
    eventKeys: string[],
    action:
      | { kind: 'enable_channel'; channelType: NotificationChannelType; channelConnectionId?: string | null }
      | { kind: 'disable_channel'; channelType: NotificationChannelType }
      | { kind: 'set_delivery_mode'; deliveryMode: NotificationDeliveryMode }
      | { kind: 'set_enabled'; enabled: boolean }
      | { kind: 'reset' },
  ): Promise<BulkResult> {
    const result: BulkResult = { applied: 0, skipped: [] };

    // Validate a named connection ONCE, not per event.
    if (action.kind === 'enable_channel' && action.channelConnectionId) {
      const owned = await this.prisma.userNotificationChannel.findFirst({
        where: { id: action.channelConnectionId, userId, deletedAt: null },
        select: { id: true, type: true, verifiedAt: true },
      });
      if (!owned) throw new NotFoundException('Connection not found');
      if (owned.type !== action.channelType) throw new BadRequestException('Connection type does not match');
    }

    for (const eventKey of eventKeys) {
      const definition = getEventDefinition(eventKey);
      if (!definition || definition.deprecated) {
        result.skipped.push({ eventKey, reason: definition ? 'deprecated_event' : 'unknown_event' });
        continue;
      }
      try {
        switch (action.kind) {
          case 'set_enabled':
            await this.setPreference(userId, eventKey, { enabled: action.enabled });
            break;
          case 'set_delivery_mode':
            await this.setPreference(userId, eventKey, { deliveryMode: action.deliveryMode });
            break;
          case 'reset':
            await this.resetEvent(userId, eventKey);
            break;
          case 'enable_channel': {
            if (!definition.supportedChannels.includes(action.channelType)) {
              result.skipped.push({ eventKey, reason: 'channel_not_supported' });
              continue;
            }
            const current = await this.effectiveFor(userId, eventKey);
            const next = current.routes.filter(
              (r) => !(r.channelType === action.channelType && r.channelConnectionId === (action.channelConnectionId ?? null)),
            );
            next.push({
              channelType: action.channelType,
              channelConnectionId: action.channelConnectionId ?? null,
              enabled: true,
              deliveryMode: null,
            });
            await this.setRoutes(userId, eventKey, next);
            break;
          }
          case 'disable_channel': {
            const current = await this.effectiveFor(userId, eventKey);
            const next = current.routes.filter((r) => r.channelType !== action.channelType);
            await this.setRoutes(userId, eventKey, next);
            break;
          }
        }
        result.applied += 1;
      } catch (err) {
        result.skipped.push({ eventKey, reason: (err as Error).message });
      }
    }

    await this.audit.record({
      userId, action: 'notification.preferences.bulk_updated',
      objectType: 'user_notification_preference',
      metadata: { action: action.kind, requested: eventKeys.length, applied: result.applied, skipped: result.skipped.length },
    });
    return result;
  }

  /** Drop one event's override, returning it to the catalogue default. */
  async resetEvent(userId: string, eventKey: string): Promise<EffectiveEventPreference> {
    if (!getEventDefinition(eventKey)) throw new NotFoundException('Unknown notification event');
    await this.prisma.userNotificationPreference.deleteMany({ where: { userId, eventKey } });
    await this.audit.record({
      userId, action: 'notification.preference.reset',
      objectType: 'user_notification_preference', objectId: eventKey, metadata: { eventKey },
    });
    return this.effectiveFor(userId, eventKey);
  }

  /** Drop every override for this user. Connections are untouched. */
  async resetAll(userId: string): Promise<{ cleared: number }> {
    const { count } = await this.prisma.userNotificationPreference.deleteMany({ where: { userId } });
    await this.audit.record({
      userId, action: 'notification.preferences.reset_all',
      objectType: 'user_notification_preference', metadata: { cleared: count },
    });
    return { cleared: count };
  }
}
