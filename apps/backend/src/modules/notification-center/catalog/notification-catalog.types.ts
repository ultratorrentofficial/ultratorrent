import type {
  NotificationAudience,
  NotificationChannelType,
  NotificationDeliveryMode,
  NotificationSeverity,
  QuietHoursBehavior,
} from '@ultratorrent/shared';

/**
 * User-facing grouping for the event matrix. Deliberately NOT the raw event
 * namespace: `media`, `media_server`, `subtitle` and `library_cleanup` are four
 * namespaces but one mental category to an operator ("Media"), while `system` holds
 * both security events and infrastructure alarms, which a person filters very
 * differently. Categories are chosen for how the list is *read*, not how the code is
 * organised.
 */
export const NOTIFICATION_CATEGORIES = [
  'security',
  'account',
  'system',
  'storage',
  'downloads',
  'media',
  'media_server',
  'automation',
  'workflow',
  'jobs',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * How much care the payload needs.
 *  - `normal`    — ordinary operational content.
 *  - `sensitive` — names paths, titles or people; minimized in digests/previews.
 *  - `security`  — account/credential events; never bypassable, never aggregated.
 */
export type NotificationSensitivity = 'normal' | 'sensitive' | 'security';

/** New-user defaults. Applied only when a user has no override row (lazy storage). */
export interface CatalogDefaultPreferences {
  enabled: boolean;
  /**
   * Channel types on by default. In practice only ever `['in_app']` or `[]` —
   * an external channel cannot be a default because it needs a connection the
   * user has not created yet, and defaulting it on would promise delivery that
   * silently never happens.
   */
  channels: NotificationChannelType[];
  deliveryMode: NotificationDeliveryMode;
  quietHoursBehavior: QuietHoursBehavior;
}

export interface CatalogDeduplication {
  enabled: boolean;
  windowSeconds?: number;
  /** Payload fields that, together with the user + event, identify a repeat. */
  keyFields?: string[];
}

export interface CatalogAggregation {
  supported: boolean;
  defaultWindowMinutes?: number;
}

/**
 * One registered notification event.
 *
 * The catalogue is code-defined and is NOT a preference system: it declares what
 * events exist and how they behave, plus the defaults a brand-new user starts from.
 * It never names a destination — there is no global routing.
 */
export interface NotificationEventDefinition {
  key: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  /** i18n keys, resolved per recipient locale at render time. */
  titleKey: string;
  descriptionKey: string;
  /** Payload fields that must be present for the event to be dispatchable. */
  requiredPayloadFields: string[];
  supportedChannels: NotificationChannelType[];
  defaultPreferences: CatalogDefaultPreferences;
  /**
   * Permission a recipient must hold. A user without it is filtered out even when
   * the audience named them — you are never told about something you cannot open.
   */
  requiredPermission?: string;
  audience: NotificationAudience;
  deduplication?: CatalogDeduplication;
  aggregation?: CatalogAggregation;
  sensitivity: NotificationSensitivity;
  /** Builds an in-app link. Authorization is re-checked on click, never implied. */
  deepLinkTemplate?: string;
  /**
   * Set when an event is retired. Kept in the catalogue rather than deleted so a
   * stored preference referencing it still resolves instead of throwing.
   */
  deprecated?: { since: string; replacedBy?: string; reason: string };
}
