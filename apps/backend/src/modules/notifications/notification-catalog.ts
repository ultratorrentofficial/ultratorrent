import {
  DOMAIN_EVENTS,
  PERMISSIONS,
  type NotificationEventDefinition,
} from '@ultratorrent/shared';

/**
 * Every event a user can choose to receive.
 *
 * One entry per row of the Events table. An event appears here only when a real
 * producer publishes it — offering a toggle for something that can never arrive
 * is worse than offering nothing, because the user configures it and then
 * concludes notifications are broken.
 *
 * `recipientStrategy` is **code, not configuration**. Users answer "do I want
 * this, and where" — never "who else gets it".
 *
 * Defaults: `defaultInApp` is true for events a person plausibly wants and false
 * for high-volume or operator-only ones. No external channel is ever on by
 * default (see `defaultPreferenceFor`) — a channel the user has not connected
 * cannot deliver.
 */
const DEFINITIONS: readonly NotificationEventDefinition[] = [
  // --- Playback -------------------------------------------------------------
  // Watching habits are personal data, so these are gated on the same permission
  // that guards the Live Activity dashboard.
  {
    key: DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING,
    category: 'playback',
    severity: 'info',
    titleKey: 'events.media_server.user_started_watching.title',
    descriptionKey: 'events.media_server.user_started_watching.description',
    // Off by default: on a family server this fires many times a day, and an
    // inbox that fills with it is an inbox nobody reads.
    defaultInApp: false,
    recipientStrategy: 'permission_holders',
    requiredPermission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY,
    presentationBuilder: 'playback',
  },
  {
    key: DOMAIN_EVENTS.MEDIA_SERVER_USER_STOPPED_WATCHING,
    category: 'playback',
    severity: 'info',
    titleKey: 'events.media_server.user_stopped_watching.title',
    descriptionKey: 'events.media_server.user_stopped_watching.description',
    defaultInApp: false,
    recipientStrategy: 'permission_holders',
    requiredPermission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY,
    presentationBuilder: 'playback',
  },
  {
    key: DOMAIN_EVENTS.MEDIA_SERVER_REFRESH_FAILED,
    category: 'providers',
    severity: 'warning',
    titleKey: 'events.media_server.refresh_failed.title',
    descriptionKey: 'events.media_server.refresh_failed.description',
    defaultInApp: true,
    recipientStrategy: 'permission_holders',
    requiredPermission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS,
    presentationBuilder: 'provider',
  },

  // --- Downloads ------------------------------------------------------------
  {
    key: DOMAIN_EVENTS.TORRENT_COMPLETED,
    category: 'downloads',
    severity: 'success',
    titleKey: 'events.torrent.completed.title',
    descriptionKey: 'events.torrent.completed.description',
    defaultInApp: true,
    // Torrents carry no owner column today, so this resolves to everyone who can
    // see torrents at all. When ownership exists, the strategy needs no change.
    recipientStrategy: 'resource_owner',
    requiredPermission: PERMISSIONS.TORRENTS_VIEW,
    presentationBuilder: 'torrent',
  },
  {
    key: DOMAIN_EVENTS.TORRENT_FAILED,
    category: 'downloads',
    severity: 'error',
    titleKey: 'events.torrent.failed.title',
    descriptionKey: 'events.torrent.failed.description',
    defaultInApp: true,
    recipientStrategy: 'resource_owner',
    requiredPermission: PERMISSIONS.TORRENTS_VIEW,
    presentationBuilder: 'torrent',
  },

  // --- Storage --------------------------------------------------------------
  {
    key: DOMAIN_EVENTS.SYSTEM_STORAGE_WARNING,
    category: 'storage',
    severity: 'warning',
    titleKey: 'events.system.storage_warning.title',
    descriptionKey: 'events.system.storage_warning.description',
    defaultInApp: true,
    recipientStrategy: 'permission_holders',
    requiredPermission: PERMISSIONS.SYSTEM_VIEW,
    presentationBuilder: 'storage',
  },
  {
    key: DOMAIN_EVENTS.SYSTEM_STORAGE_CRITICAL,
    category: 'storage',
    severity: 'error',
    titleKey: 'events.system.storage_critical.title',
    descriptionKey: 'events.system.storage_critical.description',
    defaultInApp: true,
    recipientStrategy: 'permission_holders',
    requiredPermission: PERMISSIONS.SYSTEM_VIEW,
    presentationBuilder: 'storage',
  },
  {
    key: DOMAIN_EVENTS.SYSTEM_STORAGE_RECOVERED,
    category: 'storage',
    severity: 'success',
    titleKey: 'events.system.storage_recovered.title',
    descriptionKey: 'events.system.storage_recovered.description',
    defaultInApp: true,
    recipientStrategy: 'permission_holders',
    requiredPermission: PERMISSIONS.SYSTEM_VIEW,
    presentationBuilder: 'storage',
  },

  // --- Workflows ------------------------------------------------------------
  {
    key: DOMAIN_EVENTS.WORKFLOW_APPROVAL_REQUESTED,
    category: 'workflows',
    severity: 'warning',
    titleKey: 'events.workflow.approval_requested.title',
    descriptionKey: 'events.workflow.approval_requested.description',
    defaultInApp: true,
    // Whoever can approve IS the audience — derived from the permission, so a new
    // role granting it is included automatically.
    recipientStrategy: 'permission_holders',
    requiredPermission: PERMISSIONS.WORKFLOWS_APPROVE,
    presentationBuilder: 'workflow',
  },
  {
    key: DOMAIN_EVENTS.WORKFLOW_EXECUTION_FAILED,
    category: 'workflows',
    severity: 'error',
    titleKey: 'events.workflow.execution_failed.title',
    descriptionKey: 'events.workflow.execution_failed.description',
    defaultInApp: true,
    recipientStrategy: 'permission_holders',
    requiredPermission: PERMISSIONS.WORKFLOWS_VIEW,
    presentationBuilder: 'workflow',
  },
  {
    key: DOMAIN_EVENTS.WORKFLOW_EXECUTION_COMPLETED,
    category: 'workflows',
    severity: 'success',
    titleKey: 'events.workflow.execution_completed.title',
    descriptionKey: 'events.workflow.execution_completed.description',
    // Off by default: a healthy install completes workflows constantly.
    defaultInApp: false,
    recipientStrategy: 'permission_holders',
    requiredPermission: PERMISSIONS.WORKFLOWS_VIEW,
    presentationBuilder: 'workflow',
  },

  // --- Providers ------------------------------------------------------------
  {
    key: DOMAIN_EVENTS.PROVIDER_OFFLINE,
    category: 'providers',
    severity: 'error',
    titleKey: 'events.provider.offline.title',
    descriptionKey: 'events.provider.offline.description',
    defaultInApp: true,
    recipientStrategy: 'permission_holders',
    requiredPermission: PERMISSIONS.SYSTEM_VIEW,
    presentationBuilder: 'provider',
  },
  {
    key: DOMAIN_EVENTS.PROVIDER_RECOVERED,
    category: 'providers',
    severity: 'success',
    titleKey: 'events.provider.recovered.title',
    descriptionKey: 'events.provider.recovered.description',
    defaultInApp: true,
    recipientStrategy: 'permission_holders',
    requiredPermission: PERMISSIONS.SYSTEM_VIEW,
    presentationBuilder: 'provider',
  },

  // --- Security -------------------------------------------------------------
  // These are about one person's account, so they go to that person — not to
  // administrators, who have no business reading them.
  {
    key: DOMAIN_EVENTS.SECURITY_PASSWORD_CHANGED,
    category: 'security',
    severity: 'warning',
    titleKey: 'events.security.password_changed.title',
    descriptionKey: 'events.security.password_changed.description',
    defaultInApp: true,
    recipientStrategy: 'affected_user',
    presentationBuilder: 'security',
  },
  {
    key: DOMAIN_EVENTS.SECURITY_TWO_FACTOR_DISABLED,
    category: 'security',
    severity: 'warning',
    titleKey: 'events.security.two_factor_disabled.title',
    descriptionKey: 'events.security.two_factor_disabled.description',
    defaultInApp: true,
    recipientStrategy: 'affected_user',
    presentationBuilder: 'security',
  },
  {
    key: DOMAIN_EVENTS.SECURITY_API_KEY_CREATED,
    category: 'security',
    severity: 'warning',
    titleKey: 'events.security.api_key_created.title',
    descriptionKey: 'events.security.api_key_created.description',
    defaultInApp: true,
    recipientStrategy: 'affected_user',
    presentationBuilder: 'security',
  },
  {
    key: DOMAIN_EVENTS.SECURITY_LOGIN_FAILED,
    category: 'security',
    severity: 'warning',
    titleKey: 'events.security.login_failed.title',
    descriptionKey: 'events.security.login_failed.description',
    defaultInApp: true,
    // The account owner should know someone is trying, so it goes to them —
    // administrators see the audit log for the platform-wide view.
    recipientStrategy: 'affected_user',
    presentationBuilder: 'security',
  },

  // --- Users ----------------------------------------------------------------
  {
    key: DOMAIN_EVENTS.USER_CREATED,
    category: 'users',
    severity: 'info',
    titleKey: 'events.user.created.title',
    descriptionKey: 'events.user.created.description',
    defaultInApp: true,
    recipientStrategy: 'permission_holders',
    requiredPermission: PERMISSIONS.USERS_MANAGE,
    presentationBuilder: 'user',
  },
  {
    key: DOMAIN_EVENTS.USER_ROLE_CHANGED,
    category: 'users',
    severity: 'warning',
    titleKey: 'events.user.role_changed.title',
    descriptionKey: 'events.user.role_changed.description',
    defaultInApp: true,
    recipientStrategy: 'permission_holders',
    requiredPermission: PERMISSIONS.USERS_MANAGE,
    presentationBuilder: 'user',
  },
] as const;

const BY_KEY = new Map(DEFINITIONS.map((d) => [d.key, d]));

export function getNotificationEvent(key: string): NotificationEventDefinition | undefined {
  return BY_KEY.get(key);
}

export function allNotificationEvents(): readonly NotificationEventDefinition[] {
  return DEFINITIONS;
}

export function isNotifiableEvent(key: string): boolean {
  return BY_KEY.has(key);
}
