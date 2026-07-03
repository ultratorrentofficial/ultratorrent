/**
 * Canonical permission catalog for UltraTorrent RBAC.
 *
 * Permissions are granular, dot-namespaced strings. Roles are mapped to sets of
 * these permissions. Both the backend guards and the frontend capability checks
 * consume this single source of truth.
 */

export const PERMISSIONS = {
  // Torrents
  TORRENTS_VIEW: 'torrents.view',
  TORRENTS_ADD: 'torrents.add',
  TORRENTS_PAUSE: 'torrents.pause',
  TORRENTS_RESUME: 'torrents.resume',
  TORRENTS_START: 'torrents.start',
  TORRENTS_STOP: 'torrents.stop',
  TORRENTS_DELETE: 'torrents.delete',
  TORRENTS_DELETE_DATA: 'torrents.delete_data',
  TORRENTS_RECHECK: 'torrents.recheck',
  TORRENTS_MANAGE_TRACKERS: 'torrents.manage_trackers',
  TORRENTS_MANAGE_FILES: 'torrents.manage_files',
  TORRENTS_MANAGE_LIMITS: 'torrents.manage_limits',
  TORRENTS_MOVE: 'torrents.move',
  TORRENTS_RENAME: 'torrents.rename',

  // Categories & tags
  CATEGORIES_MANAGE: 'categories.manage',
  TAGS_MANAGE: 'tags.manage',

  // RSS & automation
  RSS_VIEW: 'rss.view',
  RSS_MANAGE: 'rss.manage',
  AUTOMATION_VIEW: 'automation.view',
  AUTOMATION_MANAGE: 'automation.manage',

  // File manager
  FILES_VIEW: 'files.view',
  FILES_MANAGE: 'files.manage', // legacy umbrella (media renamer); retained for back-compat
  FILES_PREVIEW: 'files.preview',
  FILES_DOWNLOAD: 'files.download',
  FILES_CREATE_FOLDER: 'files.create_folder',
  FILES_RENAME: 'files.rename',
  FILES_MOVE: 'files.move',
  FILES_COPY: 'files.copy',
  FILES_DELETE: 'files.delete',
  FILES_BULK_ACTIONS: 'files.bulk_actions',
  FILES_CLEANUP: 'files.cleanup',

  // Administration
  SETTINGS_VIEW: 'settings.view',
  SETTINGS_MANAGE: 'settings.manage',
  /** Change the file-browser Default Root Path (validated + audited). */
  SETTINGS_MANAGE_ROOT_PATH: 'settings.manage_root_path',
  USERS_VIEW: 'users.view',
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  AUDIT_VIEW: 'audit.view',
  SYSTEM_VIEW: 'system.view',
  SYSTEM_MANAGE: 'system.manage',
  APIKEYS_MANAGE: 'apikeys.manage',
  ENGINES_MANAGE: 'engines.manage',
  NOTIFICATIONS_MANAGE: 'notifications.manage',
  MODULES_VIEW: 'modules.view',
  MODULES_MANAGE: 'modules.manage',

  // Media Acquisition Intelligence (core)
  MEDIA_ACQUISITION_VIEW: 'media_acquisition.view',
  MEDIA_ACQUISITION_MANAGE_WATCHLIST: 'media_acquisition.manage_watchlist',
  MEDIA_ACQUISITION_MANAGE_PROFILES: 'media_acquisition.manage_profiles',
  MEDIA_ACQUISITION_EVALUATE: 'media_acquisition.evaluate',
  MEDIA_ACQUISITION_APPROVE: 'media_acquisition.approve',
  MEDIA_ACQUISITION_REJECT: 'media_acquisition.reject',
  MEDIA_ACQUISITION_OVERRIDE: 'media_acquisition.override',
  MEDIA_ACQUISITION_HISTORY: 'media_acquisition.history',
  MEDIA_ACQUISITION_EXPORT: 'media_acquisition.export',
  MEDIA_ACQUISITION_SETTINGS: 'media_acquisition.settings',

  // Media Renamer (core)
  MEDIA_RENAMER_VIEW: 'media_renamer.view',
  MEDIA_RENAMER_PREVIEW: 'media_renamer.preview',
  MEDIA_RENAMER_EXECUTE: 'media_renamer.execute',
  MEDIA_RENAMER_ROLLBACK: 'media_renamer.rollback',
  MEDIA_RENAMER_MANAGE_TEMPLATES: 'media_renamer.manage_templates',
  RELEASE_SCORING_VIEW: 'release_scoring.view',
  RELEASE_SCORING_MANAGE: 'release_scoring.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

export enum SystemRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMINISTRATOR = 'ADMINISTRATOR',
  POWER_USER = 'POWER_USER',
  USER = 'USER',
  READ_ONLY = 'READ_ONLY',
}

/**
 * Default permission assignments per built-in role. SUPER_ADMIN implicitly holds
 * every permission (enforced in the guard) so it is not enumerated here.
 */
export const ROLE_PERMISSIONS: Record<SystemRole, Permission[]> = {
  [SystemRole.SUPER_ADMIN]: ALL_PERMISSIONS,
  [SystemRole.ADMINISTRATOR]: ALL_PERMISSIONS.filter(
    (p) => p !== PERMISSIONS.SYSTEM_MANAGE,
  ),
  [SystemRole.POWER_USER]: [
    PERMISSIONS.TORRENTS_VIEW,
    PERMISSIONS.TORRENTS_ADD,
    PERMISSIONS.TORRENTS_PAUSE,
    PERMISSIONS.TORRENTS_RESUME,
    PERMISSIONS.TORRENTS_START,
    PERMISSIONS.TORRENTS_STOP,
    PERMISSIONS.TORRENTS_DELETE,
    PERMISSIONS.TORRENTS_RECHECK,
    PERMISSIONS.TORRENTS_MANAGE_TRACKERS,
    PERMISSIONS.TORRENTS_MANAGE_FILES,
    PERMISSIONS.TORRENTS_MANAGE_LIMITS,
    PERMISSIONS.TORRENTS_MOVE,
    PERMISSIONS.TORRENTS_RENAME,
    PERMISSIONS.CATEGORIES_MANAGE,
    PERMISSIONS.TAGS_MANAGE,
    PERMISSIONS.RSS_VIEW,
    PERMISSIONS.RSS_MANAGE,
    PERMISSIONS.AUTOMATION_VIEW,
    PERMISSIONS.AUTOMATION_MANAGE,
    PERMISSIONS.FILES_VIEW,
    PERMISSIONS.FILES_MANAGE,
    PERMISSIONS.FILES_PREVIEW,
    PERMISSIONS.FILES_DOWNLOAD,
    PERMISSIONS.FILES_CREATE_FOLDER,
    PERMISSIONS.FILES_RENAME,
    PERMISSIONS.FILES_MOVE,
    PERMISSIONS.FILES_COPY,
    PERMISSIONS.FILES_DELETE,
    PERMISSIONS.FILES_BULK_ACTIONS,
    PERMISSIONS.FILES_CLEANUP,
    PERMISSIONS.SYSTEM_VIEW,
  ],
  [SystemRole.USER]: [
    PERMISSIONS.TORRENTS_VIEW,
    PERMISSIONS.TORRENTS_ADD,
    PERMISSIONS.TORRENTS_PAUSE,
    PERMISSIONS.TORRENTS_RESUME,
    PERMISSIONS.TORRENTS_START,
    PERMISSIONS.TORRENTS_STOP,
    PERMISSIONS.CATEGORIES_MANAGE,
    PERMISSIONS.TAGS_MANAGE,
    PERMISSIONS.RSS_VIEW,
    PERMISSIONS.FILES_VIEW,
    PERMISSIONS.FILES_PREVIEW,
    PERMISSIONS.FILES_DOWNLOAD,
  ],
  [SystemRole.READ_ONLY]: [
    PERMISSIONS.TORRENTS_VIEW,
    PERMISSIONS.RSS_VIEW,
    PERMISSIONS.AUTOMATION_VIEW,
    PERMISSIONS.FILES_VIEW,
    PERMISSIONS.FILES_PREVIEW,
    PERMISSIONS.FILES_DOWNLOAD,
    PERMISSIONS.SYSTEM_VIEW,
  ],
};
