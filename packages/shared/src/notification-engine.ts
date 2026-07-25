/**
 * Personal Notification Engine — shared contracts.
 *
 * Notifications belong to a locally authenticated UltraTorrent user. Nothing here
 * may be keyed by an external identity (a `MediaServerUser` from Plex/Jellyfin/Emby,
 * a Trakt link, an API client); those cannot authenticate and therefore cannot own a
 * profile, a connection, an inbox or a delivery.
 *
 * The schema stores these as strings (it declares no Prisma enums), so these unions
 * are the single place their allowed values are written down.
 */

/**
 * A personal delivery channel type.
 *
 * `in_app` is deliberately part of the same union even though it has no connection
 * row: a user selects it per event exactly like the others, and keeping it outside
 * the union would force every call site to special-case it.
 *
 * `sms` is absent by decision — retired as a personal channel. Slack and generic
 * webhooks are absent by classification: they address an endpoint, not a person, so
 * they remain *integration messages* rather than personal notifications.
 */
export const NOTIFICATION_CHANNEL_TYPES = [
  'in_app',
  'email',
  'telegram',
  'whatsapp',
  'discord',
] as const;
export type NotificationChannelType = (typeof NOTIFICATION_CHANNEL_TYPES)[number];

/** Channel types that require a stored, verified connection before delivery. */
export const CONNECTION_BACKED_CHANNEL_TYPES = [
  'email',
  'telegram',
  'whatsapp',
  'discord',
] as const;
export type ConnectionBackedChannelType = (typeof CONNECTION_BACKED_CHANNEL_TYPES)[number];

/** True when this channel type needs a `UserNotificationChannel` row to deliver. */
export function requiresConnection(type: NotificationChannelType): boolean {
  return type !== 'in_app';
}

export const NOTIFICATION_SEVERITIES = [
  'info',
  'success',
  'warning',
  'error',
  'critical',
  'security',
] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/** Ascending order of urgency — the basis for a user's `minSeverity` filter. */
export const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  info: 0,
  success: 1,
  warning: 2,
  error: 3,
  critical: 4,
  security: 5,
};

export const NOTIFICATION_DELIVERY_MODES = [
  'immediate',
  'quiet_hours_queue',
  'daily_digest',
  'weekly_digest',
  'disabled',
  'custom',
] as const;
export type NotificationDeliveryMode = (typeof NOTIFICATION_DELIVERY_MODES)[number];

/** What a user's quiet-hours window does to an event that lands inside it. */
export const QUIET_HOURS_BEHAVIORS = ['respect', 'bypass', 'digest', 'suppress'] as const;
export type QuietHoursBehavior = (typeof QUIET_HOURS_BEHAVIORS)[number];

/**
 * Delivery lifecycle. These are deliberately fine-grained so a record never claims
 * more than is known: most providers acknowledge *acceptance*, not receipt, so
 * `provider_accepted` and `delivered` are separate states and the former must never
 * be reported as the latter.
 */
export const NOTIFICATION_DELIVERY_STATUSES = [
  'pending',
  'queued',
  'sending',
  'sent_to_provider',
  'provider_accepted',
  'delivered',
  'retry_scheduled',
  'failed',
  'suppressed',
  'cancelled',
  'expired',
  'invalid_connection',
  'unverified_connection',
  'permission_denied',
  'recipient_ineligible',
] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

/** Statuses from which no further attempt will be made. */
export const TERMINAL_DELIVERY_STATUSES: readonly NotificationDeliveryStatus[] = [
  'delivered',
  'failed',
  'suppressed',
  'cancelled',
  'expired',
  'invalid_connection',
  'unverified_connection',
  'permission_denied',
  'recipient_ineligible',
];

/**
 * Who an event is for. Resolved per event from the catalogue; there is no global
 * recipient list, so an event without a resolver reaches nobody by construction
 * (fail closed) rather than everybody.
 */
export const NOTIFICATION_AUDIENCES = [
  'actor',
  'subject_user',
  'resource_owner',
  'requester',
  'approvers',
  'explicit_users',
  'permission_holders',
  'role_members',
  'administrators',
  'all_eligible_system_users',
] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

/**
 * Why a user was excluded from an event they might otherwise have received.
 * Recorded rather than inferred, so "I didn't get notified" has an answer.
 */
export const NOTIFICATION_SUPPRESSION_REASONS = [
  'ineligible_user',
  'inactive_user',
  'permission_denied',
  'resource_denied',
  'preference_disabled',
  'below_min_severity',
  'quiet_hours',
  'paused',
  'deduplicated',
  'no_route',
  'no_verified_connection',
] as const;
export type NotificationSuppressionReason = (typeof NOTIFICATION_SUPPRESSION_REASONS)[number];

/** Health of a personal connection, derived — never stored as a free-form string. */
export const NOTIFICATION_CHANNEL_HEALTH = [
  'healthy',
  'unverified',
  'degraded',
  'failing',
  'disabled',
] as const;
export type NotificationChannelHealth = (typeof NOTIFICATION_CHANNEL_HEALTH)[number];

/**
 * Effective per-event settings after the catalogue default is merged with the
 * user's override row. Preference storage is lazy — a user with no row for an event
 * still has a complete, deterministic answer here.
 */
export interface EffectiveEventPreference {
  eventKey: string;
  enabled: boolean;
  deliveryMode: NotificationDeliveryMode;
  quietHoursBehavior: QuietHoursBehavior;
  minSeverity: NotificationSeverity | null;
  dedupeWindowSec: number | null;
  aggregationWindowMin: number | null;
  /** Selected destinations. In-app appears here with a null connection id. */
  routes: EffectiveEventRoute[];
  /** True when nothing is stored and every value above came from the catalogue. */
  isDefault: boolean;
}

export interface EffectiveEventRoute {
  channelType: NotificationChannelType;
  channelConnectionId: string | null;
  enabled: boolean;
  deliveryMode: NotificationDeliveryMode | null;
}
