import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PersonalNotificationDispatcher } from '../delivery/personal-dispatcher.service';
import { NotificationRecipientEligibilityService } from '../recipient-eligibility.service';
import { getEventDefinition } from '../catalog/notification-catalog';

/** Where an automation/workflow action is running from. */
export interface ActionContext {
  /** The local user who triggered the run, when there is one. */
  actorUserId?: string | null;
  /** The local user who owns the resource the run is about. */
  resourceOwnerUserId?: string | null;
  /** Stable id of the triggering execution, for idempotency. */
  executionId?: string | null;
}

export interface ActionResult {
  emitted: boolean;
  eventKey?: string;
  recipients: number;
  /** Why nothing was emitted, when nothing was. */
  reason?: string;
  /** Recipients that were requested but rejected, with the reason. */
  rejected?: Array<{ userId: string; reason: string }>;
}

/**
 * The seam between Automation / Workflow and the personal notification engine.
 *
 * **Automation cannot bypass eligibility or personal preferences.** An action names
 * a registered EVENT; the engine then decides who is eligible, who holds the
 * permission, and what each of them personally chose. An action cannot name a
 * channel, a destination, or a person who is not a local account.
 *
 * That is the whole difference from what this replaces. The legacy path let a rule
 * call `dispatch()` with a title and a message and no user at all, producing an
 * unowned in-app row broadcast to every connected client and a fan-out to one
 * globally-configured Telegram chat. There was no preference to respect because
 * there was no owner to have one.
 */
@Injectable()
export class NotificationActionBridge {
  private readonly logger = new Logger(NotificationActionBridge.name);

  constructor(
    private readonly dispatcher: PersonalNotificationDispatcher,
    private readonly eligibility: NotificationRecipientEligibilityService,
  ) {}

  /**
   * Emit a registered event and let the engine resolve its own audience.
   *
   * The preferred action: the rule says what happened, not who to tell.
   */
  async emitEvent(
    eventKey: string,
    payload: Record<string, unknown>,
    ctx: ActionContext = {},
  ): Promise<ActionResult> {
    const definition = getEventDefinition(eventKey);
    if (!definition) {
      // Fail closed and loudly: an unregistered key silently reaching nobody is a
      // rule that looks configured and does nothing.
      this.logger.warn(`Automation referenced unregistered notification event "${eventKey}".`);
      return { emitted: false, recipients: 0, reason: 'unregistered_event' };
    }
    const summary = await this.dispatcher.dispatch({
      eventKey,
      payload,
      actorUserId: ctx.actorUserId ?? null,
      resourceOwnerUserId: ctx.resourceOwnerUserId ?? null,
      eventId: ctx.executionId ?? undefined,
    });
    return { emitted: true, eventKey, recipients: summary.recipients };
  }

  /** Notify the user who triggered the run — and only if they are still eligible. */
  async notifyCurrentUser(
    eventKey: string,
    payload: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<ActionResult> {
    if (!ctx.actorUserId) return { emitted: false, recipients: 0, reason: 'no_actor' };
    return this.notifyExplicitUsers(eventKey, [ctx.actorUserId], payload, ctx);
  }

  /**
   * Notify named local users.
   *
   * Every id is **validated, never trusted**: a rule author (or a compromised rule)
   * can put anything in that list, including a media-server user id that would
   * otherwise be looked up in a table it does not belong to. Rejections are
   * reported rather than silently dropped, so a rule pointing at a deleted account
   * is visible instead of just quiet.
   */
  async notifyExplicitUsers(
    eventKey: string,
    userIds: string[],
    payload: Record<string, unknown>,
    ctx: ActionContext = {},
  ): Promise<ActionResult> {
    const definition = getEventDefinition(eventKey);
    if (!definition) return { emitted: false, recipients: 0, reason: 'unregistered_event' };

    const requested = [...new Set((userIds ?? []).map((u) => (u ?? '').trim()).filter(Boolean))];
    if (!requested.length) return { emitted: false, recipients: 0, reason: 'no_recipients' };

    const eligible = await this.eligibility.filterEligible(requested);
    const rejected = requested
      .filter((id) => !eligible.includes(id))
      .map((userId) => ({ userId, reason: 'ineligible_user' }));
    if (rejected.length) {
      this.logger.warn(
        `Automation named ${rejected.length} ineligible recipient(s) for "${eventKey}" — they were dropped.`,
      );
    }
    if (!eligible.length) {
      return { emitted: false, recipients: 0, reason: 'no_eligible_recipients', rejected };
    }

    const summary = await this.dispatcher.dispatch({
      eventKey,
      payload,
      actorUserId: ctx.actorUserId ?? null,
      resourceOwnerUserId: ctx.resourceOwnerUserId ?? null,
      explicitRecipientUserIds: eligible,
      eventId: ctx.executionId ?? undefined,
    });
    return { emitted: true, eventKey, recipients: summary.recipients, rejected };
  }

  /**
   * Notify whoever holds the permission the EVENT declares.
   *
   * The action deliberately cannot choose the permission: letting a rule pick one
   * would let it widen its own audience, and the event already knows who may see
   * what it is about.
   */
  async notifyPermissionHolders(
    eventKey: string,
    payload: Record<string, unknown>,
    ctx: ActionContext = {},
  ): Promise<ActionResult> {
    const definition = getEventDefinition(eventKey);
    if (!definition) return { emitted: false, recipients: 0, reason: 'unregistered_event' };
    if (!definition.requiredPermission) {
      return { emitted: false, recipients: 0, reason: 'event_declares_no_permission' };
    }
    return this.emitEvent(eventKey, payload, ctx);
  }

  /** Notify the owner of the resource the run is about. */
  async notifyResourceOwner(
    eventKey: string,
    payload: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<ActionResult> {
    if (!ctx.resourceOwnerUserId) return { emitted: false, recipients: 0, reason: 'no_resource_owner' };
    return this.notifyExplicitUsers(eventKey, [ctx.resourceOwnerUserId], payload, ctx);
  }

  /**
   * Reject an attempt to address a channel directly from an automation rule.
   *
   * Exists so the refusal is explicit and testable rather than an absence. A rule
   * that could name a Telegram chat would be a global routing decision wearing an
   * automation costume, and would bypass every personal preference beneath it.
   */
  assertNoDirectChannel(action: Record<string, unknown>): void {
    const forbidden = ['channelId', 'channelIds', 'webhookUrl', 'chatId', 'email', 'phone', 'destination'];
    const present = forbidden.filter((k) => action?.[k] !== undefined && action[k] !== null && action[k] !== '');
    if (present.length) {
      throw new BadRequestException(
        `A notification action cannot name a destination (${present.join(', ')}). ` +
          'Emit an event; each recipient\'s own routing decides where it goes.',
      );
    }
  }
}
