import { Injectable, NotFoundException } from '@nestjs/common';
import {
  isNotificationPresentation,
  type InboxNotification, type InboxPage,
  type NotificationCategory, type NotificationSeverity, type NotificationPresentation,
} from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface InboxQuery {
  page?: string;
  pageSize?: string;
  /** unread | read | archived | all — `all` excludes archived unless asked. */
  state?: string;
  category?: string;
  search?: string;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * One user's inbox.
 *
 * **Every query is scoped by `userId`**, which the controller takes from the JWT.
 * There is no method here that can read or mutate another person's inbox, and a
 * notification id belonging to someone else is reported as not found rather than
 * forbidden — a 403 would confirm the row exists.
 */
@Injectable()
export class NotificationInboxService {
  constructor(private readonly prisma: PrismaService) {}

  private where(userId: string, q: InboxQuery): Record<string, unknown> {
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
        // The default view is "not archived" — archiving is how a user clears
        // something, so showing it again by default would defeat the action.
        where.archivedAt = null;
    }

    if (q.category) where.category = q.category;
    if (q.search?.trim()) {
      const term = q.search.trim();
      where.OR = [
        { title: { contains: term, mode: 'insensitive' } },
        { body: { contains: term, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  async list(userId: string, q: InboxQuery): Promise<InboxPage> {
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(q.pageSize) || DEFAULT_PAGE_SIZE));
    const where = this.where(userId, q);

    const [rows, total] = await Promise.all([
      this.prisma.userNotification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.userNotification.count({ where }),
    ]);

    return { items: rows.map((r) => this.toDto(r)), total, page, pageSize };
  }

  /** Badge count: unread and not archived. */
  async unreadCount(userId: string): Promise<{ unread: number }> {
    const unread = await this.prisma.userNotification.count({
      where: { userId, readAt: null, archivedAt: null },
    });
    return { unread };
  }

  async setRead(userId: string, id: string, read: boolean): Promise<InboxNotification> {
    await this.assertOwned(userId, id);
    const row = await this.prisma.userNotification.update({
      where: { id },
      data: { readAt: read ? new Date() : null },
    });
    return this.toDto(row);
  }

  async archive(userId: string, id: string): Promise<InboxNotification> {
    await this.assertOwned(userId, id);
    const row = await this.prisma.userNotification.update({
      where: { id },
      // Archiving implies read: a user clearing something has dealt with it, and
      // leaving it counted in the badge would be a lie.
      data: { archivedAt: new Date(), readAt: new Date() },
    });
    return this.toDto(row);
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const result = await this.prisma.userNotification.updateMany({
      where: { userId, readAt: null, archivedAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  /**
   * Ownership check.
   *
   * A row belonging to someone else takes the same path as one that does not
   * exist, so the response cannot be used to probe for another user's ids.
   */
  private async assertOwned(userId: string, id: string): Promise<void> {
    const row = await this.prisma.userNotification.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Notification not found.');
  }

  private toDto(row: {
    id: string;
    eventKey: string;
    category: string;
    severity: string;
    title: string;
    body: string | null;
    deepLink: string | null;
    resourceType: string | null;
    resourceId: string | null;
    readAt: Date | null;
    archivedAt: Date | null;
    createdAt: Date;
    presentation?: unknown;
  }): InboxNotification {
    return {
      id: row.id,
      eventKey: row.eventKey,
      category: row.category as NotificationCategory,
      severity: row.severity as NotificationSeverity,
      title: row.title,
      body: row.body,
      deepLink: row.deepLink,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      read: row.readAt !== null,
      archived: row.archivedAt !== null,
      createdAt: row.createdAt.toISOString(),
      // Validated rather than cast: older rows predate the model, and an
      // unrecognised shape must degrade to a plain row rather than throw inside
      // the list and take every notification after it down.
      presentation: isNotificationPresentation(row.presentation)
        ? (row.presentation as NotificationPresentation)
        : null,
    };
  }
}
