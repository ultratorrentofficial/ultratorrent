import { Injectable } from '@nestjs/common';
import {
  defaultPreferenceFor,
  type NotificationEventRow,
  type NotificationPreference,
} from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { allNotificationEvents, getNotificationEvent } from './notification-catalog';

/** The fields a user may change. All optional — a patch touches what it names. */
export interface PreferencePatch {
  enabled?: boolean;
  inAppEnabled?: boolean;
  emailEnabled?: boolean;
  telegramEnabled?: boolean;
  discordEnabled?: boolean;
}

/**
 * One user's answers, resolved against the catalogue.
 *
 * **Lazy overrides.** A row exists only once someone changes something; a user
 * who has never opened the page has none and gets catalogue defaults. That keeps
 * adding an event to the catalogue from being a data migration across every
 * account, and it means "reset" is a delete rather than a rewrite.
 *
 * Every method takes `userId` from the caller, which takes it from the JWT. No
 * method here can address another person's preferences.
 */
@Injectable()
export class NotificationPreferenceService {
  constructor(private readonly prisma: PrismaService) {}

  /** The full Events table for one user: every catalogued event, plus their answer. */
  async listFor(userId: string): Promise<NotificationEventRow[]> {
    const stored = await this.prisma.userNotificationPreference.findMany({ where: { userId } });
    const byKey = new Map(stored.map((row) => [row.eventKey, row]));

    return allNotificationEvents().map((definition) => {
      const row = byKey.get(definition.key);
      return {
        definition,
        preference: row ? this.toPreference(row) : defaultPreferenceFor(definition),
        customized: !!row,
      };
    });
  }

  /** One event's effective preference — what dispatch reads. */
  async effectiveFor(userId: string, eventKey: string): Promise<NotificationPreference | null> {
    const definition = getNotificationEvent(eventKey);
    if (!definition) return null;
    const row = await this.prisma.userNotificationPreference.findUnique({
      where: { userId_eventKey: { userId, eventKey } },
    });
    return row ? this.toPreference(row) : defaultPreferenceFor(definition);
  }

  /**
   * Resolve many users' preferences for one event in a single query.
   *
   * Dispatch asks this once per event with the whole audience. Per-user queries
   * would put one round trip per recipient on every published event.
   */
  async effectiveForMany(
    userIds: readonly string[],
    eventKey: string,
  ): Promise<Map<string, NotificationPreference>> {
    const definition = getNotificationEvent(eventKey);
    const out = new Map<string, NotificationPreference>();
    if (!definition || !userIds.length) return out;

    const rows = await this.prisma.userNotificationPreference.findMany({
      where: { userId: { in: [...userIds] }, eventKey },
    });
    const byUser = new Map(rows.map((row) => [row.userId, row]));

    for (const userId of userIds) {
      const row = byUser.get(userId);
      out.set(userId, row ? this.toPreference(row) : defaultPreferenceFor(definition));
    }
    return out;
  }

  /**
   * Apply a patch, creating the override row on first change.
   *
   * The upsert seeds `create` from the catalogue default rather than from
   * `true` — otherwise a user toggling one channel on an off-by-default event
   * would silently also switch on everything else the row defaults to.
   */
  async update(
    userId: string,
    eventKey: string,
    patch: PreferencePatch,
  ): Promise<NotificationPreference | null> {
    const definition = getNotificationEvent(eventKey);
    if (!definition) return null;

    const base = defaultPreferenceFor(definition);
    const row = await this.prisma.userNotificationPreference.upsert({
      where: { userId_eventKey: { userId, eventKey } },
      create: {
        userId,
        eventKey,
        enabled: patch.enabled ?? base.enabled,
        inAppEnabled: patch.inAppEnabled ?? base.inAppEnabled,
        emailEnabled: patch.emailEnabled ?? base.emailEnabled,
        telegramEnabled: patch.telegramEnabled ?? base.telegramEnabled,
        discordEnabled: patch.discordEnabled ?? base.discordEnabled,
      },
      update: {
        ...(patch.enabled !== undefined && { enabled: patch.enabled }),
        ...(patch.inAppEnabled !== undefined && { inAppEnabled: patch.inAppEnabled }),
        ...(patch.emailEnabled !== undefined && { emailEnabled: patch.emailEnabled }),
        ...(patch.telegramEnabled !== undefined && { telegramEnabled: patch.telegramEnabled }),
        ...(patch.discordEnabled !== undefined && { discordEnabled: patch.discordEnabled }),
      },
    });
    return this.toPreference(row);
  }

  /**
   * Apply one patch to many events.
   *
   * Reports what it skipped rather than dropping it silently: asking for 20
   * events where 2 are not catalogued should say so, not look like it did all 20.
   */
  async updateMany(
    userId: string,
    eventKeys: readonly string[],
    patch: PreferencePatch,
  ): Promise<{ updated: number; skipped: string[] }> {
    const skipped: string[] = [];
    let updated = 0;
    for (const key of eventKeys) {
      const result = await this.update(userId, key, patch);
      if (result) updated += 1;
      else skipped.push(key);
    }
    return { updated, skipped };
  }

  /** Drop the override so the event follows catalogue defaults again. */
  async reset(userId: string, eventKey: string): Promise<void> {
    await this.prisma.userNotificationPreference
      .delete({ where: { userId_eventKey: { userId, eventKey } } })
      .catch(() => undefined); // already default
  }

  private toPreference(row: {
    eventKey: string;
    enabled: boolean;
    inAppEnabled: boolean;
    emailEnabled: boolean;
    telegramEnabled: boolean;
    discordEnabled: boolean;
  }): NotificationPreference {
    return {
      eventKey: row.eventKey,
      enabled: row.enabled,
      inAppEnabled: row.inAppEnabled,
      emailEnabled: row.emailEnabled,
      telegramEnabled: row.telegramEnabled,
      discordEnabled: row.discordEnabled,
    };
  }
}
