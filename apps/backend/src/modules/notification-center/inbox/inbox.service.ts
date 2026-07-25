import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

export interface InboxQuery {
  page?: string;
  pageSize?: string;
  /** unread | read | archived | all — `all` excludes archived unless asked for. */
  state?: string;
  category?: string;
  severity?: string;
  eventKey?: string;
  search?: string;
}

export interface InboxItem {
  id: string;
  eventKey: string;
  category: string;
  severity: string;
  title: string;
  body: string | null;
  deepLink: string | null;
  read: boolean;
  archived: boolean;
  groupCount: number;
  lastAt: string;
  createdAt: string;
  /** Per-channel outcome for this notification, so "was it also emailed?" is answerable. */
  deliveries: Array<{ channelType: string; status: string }>;
}

/**
 * One user's in-app inbox.
 *
 * Every query is scoped by `userId`, taken from the JWT by the controller. There is
 * no method here that can read or mutate another person's inbox, and a notification
 * id belonging to someone else is reported as not found rather than forbidden, so a
 * response cannot confirm it exists.
 *
 * This replaces a legacy table whose `userId` was nullable and, on a live install,
 * null for every one of its 1,729 rows — meaning every in-app notification was a
 * broadcast to whoever happened to be connected.
 */
@Injectable()
export class NotificationInboxService {
  constructor(private readonly prisma: PrismaService) {}

  private where(userId: string, q: InboxQuery) {
    const where: Record<string, unknown> = { userId };
    switch (q.state) {
      case 'unread':
        where.readAt = null;
        where.archivedAt = null;
        break;
      case 'read':
        where.readAt = { not: null };
        where.archivedAt = null;
        break;
      case 'archived':
        where.archivedAt = { not: null };
        break;
      default:
        // Archived items are out of the way by default — that is what archiving is
        // for — and only appear when explicitly asked for.
        where.archivedAt = null;
    }
    if (q.category) where.category = q.category;
    if (q.severity) where.severity = q.severity;
    if (q.eventKey) where.eventKey = q.eventKey;
    if (q.search?.trim()) {
      where.OR = [
        { title: { contains: q.search.trim(), mode: 'insensitive' } },
        { body: { contains: q.search.trim(), mode: 'insensitive' } },
      ];
    }
    return where;
  }

  async list(userId: string, q: InboxQuery = {}) {
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 25) || 25));
    const where = this.where(userId, q);

    const [rows, total] = await Promise.all([
      this.prisma.userNotification.findMany({
        where,
        orderBy: { lastAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.userNotification.count({ where }),
    ]);

    // Delivery outcomes for the page in ONE query — per-row would be an N+1 on the
    // most-opened page in the product.
    const ids = rows.map((r) => r.id);
    const deliveries = ids.length
      ? await this.prisma.userNotificationDelivery.findMany({
          where: { userId, notificationId: { in: ids } },
          select: { notificationId: true, channelType: true, status: true },
        })
      : [];
    const byNotification = new Map<string, Array<{ channelType: string; status: string }>>();
    for (const d of deliveries) {
      if (!d.notificationId) continue;
      const list = byNotification.get(d.notificationId) ?? [];
      list.push({ channelType: d.channelType, status: d.status });
      byNotification.set(d.notificationId, list);
    }

    const items: InboxItem[] = rows.map((r) => ({
      id: r.id,
      eventKey: r.eventKey,
      category: r.category,
      severity: r.severity,
      title: r.title,
      body: r.body,
      deepLink: r.deepLink,
      read: r.readAt != null,
      archived: r.archivedAt != null,
      groupCount: r.groupCount,
      lastAt: r.lastAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      deliveries: byNotification.get(r.id) ?? [],
    }));

    return { items, total, page, pageSize };
  }

  /** Unread, excluding archived — the number the bell shows. */
  async unreadCount(userId: string): Promise<{ unread: number }> {
    const unread = await this.prisma.userNotification.count({
      where: { userId, readAt: null, archivedAt: null },
    });
    return { unread };
  }

  private async ownedOrThrow(userId: string, id: string) {
    const row = await this.prisma.userNotification.findFirst({ where: { id, userId } });
    // Same response as a genuinely missing row: distinguishing them would confirm
    // that another user's notification exists.
    if (!row) throw new NotFoundException('Notification not found');
    return row;
  }

  async setRead(userId: string, id: string, read: boolean) {
    await this.ownedOrThrow(userId, id);
    const row = await this.prisma.userNotification.update({
      where: { id },
      data: { readAt: read ? new Date() : null },
    });
    return { id: row.id, read: row.readAt != null };
  }

  async archive(userId: string, id: string) {
    await this.ownedOrThrow(userId, id);
    const row = await this.prisma.userNotification.update({
      where: { id },
      // Archiving implies reading it: an archived-but-unread item would keep the
      // bell lit for something the user has deliberately filed away.
      data: { archivedAt: new Date(), readAt: new Date() },
    });
    return { id: row.id, archived: true };
  }

  async markAllRead(userId: string) {
    const { count } = await this.prisma.userNotification.updateMany({
      where: { userId, readAt: null, archivedAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }

  async archiveRead(userId: string) {
    const { count } = await this.prisma.userNotification.updateMany({
      where: { userId, readAt: { not: null }, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    return { archived: count };
  }
}
