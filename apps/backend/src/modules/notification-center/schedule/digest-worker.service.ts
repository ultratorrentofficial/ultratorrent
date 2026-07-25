import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { NotificationRecipientEligibilityService } from '../recipient-eligibility.service';
import { assembleDigest, renderDigestText, type DigestCandidate } from './digest-assembler';
import { nextDailyDigestAt, nextWeeklyDigestAt } from './quiet-hours';

export interface DigestRunSummary {
  considered: number;
  sent: number;
  empty: number;
  skipped: number;
}

/** How far back a first-ever digest reaches, so it cannot summarise all history. */
const MAX_LOOKBACK_MS = 7 * 24 * 3600_000;

/**
 * Assembles and sends daily and weekly digests.
 *
 * A digest is itself delivered like any other notification: it becomes an in-app
 * record and one delivery per destination the user had already chosen for the events
 * it contains. Sending it somewhere they had not selected would be a new global
 * routing decision, which is exactly what this engine removed.
 *
 * Idempotency is a unique `(userId, kind, periodEnd)` row, claimed BEFORE assembly:
 * a restart mid-run cannot produce a second copy of Tuesday's digest, and a duplicate
 * digest is far more annoying than a late one.
 *
 * An empty period is recorded as `empty` and produces no message — a digest saying
 * "nothing happened" is noise, and recording it is what stops the period being
 * re-checked forever.
 */
@Injectable()
export class NotificationDigestWorker {
  private readonly logger = new Logger(NotificationDigestWorker.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: NotificationRecipientEligibilityService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Checked every 5 minutes; each user's own schedule decides what is due. */
  @Interval('personal_notification_digests', 5 * 60_000)
  scheduled(): void {
    void this.run().catch((err) => this.logger.warn(`Digest run failed: ${(err as Error).message}`));
  }

  async run(now = new Date()): Promise<DigestRunSummary> {
    const summary: DigestRunSummary = { considered: 0, sent: 0, empty: 0, skipped: 0 };
    if (this.running) return summary;
    this.running = true;
    try {
      const profiles = await this.prisma.userNotificationProfile.findMany({
        where: { OR: [{ digestDaily: true }, { digestWeekly: true }] },
      });
      summary.considered = profiles.length;

      for (const profile of profiles) {
        for (const kind of ['daily', 'weekly'] as const) {
          const enabled = kind === 'daily' ? profile.digestDaily : profile.digestWeekly;
          if (!enabled) continue;
          try {
            await this.runOne(profile, kind, now, summary);
          } catch (err) {
            // One user's digest failing must not stop everyone else's.
            this.logger.warn(`Digest (${kind}) for ${profile.userId} failed: ${(err as Error).message}`);
          }
        }
      }
    } finally {
      this.running = false;
    }
    return summary;
  }

  private async runOne(
    profile: any,
    kind: 'daily' | 'weekly',
    now: Date,
    summary: DigestRunSummary,
  ): Promise<void> {
    // A paused or ineligible account gets nothing, re-checked at send time rather
    // than trusted from when the schedule was set.
    if (profile.pausedUntil && profile.pausedUntil.getTime() > now.getTime()) {
      summary.skipped += 1;
      return;
    }
    if (!(await this.eligibility.isEligible(profile.userId))) {
      summary.skipped += 1;
      return;
    }

    const last = await this.prisma.notificationDigest.findFirst({
      where: { userId: profile.userId, kind },
      orderBy: { periodEnd: 'desc' },
    });

    // The next due instant after the last period ended. With no history, look back
    // one scheduling interval rather than over all time.
    const from = last?.periodEnd ?? new Date(now.getTime() - MAX_LOOKBACK_MS);
    const due = kind === 'daily'
      ? nextDailyDigestAt(profile, from)
      : nextWeeklyDigestAt(profile, from);
    if (!due || due.getTime() > now.getTime()) return; // not yet

    // Claim the period BEFORE assembling, so a crash mid-run cannot duplicate it.
    let claimed;
    try {
      claimed = await this.prisma.notificationDigest.create({
        data: { userId: profile.userId, kind, periodStart: from, periodEnd: due, status: 'pending' },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return; // another run claimed it
      throw err;
    }

    const rows = await this.prisma.userNotification.findMany({
      where: {
        userId: profile.userId,
        createdAt: { gte: from, lt: due },
        archivedAt: null,
      },
      orderBy: { lastAt: 'desc' },
      take: 500,
    });

    const candidates: DigestCandidate[] = rows.map((r) => ({
      id: r.id, eventKey: r.eventKey, category: r.category, severity: r.severity,
      title: r.title, groupCount: r.groupCount, lastAt: r.lastAt,
    }));
    const digest = assembleDigest(candidates);

    if (digest.isEmpty) {
      // Recorded, so the period is not re-checked forever — but no message: a
      // digest saying "nothing happened" is noise.
      await this.prisma.notificationDigest.update({
        where: { id: claimed.id }, data: { status: 'empty', sentAt: now },
      });
      summary.empty += 1;
      return;
    }

    const heading = kind === 'daily' ? 'Daily notification digest' : 'Weekly notification digest';
    const body = renderDigestText(digest, heading);

    const record = await this.prisma.userNotification.create({
      data: {
        userId: profile.userId,
        eventKey: `notification.digest.${kind}`,
        category: 'account',
        severity: digest.topSeverity,
        title: heading,
        body,
        payload: { itemCount: digest.itemCount, occurrences: digest.occurrenceCount, overflow: digest.overflow },
        dedupeKey: `digest:${kind}:${due.toISOString()}`,
      },
    });
    this.realtime.toUser(profile.userId, 'account.notification.created', {
      id: record.id, eventKey: record.eventKey, severity: record.severity,
      title: heading, at: record.createdAt.toISOString(),
    });

    // Deliver to the destinations the user already chose for the digested events —
    // never to a destination they did not select.
    const destinations = await this.destinationsFor(profile.userId, rows.map((r) => r.eventKey));
    for (const d of destinations) {
      await this.prisma.userNotificationDelivery.create({
        data: {
          userId: profile.userId, notificationId: record.id,
          eventKey: record.eventKey, channelType: d.channelType, channelId: d.channelConnectionId,
          status: 'queued', nextAttemptAt: now,
          dedupeKey: `digest:${kind}:${due.toISOString()}:${d.channelType}:${d.channelConnectionId}`,
        },
      }).catch((err) => {
        if ((err as { code?: string }).code !== 'P2002') throw err;
      });
    }

    await this.prisma.notificationDigest.update({
      where: { id: claimed.id },
      data: { status: 'sent', sentAt: now, itemCount: digest.itemCount, overflow: digest.overflow },
    });
    summary.sent += 1;
  }

  /**
   * The verified external destinations this user selected for the digested events.
   *
   * Deduplicated across events, because a digest is one message: three events all
   * routed to the same Telegram chat must not send it three times.
   */
  private async destinationsFor(
    userId: string,
    eventKeys: string[],
  ): Promise<Array<{ channelType: string; channelConnectionId: string }>> {
    if (!eventKeys.length) return [];
    const prefs = await this.prisma.userNotificationPreference.findMany({
      where: { userId, eventKey: { in: [...new Set(eventKeys)] } },
      include: { routes: true },
    });
    const wanted = new Map<string, { channelType: string; channelConnectionId: string }>();
    for (const p of prefs) {
      for (const r of p.routes) {
        if (!r.channelConnectionId || r.channelType === 'in_app') continue;
        wanted.set(`${r.channelType}:${r.channelConnectionId}`, {
          channelType: r.channelType, channelConnectionId: r.channelConnectionId,
        });
      }
    }
    if (!wanted.size) return [];
    // Only enabled, verified, still-existing connections.
    const ids = [...wanted.values()].map((w) => w.channelConnectionId);
    const usable = await this.prisma.userNotificationChannel.findMany({
      where: { id: { in: ids }, userId, deletedAt: null, enabled: true, verifiedAt: { not: null } },
      select: { id: true },
    });
    const usableIds = new Set(usable.map((u) => u.id));
    return [...wanted.values()].filter((w) => usableIds.has(w.channelConnectionId));
  }
}
