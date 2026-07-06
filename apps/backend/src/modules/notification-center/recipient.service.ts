import { Injectable, NotFoundException } from '@nestjs/common';
import type { NotificationRecipient } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { NotificationAddress } from './notification-provider';

export interface RecipientSelection {
  recipientIds?: string[];
  groupIds?: string[];
  /** Resolve the recipient mapped to the event's user (payload.userId / recipientId). */
  mapEventUser?: boolean;
}

/** Manages recipients + groups and resolves a rule's audience. */
@Injectable()
export class NotificationRecipientService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // --- recipients ----------------------------------------------------------
  listRecipients() {
    return this.prisma.notificationRecipient.findMany({ orderBy: { displayName: 'asc' } });
  }

  async createRecipient(input: Record<string, unknown>, userId?: string) {
    const row = await this.prisma.notificationRecipient.create({
      data: {
        displayName: String(input.displayName ?? 'Recipient'),
        email: (input.email as string) ?? null,
        phone: (input.phone as string) ?? null,
        telegramChatId: (input.telegramChatId as string) ?? null,
        whatsappNumber: (input.whatsappNumber as string) ?? null,
        language: String(input.language ?? 'en-US'),
        timezone: (input.timezone as string) ?? null,
        preferredChannelId: (input.preferredChannelId as string) ?? null,
        enabled: input.enabled !== false,
        quietHours: ((input.quietHours as object) ?? {}) as object,
        preferences: ((input.preferences as object) ?? {}) as object,
        userId: (input.userId as string) ?? null,
      },
    });
    await this.audit.record({ userId, action: 'notification.recipient.created', objectType: 'notification_recipient', objectId: row.id });
    return row;
  }

  async updateRecipient(id: string, input: Record<string, unknown>, userId?: string) {
    const data: Record<string, unknown> = {};
    for (const k of ['displayName', 'email', 'phone', 'telegramChatId', 'whatsappNumber', 'language', 'timezone', 'preferredChannelId', 'userId']) {
      if (input[k] !== undefined) data[k] = input[k];
    }
    if (input.enabled !== undefined) data.enabled = Boolean(input.enabled);
    if (input.quietHours !== undefined) data.quietHours = input.quietHours;
    if (input.preferences !== undefined) data.preferences = input.preferences;
    const row = await this.prisma.notificationRecipient.update({ where: { id }, data });
    await this.audit.record({ userId, action: 'notification.recipient.updated', objectType: 'notification_recipient', objectId: id });
    return row;
  }

  async removeRecipient(id: string, userId?: string) {
    await this.prisma.notificationRecipientMember.deleteMany({ where: { recipientId: id } });
    await this.prisma.notificationRecipient.delete({ where: { id } });
    await this.audit.record({ userId, action: 'notification.recipient.deleted', objectType: 'notification_recipient', objectId: id });
    return { ok: true };
  }

  // --- groups --------------------------------------------------------------
  async listGroups() {
    const groups = await this.prisma.notificationRecipientGroup.findMany({ orderBy: { name: 'asc' } });
    const counts = await this.prisma.notificationRecipientMember.groupBy({ by: ['groupId'], _count: { _all: true } });
    const byGroup = new Map(counts.map((c) => [c.groupId, c._count._all]));
    return groups.map((g) => ({ ...g, memberCount: byGroup.get(g.id) ?? 0 }));
  }

  async createGroup(input: Record<string, unknown>, userId?: string) {
    const row = await this.prisma.notificationRecipientGroup.create({
      data: { name: String(input.name ?? 'Group'), description: (input.description as string) ?? null },
    });
    await this.audit.record({ userId, action: 'notification.group.created', objectType: 'notification_recipient_group', objectId: row.id });
    return row;
  }

  async removeGroup(id: string, userId?: string) {
    const g = await this.prisma.notificationRecipientGroup.findUnique({ where: { id } });
    if (!g) throw new NotFoundException('Group not found');
    await this.prisma.notificationRecipientMember.deleteMany({ where: { groupId: id } });
    await this.prisma.notificationRecipientGroup.delete({ where: { id } });
    await this.audit.record({ userId, action: 'notification.group.deleted', objectType: 'notification_recipient_group', objectId: id });
    return { ok: true };
  }

  async setGroupMembers(groupId: string, recipientIds: string[], userId?: string) {
    await this.prisma.notificationRecipientMember.deleteMany({ where: { groupId } });
    if (recipientIds.length) {
      await this.prisma.notificationRecipientMember.createMany({
        data: recipientIds.map((recipientId) => ({ groupId, recipientId })),
        skipDuplicates: true,
      });
    }
    await this.audit.record({ userId, action: 'notification.group.members_updated', objectType: 'notification_recipient_group', objectId: groupId, metadata: { count: recipientIds.length } });
    return { ok: true };
  }

  // --- resolution ----------------------------------------------------------
  /** Resolve a rule's audience to enabled, deduped recipients. */
  async resolve(sel: RecipientSelection, payload: Record<string, unknown>): Promise<NotificationRecipient[]> {
    const ids = new Set<string>(sel.recipientIds ?? []);
    if (sel.groupIds?.length) {
      const members = await this.prisma.notificationRecipientMember.findMany({ where: { groupId: { in: sel.groupIds } }, select: { recipientId: true } });
      members.forEach((m) => ids.add(m.recipientId));
    }
    if (sel.mapEventUser) {
      const uid = payload.userId ?? payload.recipientId;
      if (uid) {
        const mapped = await this.prisma.notificationRecipient.findFirst({ where: { userId: String(uid) } });
        if (mapped) ids.add(mapped.id);
      }
    }
    if (ids.size === 0) return [];
    return this.prisma.notificationRecipient.findMany({ where: { id: { in: [...ids] }, enabled: true } });
  }

  /** Build the provider address for a recipient. */
  addressFor(r: NotificationRecipient): NotificationAddress {
    return {
      email: r.email,
      phone: r.phone,
      telegramChatId: r.telegramChatId,
      whatsappNumber: r.whatsappNumber ?? r.phone,
    };
  }
}
