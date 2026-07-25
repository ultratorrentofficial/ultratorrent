/**
 * Classifying and migrating the legacy notification actions.
 *
 * Two things that used to be one:
 *
 *  - a **personal notification** targets eligible UltraTorrent users, obeys their
 *    preferences and lands in their inbox;
 *  - an **integration message** targets an endpoint — a Slack channel, a generic
 *    webhook — belongs to integration configuration, and has no recipient, no
 *    inbox and no preference to respect.
 *
 * The legacy engine conflated them: one `dispatch()` created an unowned in-app row
 * AND posted to a globally-configured Slack/Discord/webhook URL. Separating them is
 * what makes "no global notification destination" true rather than aspirational,
 * while keeping the outbound integrations that people legitimately rely on.
 */

export type ActionClass = 'personal_notification' | 'integration_message' | 'incompatible';

export interface ActionMigrationVerdict {
  actionId: string;
  classification: ActionClass;
  /** The action to use instead, when there is a direct replacement. */
  replacement?: string;
  /** Whether the conversion can be done without a human deciding something. */
  automatic: boolean;
  reason: string;
}

/**
 * Legacy action ids found in the repository's automation and RSS rule sets.
 *
 * `notify` / `send_notification` / `media_notify` all produced an unowned in-app
 * record plus the global fan-out. `notify_admin` at least named an audience, so it
 * maps cleanly onto the administrators audience.
 */
const VERDICTS: Record<string, ActionMigrationVerdict> = {
  notify: {
    actionId: 'notify',
    classification: 'personal_notification',
    replacement: 'emit_notification_event',
    // The legacy action carried a free-text title and message and no event key, so
    // a human has to say WHICH registered event it corresponds to. Guessing would
    // silently re-point a rule at the wrong audience.
    automatic: false,
    reason:
      'Produced an unowned in-app notification. It carries free text rather than a registered event, ' +
      'so the event key must be chosen before it can resolve an audience.',
  },
  send_notification: {
    actionId: 'send_notification',
    classification: 'personal_notification',
    replacement: 'emit_notification_event',
    automatic: false,
    reason:
      'Dispatched through the global Notification Center rules. Its recipients came from a rule, ' +
      'not from personal preference, so the target event must be chosen deliberately.',
  },
  media_notify: {
    actionId: 'media_notify',
    classification: 'personal_notification',
    replacement: 'emit_notification_event',
    automatic: false,
    reason: 'Free-text media notification with no owner; needs a registered event key.',
  },
  notify_admin: {
    actionId: 'notify_admin',
    classification: 'personal_notification',
    replacement: 'emit_notification_event',
    // It already meant "the administrators", which is a real audience — but each
    // admin now decides personally whether they want it.
    automatic: true,
    reason:
      'Mapped to an event with the administrators audience. Each administrator now receives it only ' +
      'if their own preference enables it.',
  },
  webhook: {
    actionId: 'webhook',
    classification: 'integration_message',
    replacement: 'send_integration_message',
    automatic: true,
    reason:
      'Addresses an endpoint rather than a person. Reclassified as an integration message: no recipient, ' +
      'no inbox, no personal preference.',
  },
  slack: {
    actionId: 'slack',
    classification: 'integration_message',
    replacement: 'send_integration_message',
    automatic: true,
    reason: 'Addresses a Slack channel, not a person. Integration message.',
  },
};

/** How one legacy action should be treated during migration. */
export function classifyLegacyAction(actionId: string): ActionMigrationVerdict {
  return (
    VERDICTS[actionId] ?? {
      actionId,
      classification: 'incompatible',
      automatic: false,
      reason: 'Unrecognised notification action; flag for manual review rather than converting it.',
    }
  );
}

export interface MigrationReport {
  total: number;
  automatic: ActionMigrationVerdict[];
  manual: ActionMigrationVerdict[];
  integrations: ActionMigrationVerdict[];
}

/**
 * Plan a migration over a set of rule actions.
 *
 * Reports rather than converts: the brief requires incompatible actions to be
 * FLAGGED, and a migration that silently rewrote a rule's audience would be exactly
 * the kind of change nobody notices until the wrong person is paged.
 */
export function planActionMigration(actionIds: string[]): MigrationReport {
  const verdicts = actionIds.map(classifyLegacyAction);
  return {
    total: verdicts.length,
    automatic: verdicts.filter((v) => v.automatic && v.classification === 'personal_notification'),
    manual: verdicts.filter((v) => !v.automatic),
    integrations: verdicts.filter((v) => v.classification === 'integration_message'),
  };
}
