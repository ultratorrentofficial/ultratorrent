import { NOTIFICATION_EVENTS, PERMISSIONS } from '@ultratorrent/shared';
import type {
  CatalogDefaultPreferences,
  NotificationEventDefinition,
} from './notification-catalog.types';

const E = NOTIFICATION_EVENTS;
const P = PERMISSIONS;

/**
 * Default shapes. External channels are never defaulted on: a connection the user
 * has not created yet cannot deliver, and switching it on would promise delivery
 * that silently never happens.
 */
const IN_APP: CatalogDefaultPreferences = {
  enabled: true,
  channels: ['in_app'],
  deliveryMode: 'immediate',
  quietHoursBehavior: 'respect',
};
/** Security/account events ignore quiet hours — you learn about them when they happen. */
const IN_APP_URGENT: CatalogDefaultPreferences = {
  enabled: true,
  channels: ['in_app'],
  deliveryMode: 'immediate',
  quietHoursBehavior: 'bypass',
};
/** Routine successes: available in the matrix, off until the user asks for them. */
const OFF: CatalogDefaultPreferences = {
  enabled: false,
  channels: [],
  deliveryMode: 'disabled',
  quietHoursBehavior: 'respect',
};
/** High-volume chatter: on, but batched, so it cannot become a notification firehose. */
const DIGEST: CatalogDefaultPreferences = {
  enabled: true,
  channels: ['in_app'],
  deliveryMode: 'daily_digest',
  quietHoursBehavior: 'digest',
};

const ALL_CHANNELS = ['in_app', 'email', 'telegram', 'whatsapp', 'discord'] as const;

/** Terse builder — the catalogue is data, and 69 longhand literals would obscure it. */
function def(
  key: string,
  d: Omit<NotificationEventDefinition, 'key' | 'titleKey' | 'descriptionKey' | 'supportedChannels'> &
    Partial<Pick<NotificationEventDefinition, 'titleKey' | 'descriptionKey' | 'supportedChannels'>>,
): NotificationEventDefinition {
  return {
    key,
    titleKey: d.titleKey ?? `events.${key}.title`,
    descriptionKey: d.descriptionKey ?? `events.${key}.description`,
    supportedChannels: d.supportedChannels ?? [...ALL_CHANNELS],
    ...d,
  } as NotificationEventDefinition;
}

/**
 * The registered notification events — 69 across 9 namespaces.
 *
 * Every event declares an audience, and an event with no resolver reaches nobody by
 * construction. That is the fail-closed property the previous engine lacked: rules
 * carried a static recipient list with no permission or eligibility check, so an
 * event either went to a hand-picked group or, with `mapEventUser`, to whatever
 * `payload.userId` happened to contain — including a Plex user id.
 *
 * `administrators` and `permission_holders` audiences are still *subscriptions*, not
 * broadcasts: an administrator receives one only if their own preference enables it.
 */
export const NOTIFICATION_CATALOG: NotificationEventDefinition[] = [
  // ---------------------------------------------------------------- security
  def(E.SYSTEM_SECURITY_ALERT, {
    category: 'security', severity: 'security', audience: 'administrators',
    requiredPayloadFields: ['message'], defaultPreferences: IN_APP_URGENT,
    requiredPermission: P.SYSTEM_VIEW, sensitivity: 'security',
    deduplication: { enabled: false },
  }),
  def(E.SYSTEM_FAILED_LOGIN, {
    category: 'security', severity: 'warning', audience: 'administrators',
    requiredPayloadFields: ['username'], defaultPreferences: IN_APP_URGENT,
    requiredPermission: P.AUDIT_VIEW, sensitivity: 'security',
    // A brute-force burst must not become one notification per attempt.
    deduplication: { enabled: true, windowSeconds: 300, keyFields: ['username'] },
    aggregation: { supported: true, defaultWindowMinutes: 15 },
  }),
  def(E.SYSTEM_NEW_LOGIN, {
    // Addressed to the person who logged in — "was this you?" only works that way.
    category: 'account', severity: 'info', audience: 'subject_user',
    requiredPayloadFields: [], defaultPreferences: IN_APP_URGENT, sensitivity: 'security',
  }),
  def(E.SYSTEM_API_KEY_CREATED, {
    category: 'account', severity: 'warning', audience: 'subject_user',
    requiredPayloadFields: [], defaultPreferences: IN_APP_URGENT, sensitivity: 'security',
  }),
  def(E.SYSTEM_SETTINGS_CHANGED, {
    category: 'system', severity: 'info', audience: 'administrators',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.SETTINGS_VIEW, sensitivity: 'normal',
  }),

  // ------------------------------------------------------------------ system
  def(E.SYSTEM_DISK_SPACE_LOW, {
    category: 'storage', severity: 'critical', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP_URGENT,
    requiredPermission: P.SYSTEM_VIEW, sensitivity: 'normal',
    deduplication: { enabled: true, windowSeconds: 3600 },
  }),
  def(E.SYSTEM_CPU_HIGH, {
    category: 'system', severity: 'warning', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.SYSTEM_VIEW, sensitivity: 'normal',
    deduplication: { enabled: true, windowSeconds: 900 },
  }),
  def(E.SYSTEM_MEMORY_HIGH, {
    category: 'system', severity: 'warning', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.SYSTEM_VIEW, sensitivity: 'normal',
    deduplication: { enabled: true, windowSeconds: 900 },
  }),
  def(E.SYSTEM_PROVIDER_OFFLINE, {
    category: 'system', severity: 'error', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.SYSTEM_VIEW, sensitivity: 'normal',
    deduplication: { enabled: true, windowSeconds: 1800 },
  }),
  def(E.SYSTEM_BACKUP_FAILED, {
    category: 'system', severity: 'error', audience: 'administrators',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.SYSTEM_VIEW, sensitivity: 'normal',
  }),
  def(E.SYSTEM_DATABASE_ERROR, {
    category: 'system', severity: 'critical', audience: 'administrators',
    requiredPayloadFields: [], defaultPreferences: IN_APP_URGENT,
    requiredPermission: P.SYSTEM_VIEW, sensitivity: 'normal',
    deduplication: { enabled: true, windowSeconds: 600 },
  }),
  def(E.SYSTEM_UPDATE_AVAILABLE, {
    category: 'system', severity: 'info', audience: 'administrators',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.SYSTEM_VIEW, sensitivity: 'normal',
    deduplication: { enabled: true, windowSeconds: 86400 },
  }),

  // --------------------------------------------------------------- downloads
  def(E.DOWNLOAD_TORRENT_COMPLETED, {
    category: 'downloads', severity: 'success', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.TORRENTS_VIEW, sensitivity: 'sensitive',
    deepLinkTemplate: '/torrents',
  }),
  def(E.DOWNLOAD_TORRENT_FAILED, {
    category: 'downloads', severity: 'error', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.TORRENTS_VIEW, sensitivity: 'sensitive',
    deepLinkTemplate: '/torrents',
  }),
  def(E.DOWNLOAD_TORRENT_ADDED, {
    category: 'downloads', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.TORRENTS_VIEW, sensitivity: 'sensitive',
  }),
  def(E.DOWNLOAD_TORRENT_STARTED, {
    category: 'downloads', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.TORRENTS_VIEW, sensitivity: 'sensitive',
  }),
  def(E.DOWNLOAD_STALLED, {
    category: 'downloads', severity: 'warning', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.TORRENTS_VIEW, sensitivity: 'sensitive',
    deduplication: { enabled: true, windowSeconds: 3600 },
  }),
  def(E.DOWNLOAD_RATIO_REACHED, {
    category: 'downloads', severity: 'success', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.TORRENTS_VIEW, sensitivity: 'sensitive',
  }),
  def(E.DOWNLOAD_CATEGORY_CHANGED, {
    category: 'downloads', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.TORRENTS_VIEW, sensitivity: 'normal',
  }),

  // --------------------------------------------------------------------- rss
  def(E.RSS_FEED_FAILED, {
    category: 'automation', severity: 'error', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.RSS_VIEW, sensitivity: 'normal',
    deduplication: { enabled: true, windowSeconds: 3600 },
  }),
  def(E.RSS_RULE_MATCHED, {
    category: 'automation', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: DIGEST,
    requiredPermission: P.RSS_VIEW, sensitivity: 'sensitive',
    aggregation: { supported: true, defaultWindowMinutes: 60 },
  }),
  def(E.RSS_CANDIDATE_APPROVED, {
    category: 'automation', severity: 'success', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.RSS_VIEW, sensitivity: 'sensitive',
  }),
  def(E.RSS_CANDIDATE_REJECTED, {
    category: 'automation', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.RSS_VIEW, sensitivity: 'sensitive',
  }),
  def(E.RSS_INACTIVE_SERIES_WARNING, {
    category: 'automation', severity: 'warning', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.RSS_VIEW, sensitivity: 'normal',
  }),
  def(E.RSS_NEW_EPISODE_AVAILABLE, {
    category: 'automation', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: DIGEST,
    requiredPermission: P.RSS_VIEW, sensitivity: 'sensitive',
    aggregation: { supported: true, defaultWindowMinutes: 60 },
  }),

  // ------------------------------------------------------------------- media
  def(E.MEDIA_METADATA_MATCH_FAILED, {
    category: 'media', severity: 'warning', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.MEDIA_MANAGER_VIEW, sensitivity: 'sensitive',
  }),
  def(E.MEDIA_MISSING_ARTWORK, {
    category: 'media', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_MANAGER_VIEW, sensitivity: 'sensitive',
  }),
  def(E.MEDIA_MISSING_SUBTITLES, {
    category: 'media', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_MANAGER_VIEW, sensitivity: 'sensitive',
  }),
  def(E.MEDIA_RENAMED, {
    category: 'media', severity: 'success', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_MANAGER_VIEW, sensitivity: 'sensitive',
  }),
  def(E.MEDIA_PROCESSING_COMPLETED, {
    category: 'media', severity: 'success', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_MANAGER_VIEW, sensitivity: 'sensitive',
  }),
  def(E.MEDIA_PROCESSING_FAILED, {
    category: 'media', severity: 'error', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.MEDIA_MANAGER_VIEW, sensitivity: 'sensitive',
  }),
  def(E.MEDIA_DUPLICATE, {
    category: 'media', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_MANAGER_VIEW, sensitivity: 'sensitive',
    deprecated: {
      since: '0.46.0',
      replacedBy: E.MEDIA_DUPLICATE_DETECTED_EVENT,
      reason: 'Superseded by the Duplicate Center event set; kept so stored preferences still resolve.',
    },
  }),
  def(E.MEDIA_DUPLICATE_DETECTED_EVENT, {
    category: 'media', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.MEDIA_MANAGER_VIEW, sensitivity: 'sensitive',
    deepLinkTemplate: '/media/duplicates',
    aggregation: { supported: true, defaultWindowMinutes: 30 },
  }),
  def(E.MEDIA_DUPLICATE_REVIEW_REQUIRED, {
    category: 'media', severity: 'warning', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.MEDIA_MANAGER_VIEW, sensitivity: 'sensitive',
    deepLinkTemplate: '/media/duplicates',
  }),
  def(E.MEDIA_DUPLICATE_SAVINGS_THRESHOLD, {
    category: 'media', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_MANAGER_VIEW, sensitivity: 'normal',
  }),
  def(E.MEDIA_DUPLICATE_CLEANUP_COMPLETED, {
    category: 'media', severity: 'success', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.MEDIA_MANAGER_VIEW, sensitivity: 'sensitive',
  }),
  def(E.MEDIA_DUPLICATE_CLEANUP_FAILED, {
    category: 'media', severity: 'error', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.MEDIA_MANAGER_VIEW, sensitivity: 'sensitive',
  }),
  def(E.MEDIA_MISSING_EPISODE_FILLED, {
    category: 'media', severity: 'success', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.MEDIA_ACQUISITION_VIEW, sensitivity: 'sensitive',
  }),
  def(E.MEDIA_LIBRARY_SCAN_COMPLETED, {
    category: 'media', severity: 'success', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_MANAGER_VIEW, sensitivity: 'normal',
  }),

  // ---------------------------------------------------------------- subtitle
  def(E.SUBTITLE_DOWNLOADED, {
    category: 'media', severity: 'success', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.SUBTITLE_INTELLIGENCE_VIEW, sensitivity: 'sensitive',
  }),
  def(E.SUBTITLE_FAILED, {
    category: 'media', severity: 'error', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.SUBTITLE_INTELLIGENCE_VIEW, sensitivity: 'sensitive',
  }),
  def(E.SUBTITLE_MISSING, {
    category: 'media', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: DIGEST,
    requiredPermission: P.SUBTITLE_INTELLIGENCE_VIEW, sensitivity: 'sensitive',
    aggregation: { supported: true, defaultWindowMinutes: 120 },
  }),
  def(E.SUBTITLE_SYNCHRONIZED, {
    category: 'media', severity: 'success', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.SUBTITLE_INTELLIGENCE_VIEW, sensitivity: 'sensitive',
  }),
  def(E.SUBTITLE_VALIDATION_FAILED, {
    category: 'media', severity: 'warning', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.SUBTITLE_INTELLIGENCE_VIEW, sensitivity: 'sensitive',
  }),
  def(E.SUBTITLE_UPDATED, {
    category: 'media', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.SUBTITLE_INTELLIGENCE_VIEW, sensitivity: 'sensitive',
  }),

  // ------------------------------------------------------------ media server
  def(E.MEDIA_SERVER_USER_STARTED_WATCHING, {
    category: 'media_server', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: ['mediaTitle'], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY, sensitivity: 'sensitive',
  }),
  def(E.MEDIA_SERVER_USER_FINISHED_WATCHING, {
    category: 'media_server', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: ['mediaTitle'], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY, sensitivity: 'sensitive',
  }),
  // The three below have seeded rules but NO producer in the codebase — nothing
  // emits them, so they can never fire. Registered as deprecated rather than
  // silently listed, so the matrix does not offer a toggle that does nothing.
  def(E.MEDIA_SERVER_USER_PAUSED, {
    category: 'media_server', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY, sensitivity: 'sensitive',
    deprecated: { since: '0.46.0', reason: 'No producer emits this event; it can never fire.' },
  }),
  def(E.MEDIA_SERVER_USER_RESUMED, {
    category: 'media_server', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY, sensitivity: 'sensitive',
    deprecated: { since: '0.46.0', reason: 'No producer emits this event; it can never fire.' },
  }),
  def(E.MEDIA_SERVER_USER_STOPPED, {
    category: 'media_server', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY, sensitivity: 'sensitive',
    deprecated: {
      since: '0.46.0',
      replacedBy: E.MEDIA_SERVER_USER_FINISHED_WATCHING,
      reason: 'No producer emits this event; finished_watching is the one that fires.',
    },
  }),
  def(E.MEDIA_SERVER_MEDIA_ADDED, {
    category: 'media_server', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: DIGEST,
    requiredPermission: P.MEDIA_SERVER_ANALYTICS_VIEW, sensitivity: 'sensitive',
    aggregation: { supported: true, defaultWindowMinutes: 60 },
  }),
  def(E.MEDIA_SERVER_MEDIA_UPGRADED, {
    category: 'media_server', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_SERVER_ANALYTICS_VIEW, sensitivity: 'sensitive',
  }),
  def(E.MEDIA_SERVER_SERVER_ONLINE, {
    category: 'media_server', severity: 'success', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.MEDIA_SERVER_ANALYTICS_VIEW, sensitivity: 'normal',
  }),
  def(E.MEDIA_SERVER_SERVER_OFFLINE, {
    category: 'media_server', severity: 'error', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.MEDIA_SERVER_ANALYTICS_VIEW, sensitivity: 'normal',
    deduplication: { enabled: true, windowSeconds: 1800 },
  }),
  def(E.MEDIA_SERVER_NEWSLETTER_SENT, {
    category: 'media_server', severity: 'success', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS, sensitivity: 'normal',
  }),
  def(E.MEDIA_SERVER_NEWSLETTER_FAILED, {
    category: 'media_server', severity: 'error', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS, sensitivity: 'normal',
  }),
  def(E.MEDIA_SERVER_TRANSCODE_DETECTED, {
    category: 'media_server', severity: 'warning', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY, sensitivity: 'sensitive',
  }),
  def(E.MEDIA_SERVER_HIGH_BANDWIDTH, {
    category: 'media_server', severity: 'warning', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.MEDIA_SERVER_ANALYTICS_VIEW, sensitivity: 'normal',
    deduplication: { enabled: true, windowSeconds: 900 },
  }),

  // -------------------------------------------------------------------- jobs
  def(E.JOB_FAILED, {
    category: 'jobs', severity: 'error', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.JOBS_VIEW, sensitivity: 'normal', deepLinkTemplate: '/jobs',
  }),
  def(E.JOB_STALLED, {
    category: 'jobs', severity: 'warning', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.JOBS_VIEW, sensitivity: 'normal', deepLinkTemplate: '/jobs',
  }),
  def(E.JOB_COMPLETED_WITH_WARNINGS, {
    category: 'jobs', severity: 'warning', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.JOBS_VIEW, sensitivity: 'normal', deepLinkTemplate: '/jobs',
  }),
  def(E.JOB_RETRY_EXHAUSTED, {
    category: 'jobs', severity: 'error', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.JOBS_VIEW, sensitivity: 'normal', deepLinkTemplate: '/jobs',
  }),

  // -------------------------------------------------------------- automation
  def(E.AUTOMATION_RULE_FAILED, {
    category: 'automation', severity: 'error', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.AUTOMATION_VIEW, sensitivity: 'normal',
    deepLinkTemplate: '/automation',
    // A rule failing on every torrent in a sweep is one problem, not fifty.
    deduplication: { enabled: true, windowSeconds: 900, keyFields: ['ruleName'] },
    aggregation: { supported: true, defaultWindowMinutes: 30 },
  }),

  // ---------------------------------------------------------------- workflow
  def(E.WORKFLOW_EXECUTION_FAILED, {
    // Owner + requester, not "all admins": a failed run belongs to whoever ran it.
    category: 'workflow', severity: 'error', audience: 'resource_owner',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.WORKFLOWS_VIEW, sensitivity: 'normal',
    deepLinkTemplate: '/workflows/executions/{executionId}',
  }),
  def(E.WORKFLOW_EXECUTION_COMPLETED, {
    category: 'workflow', severity: 'success', audience: 'resource_owner',
    requiredPayloadFields: [], defaultPreferences: OFF,
    requiredPermission: P.WORKFLOWS_VIEW, sensitivity: 'normal',
    deepLinkTemplate: '/workflows/executions/{executionId}',
  }),
  def(E.WORKFLOW_APPROVAL_REQUESTED, {
    category: 'workflow', severity: 'warning', audience: 'approvers',
    requiredPayloadFields: [], defaultPreferences: IN_APP_URGENT,
    requiredPermission: P.WORKFLOWS_APPROVE, sensitivity: 'normal',
    deepLinkTemplate: '/workflows/approvals',
  }),

  // --------------------------------------------------------- library cleanup
  def(E.LIBRARY_CLEANUP_PLAN_PENDING_APPROVAL, {
    category: 'storage', severity: 'warning', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP_URGENT,
    requiredPermission: P.LIBRARY_CLEANUP_APPROVE, sensitivity: 'sensitive',
    deepLinkTemplate: '/media/cleanup/plans',
  }),
  def(E.LIBRARY_CLEANUP_PLAN_APPROVED, {
    category: 'storage', severity: 'success', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.LIBRARY_CLEANUP_VIEW, sensitivity: 'sensitive',
  }),
  def(E.LIBRARY_CLEANUP_PLAN_REJECTED, {
    category: 'storage', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.LIBRARY_CLEANUP_VIEW, sensitivity: 'sensitive',
  }),
  def(E.LIBRARY_CLEANUP_PLAN_EXPIRED, {
    category: 'storage', severity: 'info', audience: 'permission_holders',
    requiredPayloadFields: [], defaultPreferences: IN_APP,
    requiredPermission: P.LIBRARY_CLEANUP_VIEW, sensitivity: 'sensitive',
  }),
];

const BY_KEY = new Map(NOTIFICATION_CATALOG.map((d) => [d.key, d]));

/** Definition for an event key, or undefined when it is not registered. */
export function getEventDefinition(key: string): NotificationEventDefinition | undefined {
  return BY_KEY.get(key);
}

/** Registered and not retired — what the event matrix offers. */
export function activeEventDefinitions(): NotificationEventDefinition[] {
  return NOTIFICATION_CATALOG.filter((d) => !d.deprecated);
}

/**
 * Validate an event's payload against its declared required fields.
 *
 * Deliberately shallow: this is a dispatch-time guard against a producer emitting a
 * half-built payload, not a schema engine. An unregistered event is invalid — the
 * engine never dispatches something it has no definition for, which is what keeps
 * "unknown event" from becoming "notify everyone".
 */
export function validateEventPayload(
  key: string,
  payload: Record<string, unknown> | null | undefined,
): { valid: boolean; reason?: string; missing?: string[] } {
  const def = BY_KEY.get(key);
  if (!def) return { valid: false, reason: 'unregistered_event' };
  const body = payload ?? {};
  const missing = def.requiredPayloadFields.filter(
    (f) => body[f] === undefined || body[f] === null || body[f] === '',
  );
  if (missing.length) return { valid: false, reason: 'missing_payload_fields', missing };
  return { valid: true };
}
