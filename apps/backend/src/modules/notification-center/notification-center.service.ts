import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { NotificationChannel, NotificationRecipient, NotificationRule } from '@prisma/client';
import { NOTIFICATION_BUS_CHANNEL, WS_EVENTS, type DomainEventEnvelope } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationRuleEngineService } from './rule-engine.service';
import { NotificationRecipientService, type RecipientSelection } from './recipient.service';
import { NotificationChannelService } from './channel.service';
import { NotificationDeliveryService } from './delivery.service';
import { getNotificationProvider } from './provider-registry';
import { buildMessage, type TemplateBodies, type TemplateVars } from './template-render';
import type { NotificationKind } from './notification-provider';

/**
 * The centralized notification pipeline. Modules publish domain events onto the
 * bus (NOTIFICATION_BUS_CHANNEL); this is the sole subscriber. It evaluates
 * rules, resolves recipients + channels, renders per-channel templates, applies
 * preferences, and enqueues deliveries. Also exposes publish() for the legacy
 * in-app dispatch adapter and tests.
 */
@Injectable()
export class NotificationCenterService {
  private readonly logger = new Logger(NotificationCenterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly rules: NotificationRuleEngineService,
    private readonly recipients: NotificationRecipientService,
    private readonly channels: NotificationChannelService,
    private readonly delivery: NotificationDeliveryService,
  ) {}

  /** Sole bus subscriber — every module's domain event lands here. */
  @OnEvent(NOTIFICATION_BUS_CHANNEL, { async: true })
  async onDomainEvent(envelope: DomainEventEnvelope): Promise<void> {
    if (!envelope?.event) return;
    await this.publish(envelope.event, envelope.payload ?? {}, envelope.dedupeKey).catch((e) =>
      this.logger.warn(`event ${envelope.event} pipeline error: ${e instanceof Error ? e.message : e}`),
    );
  }

  /** Run the pipeline for one event. Returns how many deliveries were enqueued. */
  async publish(event: string, payload: Record<string, unknown>, dedupeKey?: string): Promise<{ enqueued: number; rules: number }> {
    const vars: TemplateVars = { ...payload, eventTime: payload.eventTime ?? new Date().toISOString() };
    const eventRow = await this.prisma.notificationEvent.create({ data: { event, payload: payload as object, dedupeKey: dedupeKey ?? null } });

    const matched = await this.rules.match(event, payload);
    let enqueued = 0;

    for (const rule of matched) {
      const recips = await this.recipients.resolve((rule.recipients as unknown as RecipientSelection) ?? {}, payload);
      for (const recipient of recips) {
        const channels = await this.channelsFor(rule, recipient);
        for (const channel of channels) {
          if (await this.optedOut(recipient.id, event, channel.provider)) continue;
          const enq = await this.enqueueFor(rule, event, eventRow.id, recipient, channel, vars, dedupeKey);
          if (enq) enqueued++;
        }
      }
      await this.prisma.notificationRule.update({ where: { id: rule.id }, data: { triggerCount: { increment: 1 }, lastTriggeredAt: new Date() } });
      this.realtime.broadcast(WS_EVENTS.NOTIFICATION_RULE_TRIGGERED, { ruleId: rule.id, event, at: new Date().toISOString() });
    }

    await this.prisma.notificationEvent.update({ where: { id: eventRow.id }, data: { matchedRules: matched.length, processedAt: new Date() } });
    return { enqueued, rules: matched.length };
  }

  /** Channels a rule uses for a recipient: explicit rule channels, else the recipient's preferred, else defaults. */
  private async channelsFor(rule: NotificationRule, recipient: NotificationRecipient): Promise<NotificationChannel[]> {
    const ruleChannelIds = (rule.channelIds as unknown as string[]) ?? [];
    if (ruleChannelIds.length) {
      return this.prisma.notificationChannel.findMany({ where: { id: { in: ruleChannelIds }, enabled: true } });
    }
    if (recipient.preferredChannelId) {
      const c = await this.prisma.notificationChannel.findFirst({ where: { id: recipient.preferredChannelId, enabled: true } });
      if (c) return [c];
    }
    return this.prisma.notificationChannel.findMany({ where: { enabled: true, isDefault: true } });
  }

  /** Respect explicit per-recipient opt-outs (event/channel scoped). */
  private async optedOut(recipientId: string, event: string, provider: string): Promise<boolean> {
    const prefs = await this.prisma.notificationPreference.findMany({
      where: { recipientId, event: { in: [event, '*'] }, enabled: false },
    });
    return prefs.some((p) => p.channel == null || p.channel === provider);
  }

  private async enqueueFor(
    rule: NotificationRule,
    event: string,
    eventId: string,
    recipient: NotificationRecipient,
    channel: NotificationChannel,
    vars: TemplateVars,
    dedupeKey?: string,
  ): Promise<boolean> {
    const provider = getNotificationProvider(channel.provider as NotificationKind);
    const addr = this.recipients.addressFor(recipient);
    if (!provider.validateRecipient(addr)) return false;
    const destination = provider.normalizeRecipient(addr);

    const template = rule.templateId ? await this.prisma.notificationTemplate.findUnique({ where: { id: rule.templateId } }) : null;
    const tpl: TemplateBodies = (template as unknown as TemplateBodies) ?? {};
    const localizedVars: TemplateVars = { ...vars, userDisplayName: vars.userDisplayName ?? recipient.displayName };
    const msg = buildMessage(tpl, localizedVars, channel.provider as NotificationKind);
    const body = channel.provider === 'telegram' ? (msg.markdown ?? msg.text) : msg.text;

    const enq = await this.delivery.enqueue({
      event,
      eventId,
      ruleId: rule.id,
      channelId: channel.id,
      provider: channel.provider as NotificationKind,
      recipientId: recipient.id,
      destination,
      templateId: rule.templateId ?? null,
      subject: msg.subject,
      card: msg.card,
      body,
      priority: rule.priority,
      severity: rule.severity,
      dedupeKey: dedupeKey ?? `${rule.id}:${event}:${destination ?? recipient.id}`,
      dedupeWindowSec: rule.dedupeWindowSec,
    });
    return Boolean(enq);
  }

  /** Emit a domain event onto the bus (used by the legacy dispatch adapter). */
  toEnvelope(event: string, payload: Record<string, unknown>): DomainEventEnvelope {
    return { event, payload, at: new Date().toISOString() };
  }

  /**
   * Direct dispatch used by the Automation "Send Notification" action — resolves
   * the given recipients/groups (or the Administrators group as a fallback) and
   * channels (or the default channels), renders, and enqueues. Bypasses rule
   * matching since the automation rule IS the decision.
   */
  async dispatchDirect(input: {
    channelIds?: string[];
    recipientIds?: string[];
    groupIds?: string[];
    templateId?: string;
    variables?: Record<string, unknown>;
    priority?: number;
    title?: string;
    message?: string;
  }): Promise<{ enqueued: number }> {
    let recips = await this.recipients.resolve({ recipientIds: input.recipientIds, groupIds: input.groupIds }, {});
    if (recips.length === 0) {
      const admins = await this.prisma.notificationRecipientGroup.findUnique({ where: { name: 'Administrators' } });
      if (admins) recips = await this.recipients.resolve({ groupIds: [admins.id] }, {});
    }
    const channelIds = input.channelIds ?? [];
    const channels = channelIds.length
      ? await this.prisma.notificationChannel.findMany({ where: { id: { in: channelIds }, enabled: true } })
      : await this.prisma.notificationChannel.findMany({ where: { enabled: true, isDefault: true } });

    const template = input.templateId ? await this.prisma.notificationTemplate.findUnique({ where: { id: input.templateId } }) : null;
    const tpl = (template as unknown as TemplateBodies) ?? {};
    const baseVars: TemplateVars = { mediaTitle: input.title ?? 'Notification', title: input.title ?? 'Notification', overview: input.message ?? '', eventTime: new Date().toISOString(), ...(input.variables ?? {}) };

    let enqueued = 0;
    for (const recipient of recips) {
      for (const channel of channels) {
        const provider = getNotificationProvider(channel.provider as NotificationKind);
        const addr = this.recipients.addressFor(recipient);
        if (!provider.validateRecipient(addr)) continue;
        const msg = buildMessage(tpl, { ...baseVars, userDisplayName: recipient.displayName }, channel.provider as NotificationKind);
        const body = channel.provider === 'telegram' ? (msg.markdown ?? msg.text) : msg.text;
        const enq = await this.delivery.enqueue({
          event: 'automation.send_notification',
          channelId: channel.id,
          provider: channel.provider as NotificationKind,
          recipientId: recipient.id,
          destination: provider.normalizeRecipient(addr),
          templateId: input.templateId ?? null,
          subject: msg.subject,
          card: msg.card,
          body,
          priority: input.priority ?? 0,
          severity: 'info',
        });
        if (enq) enqueued++;
      }
    }
    return { enqueued };
  }
}
