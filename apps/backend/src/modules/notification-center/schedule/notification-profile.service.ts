import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { parseHhMm, nextDailyDigestAt, nextWeeklyDigestAt } from './quiet-hours';

export interface ProfilePatch {
  timezone?: string | null;
  locale?: string | null;
  quietHoursEnabled?: boolean;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  quietHoursDays?: number[];
  digestDaily?: boolean;
  digestDailyAt?: string | null;
  digestWeekly?: boolean;
  digestWeeklyDay?: number | null;
  digestWeeklyAt?: string | null;
}

/**
 * Profile-wide personal notification settings: timezone, quiet hours, digests and
 * the global pause.
 *
 * The row is created lazily — its absence means "all defaults" — so a user who never
 * opens this page costs nothing and still behaves predictably.
 */
@Injectable()
export class NotificationProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(userId: string) {
    const row = await this.prisma.userNotificationProfile.findUnique({ where: { userId } });
    const profile = row ?? {
      userId, timezone: null, locale: null,
      quietHoursEnabled: false, quietHoursStart: null, quietHoursEnd: null, quietHoursDays: [],
      digestDaily: false, digestDailyAt: null,
      digestWeekly: false, digestWeeklyDay: null, digestWeeklyAt: null,
      pausedUntil: null, onboardedAt: null,
    };
    const now = new Date();
    return {
      ...profile,
      // Computed, so the UI can say "next digest: tomorrow 08:00" rather than
      // making the user work it out from a time and a timezone.
      nextDailyDigestAt: nextDailyDigestAt(profile as never, now)?.toISOString() ?? null,
      nextWeeklyDigestAt: nextWeeklyDigestAt(profile as never, now)?.toISOString() ?? null,
      paused: profile.pausedUntil != null && profile.pausedUntil.getTime() > now.getTime(),
    };
  }

  async update(userId: string, patch: ProfilePatch) {
    // Validate BEFORE writing: a stored "25:00" would silently disable quiet hours
    // rather than failing, which is the kind of bug nobody reports.
    for (const [field, value] of [
      ['quietHoursStart', patch.quietHoursStart],
      ['quietHoursEnd', patch.quietHoursEnd],
      ['digestDailyAt', patch.digestDailyAt],
      ['digestWeeklyAt', patch.digestWeeklyAt],
    ] as const) {
      if (value != null && value !== '' && parseHhMm(value) == null) {
        throw new BadRequestException(`${field} must be a time in HH:mm`);
      }
    }
    if (patch.quietHoursDays?.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new BadRequestException('quietHoursDays must be integers 0-6');
    }
    if (patch.digestWeeklyDay != null && (patch.digestWeeklyDay < 0 || patch.digestWeeklyDay > 6)) {
      throw new BadRequestException('digestWeeklyDay must be 0-6');
    }
    if (patch.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: patch.timezone });
      } catch {
        throw new BadRequestException('Unknown timezone');
      }
    }

    const data = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    );
    await this.prisma.userNotificationProfile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    await this.audit.record({
      userId, action: 'notification.profile.updated',
      objectType: 'user_notification_profile', objectId: userId,
      metadata: { fields: Object.keys(data) },
    });
    return this.get(userId);
  }

  /** Pause everything until `until`, or indefinitely when omitted. */
  async pause(userId: string, until?: string | null) {
    const pausedUntil = until ? new Date(until) : new Date(Date.now() + 365 * 24 * 3600_000);
    if (Number.isNaN(pausedUntil.getTime())) throw new BadRequestException('Invalid pause time');
    await this.prisma.userNotificationProfile.upsert({
      where: { userId },
      create: { userId, pausedUntil },
      update: { pausedUntil },
    });
    await this.audit.record({
      userId, action: 'notification.profile.paused',
      objectType: 'user_notification_profile', objectId: userId,
      metadata: { until: pausedUntil.toISOString() },
    });
    return this.get(userId);
  }

  async resume(userId: string) {
    await this.prisma.userNotificationProfile.upsert({
      where: { userId },
      create: { userId, pausedUntil: null },
      update: { pausedUntil: null },
    });
    await this.audit.record({
      userId, action: 'notification.profile.resumed',
      objectType: 'user_notification_profile', objectId: userId,
    });
    return this.get(userId);
  }
}
