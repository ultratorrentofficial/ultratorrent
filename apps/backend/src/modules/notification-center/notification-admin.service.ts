import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { parsePage, pageOf } from '../../common/pagination';
import { NotificationChannelService } from './channel.service';
import { NotificationRecipientService } from './recipient.service';
import { getNotificationProvider } from './provider-registry';
import { buildMessage, type TemplateBodies, type TemplateVars } from './template-render';
import type { NotificationAddress, NotificationKind } from './notification-provider';

/** Templates, rules, history, queue, dashboard, preferences and manual test sends. */
@Injectable()
export class NotificationAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly channels: NotificationChannelService,
    private readonly recipients: NotificationRecipientService,
  ) {}

  // --- templates -----------------------------------------------------------
  listTemplates() {
    return this.prisma.notificationTemplate.findMany({ orderBy: { name: 'asc' } });
  }
  async createTemplate(input: Record<string, unknown>, userId?: string) {
    const row = await this.prisma.notificationTemplate.create({ data: this.templateData(input) });
    await this.audit.record({ userId, action: 'notification.template.created', objectType: 'notification_template', objectId: row.id });
    return row;
  }
  async updateTemplate(id: string, input: Record<string, unknown>, userId?: string) {
    const row = await this.prisma.notificationTemplate.update({ where: { id }, data: this.templateData(input, true) });
    await this.audit.record({ userId, action: 'notification.template.updated', objectType: 'notification_template', objectId: id });
    return row;
  }
  async removeTemplate(id: string, userId?: string) {
    await this.prisma.notificationTemplate.delete({ where: { id } });
    await this.audit.record({ userId, action: 'notification.template.deleted', objectType: 'notification_template', objectId: id });
    return { ok: true };
  }
  private templateData(input: Record<string, unknown>, partial = false) {
    const data: Record<string, unknown> = {};
    for (const k of ['name', 'description', 'event', 'subject', 'title', 'subtitle', 'html', 'text', 'markdown', 'sms', 'whatsapp', 'telegram', 'locale']) {
      if (!partial || input[k] !== undefined) data[k] = input[k] ?? (k === 'name' ? 'Template' : null);
    }
    if (input.card !== undefined) data.card = input.card;
    if (input.variables !== undefined) data.variables = input.variables;
    return data as never;
  }
  /** Render a template (or ad-hoc bodies) with sample/provided vars for a provider kind. */
  async previewTemplate(input: { templateId?: string; body?: TemplateBodies; kind?: NotificationKind; variables?: TemplateVars }) {
    let tpl: TemplateBodies = input.body ?? {};
    if (input.templateId) {
      const t = await this.prisma.notificationTemplate.findUnique({ where: { id: input.templateId } });
      if (!t) throw new NotFoundException('Template not found');
      tpl = t as unknown as TemplateBodies;
    }
    const kind = input.kind ?? 'email';
    const vars: TemplateVars = { mediaTitle: 'Dune: Part Two', episodeTitle: null, userDisplayName: 'Dennis', year: 2024, overview: 'Paul Atreides unites with the Fremen…', rating: 8.4, posterUrl: '', serverName: 'PLEX', libraryName: 'Movies', watchUrl: 'https://example/watch', eventTime: new Date().toISOString(), ...(input.variables ?? {}) };
    return buildMessage(tpl, vars, kind);
  }

  // --- rules ---------------------------------------------------------------
  listRules() {
    return this.prisma.notificationRule.findMany({ orderBy: [{ priority: 'desc' }, { name: 'asc' }] });
  }
  getRule(id: string) {
    return this.prisma.notificationRule.findUnique({ where: { id } });
  }
  async createRule(input: Record<string, unknown>, userId?: string) {
    if (!input.event) throw new BadRequestException('event is required');
    const row = await this.prisma.notificationRule.create({ data: this.ruleData(input) });
    await this.audit.record({ userId, action: 'notification.rule.created', objectType: 'notification_rule', objectId: row.id });
    return row;
  }
  async updateRule(id: string, input: Record<string, unknown>, userId?: string) {
    const row = await this.prisma.notificationRule.update({ where: { id }, data: this.ruleData(input, true) });
    await this.audit.record({ userId, action: 'notification.rule.updated', objectType: 'notification_rule', objectId: id });
    return row;
  }
  async removeRule(id: string, userId?: string) {
    await this.prisma.notificationRule.delete({ where: { id } });
    await this.audit.record({ userId, action: 'notification.rule.deleted', objectType: 'notification_rule', objectId: id });
    return { ok: true };
  }
  private ruleData(input: Record<string, unknown>, partial = false) {
    const data: Record<string, unknown> = {};
    for (const k of ['name', 'description', 'event', 'templateId']) {
      if (!partial || input[k] !== undefined) data[k] = input[k] ?? null;
    }
    if (input.enabled !== undefined) data.enabled = Boolean(input.enabled);
    if (input.priority !== undefined) data.priority = Number(input.priority);
    if (input.severity !== undefined) data.severity = String(input.severity);
    if (input.dedupeWindowSec !== undefined) data.dedupeWindowSec = Number(input.dedupeWindowSec);
    if (input.quietHoursOverride !== undefined) data.quietHoursOverride = Boolean(input.quietHoursOverride);
    if (input.rateLimitPerHour !== undefined) data.rateLimitPerHour = input.rateLimitPerHour;
    for (const k of ['conditions', 'recipients', 'channelIds', 'variables', 'retryPolicy', 'escalationPolicy', 'schedule', 'tags']) {
      if (input[k] !== undefined) data[k] = input[k];
    }
    if (data.name == null && !partial) data.name = 'Rule';
    return data as never;
  }

  // --- history + queue -----------------------------------------------------
  async history(q: { page?: string; pageSize?: string; status?: string; channelId?: string; event?: string }) {
    const params = parsePage(q.page, q.pageSize, 50);
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.channelId ? { channelId: q.channelId } : {}),
      ...(q.event ? { event: q.event } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.notificationDelivery.findMany({ where, orderBy: { createdAt: 'desc' }, skip: params.skip, take: params.take }),
      this.prisma.notificationDelivery.count({ where }),
    ]);
    // Redact destination + rendered body in list views.
    const items = rows.map((r) => ({ ...r, destination: r.destination ? maskDestination(r.destination) : null, renderedBody: undefined }));
    return pageOf(items, total, params);
  }

  async queue(q: { page?: string; pageSize?: string }) {
    const params = parsePage(q.page, q.pageSize, 50);
    const where = { status: { in: ['queued', 'retrying', 'throttled', 'sending'] } };
    const [rows, total] = await Promise.all([
      this.prisma.notificationDelivery.findMany({ where, orderBy: [{ priority: 'desc' }, { nextAttemptAt: 'asc' }], skip: params.skip, take: params.take }),
      this.prisma.notificationDelivery.count({ where }),
    ]);
    const items = rows.map((r) => ({ ...r, destination: r.destination ? maskDestination(r.destination) : null, renderedBody: undefined }));
    return pageOf(items, total, params);
  }

  // --- dashboard -----------------------------------------------------------
  async dashboard() {
    const [channels, recipients, rules, byStatus, providerHealth, recent] = await Promise.all([
      this.prisma.notificationChannel.count(),
      this.prisma.notificationRecipient.count(),
      this.prisma.notificationRule.count({ where: { enabled: true } }),
      this.prisma.notificationDelivery.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.notificationChannel.groupBy({ by: ['healthStatus'], _count: { _all: true } }),
      this.prisma.notificationDelivery.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    const status = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]));
    const sent = (status.sent ?? 0) + (status.delivered ?? 0);
    const failed = status.failed ?? 0;
    const total = sent + failed;
    return {
      channels,
      recipients,
      enabledRules: rules,
      queueSize: (status.queued ?? 0) + (status.retrying ?? 0) + (status.throttled ?? 0),
      statusCounts: status,
      successRate: total ? Math.round((sent / total) * 100) : null,
      providerHealth: Object.fromEntries(providerHealth.map((p) => [p.healthStatus, p._count._all])),
      recent: recent.map((r) => ({ ...r, destination: r.destination ? maskDestination(r.destination) : null, renderedBody: undefined })),
    };
  }

  // --- preferences ---------------------------------------------------------
  listPreferences(recipientId: string) {
    return this.prisma.notificationPreference.findMany({ where: { recipientId } });
  }
  async setPreference(input: { recipientId: string; event: string; channel?: string | null; enabled: boolean }, userId?: string) {
    // Compound uniques containing a nullable column can't be targeted via upsert,
    // so find-then-write.
    const existing = await this.prisma.notificationPreference.findFirst({
      where: { recipientId: input.recipientId, event: input.event, channel: input.channel ?? null },
    });
    const row = existing
      ? await this.prisma.notificationPreference.update({ where: { id: existing.id }, data: { enabled: input.enabled } })
      : await this.prisma.notificationPreference.create({ data: { recipientId: input.recipientId, event: input.event, channel: input.channel ?? null, enabled: input.enabled } });
    await this.audit.record({ userId, action: 'notification.preference.updated', objectType: 'notification_preference', objectId: row.id });
    return row;
  }

  /** One recipient's routing profile — every "this event → these channels" line. */
  listRouting(recipientId: string) {
    return this.prisma.notificationRouting.findMany({
      where: { recipientId },
      orderBy: { event: 'asc' },
    });
  }

  /**
   * Set (or clear) one line of a recipient's routing profile.
   *
   * An empty `channelIds` DELETES the line rather than storing an empty selection:
   * "no opinion, inherit" and "send nowhere" must not be the same state, and only a
   * missing row can mean the former. Silencing an event stays
   * {@link setPreference}'s job.
   */
  async setRouting(input: { recipientId: string; event: string; channelIds: string[] }, userId?: string) {
    const event = input.event.trim();
    const channelIds = [...new Set((input.channelIds ?? []).filter(Boolean))];
    if (!channelIds.length) {
      const existing = await this.prisma.notificationRouting.findFirst({
        where: { recipientId: input.recipientId, event },
      });
      if (existing) {
        await this.prisma.notificationRouting.delete({ where: { id: existing.id } });
        await this.audit.record({ userId, action: 'notification.routing.cleared', objectType: 'notification_routing', objectId: existing.id });
      }
      return { recipientId: input.recipientId, event, channelIds: [] };
    }
    const row = await this.prisma.notificationRouting.upsert({
      where: { recipientId_event: { recipientId: input.recipientId, event } },
      create: { recipientId: input.recipientId, event, channelIds: channelIds as object },
      update: { channelIds: channelIds as object },
    });
    await this.audit.record({ userId, action: 'notification.routing.updated', objectType: 'notification_routing', objectId: row.id, metadata: { event, channelIds } });
    return row;
  }

  // --- module settings -----------------------------------------------------
  async getSettings() {
    const row = await this.prisma.setting.findUnique({ where: { key: 'notification_center.settings' } });
    const cfg = (row?.value as Record<string, unknown>) ?? {};
    return {
      brand: (cfg.brand as string) ?? 'UltraTorrent',
      defaultLocale: (cfg.defaultLocale as string) ?? 'en-US',
      logNotificationBodies: Boolean(cfg.logNotificationBodies), // off by default (security)
      globalRateLimitPerMin: (cfg.globalRateLimitPerMin as number) ?? null,
    };
  }
  async updateSettings(input: Record<string, unknown>, userId?: string) {
    const cur = (await this.prisma.setting.findUnique({ where: { key: 'notification_center.settings' } }))?.value as Record<string, unknown> ?? {};
    const next = { ...cur, ...input };
    await this.prisma.setting.upsert({ where: { key: 'notification_center.settings' }, create: { key: 'notification_center.settings', value: next as object }, update: { value: next as object } });
    await this.audit.record({ userId, action: 'notification.settings.updated', objectType: 'setting', objectId: 'notification_center.settings' });
    return this.getSettings();
  }

  // --- manual test send (bypasses the queue) -------------------------------
  async testSend(input: { channelId: string; recipientId?: string; address?: NotificationAddress; templateId?: string; variables?: TemplateVars }, userId?: string) {
    const channel = await this.prisma.notificationChannel.findUnique({ where: { id: input.channelId } });
    if (!channel) throw new NotFoundException('Channel not found');
    const provider = getNotificationProvider(channel.provider as NotificationKind);

    let addr = input.address;
    if (!addr && input.recipientId) {
      const r = await this.prisma.notificationRecipient.findUnique({ where: { id: input.recipientId } });
      if (r) addr = this.recipients.addressFor(r);
    }
    if (!addr || !provider.validateRecipient(addr)) throw new BadRequestException('A valid recipient address is required for this provider.');

    const tpl = input.templateId ? ((await this.prisma.notificationTemplate.findUnique({ where: { id: input.templateId } })) as unknown as TemplateBodies) : {};
    const vars: TemplateVars = { mediaTitle: 'UltraTorrent test notification', overview: 'This is a test from the Notification Center.', serverName: 'UltraTorrent', eventTime: new Date().toISOString(), ...(input.variables ?? {}) };
    const msg = buildMessage(tpl ?? {}, vars, channel.provider as NotificationKind);
    const result = await provider.send(this.channels.decryptConfig(channel), addr, msg);
    await this.audit.record({ userId, action: 'notification.test_send', objectType: 'notification_channel', objectId: channel.id, result: result.ok ? 'success' : 'failure' });
    return result;
  }
}

/** Mask an email/phone/chat-id for list views. */
function maskDestination(dest: string): string {
  if (dest.includes('@')) {
    const [u, d] = dest.split('@');
    return `${u.slice(0, 2)}***@${d}`;
  }
  return dest.length > 4 ? `${dest.slice(0, 3)}***${dest.slice(-2)}` : '***';
}
