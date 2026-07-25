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
 * Every profile/preference key that could apply to one event, from an exact match up
 * to the catch-all: `media_server.user_paused` → the event itself, `media_server.*`
 * and `*`. Used as the `IN` set so a single query fetches all candidate lines, which
 * {@link eventSpecificity} then ranks.
 */
export function eventMatchKeys(event: string): string[] {
  const keys = [event, '*'];
  const dot = event.indexOf('.');
  if (dot > 0) keys.push(`${event.slice(0, dot)}.*`);
  return keys;
}

/**
 * How specific a profile/preference key is: an exact event (2) beats a namespace
 * wildcard (1) beats the catch-all (0). Ranking rather than unioning is deliberate —
 * "all system alerts to email, except backup failures to Telegram" has to be sayable,
 * and a union would send backup failures to both.
 */
export function eventSpecificity(key: string): number {
  if (key === '*') return 0;
  return key.endsWith('.*') ? 1 : 2;
}

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
          if (await this.optedOut(rule, recipient.id, event, channel.provider)) continue;
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

  /**
   * Channels a rule uses for a recipient, most authoritative first:
   *
   *   1. a **forced** rule's own channels — an admin pin the recipient cannot move;
   *   2. the recipient's **routing profile** for this event (most specific match);
   *   3. the rule's channels;
   *   4. the recipient's `preferredChannelId`;
   *   5. the channels flagged `isDefault`.
   *
   * (2) is what makes a routing profile a profile rather than a filter: it can name a
   * channel the *rule* never selected, so "my playback events go to Telegram" works
   * even while the rule sits on the defaults. Opt-outs could only ever subtract, so
   * before this a rule pinned to one channel put every other channel out of reach for
   * everybody.
   *
   * (1) is the counterweight. Once a recipient can redirect delivery, nothing would
   * stop them redirecting a breach notice into a channel nobody reads — so a rule may
   * be marked `forced` and then owns its destinations outright.
   */
  private async channelsFor(rule: NotificationRule, recipient: NotificationRecipient): Promise<NotificationChannel[]> {
    const ruleChannelIds = (rule.channelIds as unknown as string[]) ?? [];
    if (rule.forced && ruleChannelIds.length) {
      return this.prisma.notificationChannel.findMany({ where: { id: { in: ruleChannelIds }, enabled: true } });
    }
    const routed = await this.routedChannelIds(recipient.id, rule.event);
    if (routed.length) {
      const channels = await this.prisma.notificationChannel.findMany({ where: { id: { in: routed }, enabled: true } });
      // A profile naming only disabled/deleted channels is a stale selection, not an
      // instruction to send nowhere — fall through rather than silently drop delivery.
      if (channels.length) return channels;
    }
    if (ruleChannelIds.length) {
      return this.prisma.notificationChannel.findMany({ where: { id: { in: ruleChannelIds }, enabled: true } });
    }
    if (recipient.preferredChannelId) {
      const c = await this.prisma.notificationChannel.findFirst({ where: { id: recipient.preferredChannelId, enabled: true } });
      if (c) return [c];
    }
    return this.prisma.notificationChannel.findMany({ where: { enabled: true, isDefault: true } });
  }

  /**
   * The recipient's chosen channels for one event — the MOST SPECIFIC profile line
   * only (exact event > `namespace.*` > `*`), never a union. Specificity is what lets
   * a broad line ("everything to email") be overridden for a single event without
   * having to delete and re-enumerate it.
   */
  private async routedChannelIds(recipientId: string, event: string): Promise<string[]> {
    const rows = await this.prisma.notificationRouting.findMany({
      where: { recipientId, event: { in: eventMatchKeys(event) } },
    });
    if (!rows.length) return [];
    const best = rows.sort((a, b) => eventSpecificity(b.event) - eventSpecificity(a.event))[0];
    return ((best.channelIds as unknown as string[]) ?? []).filter(Boolean);
  }

  /**
   * Respect explicit per-recipient opt-outs (event/channel scoped).
   *
   * A `forced` rule ignores them: an alert an admin pinned is one the recipient is not
   * permitted to silence, and honouring the opt-out here would reopen exactly the hole
   * `forced` exists to close.
   */
  private async optedOut(rule: NotificationRule, recipientId: string, event: string, provider: string): Promise<boolean> {
    if (rule.forced) return false;
    const prefs = await this.prisma.notificationPreference.findMany({
      where: { recipientId, event: { in: eventMatchKeys(event) }, enabled: false },
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
    // `actorName` must be read from the payload BEFORE `userDisplayName` falls back
    // to the recipient — otherwise every actor-less event (a CPU alert, a failed
    // feed) would render as though the person it was sent to had caused it.
    const localizedVars: TemplateVars = {
      ...vars,
      actorName: vars.userDisplayName ?? null,
      actionLabel: rule.name,
      userDisplayName: vars.userDisplayName ?? recipient.displayName,
    };
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
