/**
 * Personal notification contracts.
 *
 * The whole system answers two questions for one person: **which events do I
 * want, and where do I want them?** Everything here exists to express those two
 * answers and nothing more — there is no rule language, no audience designer and
 * no routing table, because those were what made the previous system impossible
 * to reason about.
 */

/** Delivery destinations. `in_app` always exists; the rest are user-connected. */
export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'telegram', 'discord'] as const;
export type NotificationChannelType = (typeof NOTIFICATION_CHANNELS)[number];

/** Channels a user must connect before they can receive anything. */
export const CONNECTABLE_CHANNELS = ['email', 'telegram', 'discord'] as const;
export type ConnectableChannelType = (typeof CONNECTABLE_CHANNELS)[number];

/**
 * Grouping for the Events table and the Inbox filter.
 *
 * Chosen for how a person scans the list, not to mirror module boundaries —
 * playback, storage and providers are three namespaces but one mental question
 * ("is my server healthy?") only some of the time, so they stay separate.
 */
export const NOTIFICATION_CATEGORIES = [
  'playback',
  'downloads',
  'storage',
  'workflows',
  'providers',
  'security',
  'users',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Drives the accent and icon of a rendered notification. */
export const NOTIFICATION_SEVERITIES = ['info', 'success', 'warning', 'error'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/**
 * Who receives an event. **Fixed in code, per event — never user-configurable.**
 *
 * This is the deliberate simplification. A user decides whether *they* want an
 * event and where it goes; they do not decide who else gets it. The previous
 * system let an audience be designed per rule, which is how a notification ended
 * up broadcast to everyone connected.
 *
 * - `affected_user`     — the person the event happened to (password changed).
 * - `resource_owner`    — whoever owns the thing, falling back to permission
 *                         holders when ownership is unknown.
 * - `permission_holders`— everyone holding the event's `requiredPermission`.
 * - `administrators`    — holders of the admin permission, for platform events.
 */
export const RECIPIENT_STRATEGIES = [
  'affected_user',
  'resource_owner',
  'permission_holders',
  'administrators',
] as const;
export type RecipientStrategy = (typeof RECIPIENT_STRATEGIES)[number];

/**
 * One catalogued notification event.
 *
 * Compact on purpose. Every field earns its place by being read at dispatch or
 * rendered in the Events table; there is no speculative metadata.
 */
export interface NotificationEventDefinition {
  key: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  /** i18n keys — never English text, so the table localizes. */
  titleKey: string;
  descriptionKey: string;
  /** Whether a brand-new user gets this in their inbox. */
  defaultInApp: boolean;
  recipientStrategy: RecipientStrategy;
  /**
   * Permission that gates the event. Required for `permission_holders`; for
   * `resource_owner` it is the fallback audience when no owner is known.
   */
  requiredPermission?: string;
  /** Which presentation builder renders it. Phase 3 gives these bodies. */
  presentationBuilder: string;
}

/** A user's answer for one event. Absent row ⇒ catalogue defaults. */
export interface NotificationPreference {
  eventKey: string;
  /** Master switch. Off means the event never reaches this person at all. */
  enabled: boolean;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  telegramEnabled: boolean;
  discordEnabled: boolean;
}

/** One row of the Events table: the definition plus this user's answer. */
export interface NotificationEventRow {
  definition: NotificationEventDefinition;
  preference: NotificationPreference;
  /** False when the row is catalogue defaults rather than a stored choice. */
  customized: boolean;
}

/** A personal in-app notification, as the Inbox reads it. */
export interface InboxNotification {
  id: string;
  eventKey: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  deepLink: string | null;
  resourceType: string | null;
  resourceId: string | null;
  read: boolean;
  archived: boolean;
  createdAt: string;
}

export interface InboxPage {
  items: InboxNotification[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Defaults for a user with no stored row.
 *
 * **No external channel is ever on by default.** A channel the user has not
 * connected cannot deliver, so defaulting one on would promise delivery that
 * silently never happens.
 */
export function defaultPreferenceFor(definition: NotificationEventDefinition): NotificationPreference {
  return {
    eventKey: definition.key,
    enabled: true,
    inAppEnabled: definition.defaultInApp,
    emailEnabled: false,
    telegramEnabled: false,
    discordEnabled: false,
  };
}

/** Whether a preference routes to a given channel. */
export function preferenceAllows(
  preference: NotificationPreference,
  channel: NotificationChannelType,
): boolean {
  if (!preference.enabled) return false;
  switch (channel) {
    case 'in_app':
      return preference.inAppEnabled;
    case 'email':
      return preference.emailEnabled;
    case 'telegram':
      return preference.telegramEnabled;
    case 'discord':
      return preference.discordEnabled;
    default:
      return false;
  }
}
