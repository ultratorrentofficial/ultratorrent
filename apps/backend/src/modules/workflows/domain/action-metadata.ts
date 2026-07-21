import { PERMISSIONS } from '@ultratorrent/shared';

/**
 * The underlying permission each Automation action requires — enforced against the
 * workflow execution identity at run time, so `workflows.run` never grants an action the
 * identity lacks. Unmapped actions (notify/webhook) have no extra requirement beyond
 * `workflows.run`. Also the destructive set (file/data mutations) and each action/trigger's
 * owning module (for module-enablement validation).
 */
export const ACTION_PERMISSION: Record<string, string> = {
  // torrent
  move: PERMISSIONS.TORRENTS_MOVE,
  pause: PERMISSIONS.TORRENTS_PAUSE,
  stop: PERMISSIONS.TORRENTS_STOP,
  delete: PERMISSIONS.TORRENTS_DELETE,
  delete_with_data: PERMISSIONS.TORRENTS_DELETE_DATA,
  // media
  rename_for_media: PERMISSIONS.MEDIA_MANAGER_RENAME,
  media_scan_library: PERMISSIONS.MEDIA_MANAGER_SCAN,
  media_match: PERMISSIONS.MEDIA_MANAGER_MATCH,
  media_fetch_metadata: PERMISSIONS.MEDIA_MANAGER_EDIT_METADATA,
  media_fetch_artwork: PERMISSIONS.MEDIA_MANAGER_MANAGE_ARTWORK,
  media_generate_nfo: PERMISSIONS.MEDIA_MANAGER_GENERATE_NFO,
  media_rename: PERMISSIONS.MEDIA_MANAGER_RENAME,
  media_move: PERMISSIONS.MEDIA_MANAGER_MOVE_FILES,
  media_server_refresh: PERMISSIONS.MEDIA_MANAGER_MANAGE_INTEGRATIONS,
  media_run_duplicate_scan: PERMISSIONS.MEDIA_MANAGER_SCAN,
  media_ignore_duplicate_group: PERMISSIONS.MEDIA_MANAGER_DELETE,
  media_duplicate_report: PERMISSIONS.MEDIA_MANAGER_VIEW,
  // subtitle
  subtitle_scan_missing: PERMISSIONS.SUBTITLE_INTELLIGENCE_SEARCH,
  subtitle_download: PERMISSIONS.SUBTITLE_INTELLIGENCE_DOWNLOAD,
  // rss
  refresh_rss_show_status: PERMISSIONS.RSS_MANAGE,
  disable_rss_rule: PERMISSIONS.RSS_MANAGE,
  convert_rule_to_backfill: PERMISSIONS.RSS_MANAGE,
};

/** Actions that mutate files/data — flagged destructive; require an explicit safeguard. */
export const DESTRUCTIVE_ACTIONS: ReadonlySet<string> = new Set([
  'delete', 'delete_with_data', 'move', 'media_move', 'media_rename', 'rename_for_media',
]);

/** Actions/triggers that are long-running (execute via a linked Jobs Center child job). */
export const LONG_RUNNING_ACTIONS: ReadonlySet<string> = new Set([
  'media_scan_library', 'media_match', 'media_fetch_metadata', 'media_fetch_artwork',
  'media_generate_nfo', 'media_rename', 'media_move', 'media_run_duplicate_scan',
  'subtitle_scan_missing', 'subtitle_download',
]);

/** Owning module for a trigger/action category (for module-enablement validation). */
export function moduleForCategory(category: string): string | undefined {
  switch (category) {
    case 'media': return 'media_manager';
    case 'subtitle': return 'subtitle_intelligence';
    case 'rss': return 'rss';
    case 'torrent': return 'torrents';
    case 'jobs': return 'jobs_center';
    case 'notification': return 'notification_center';
    default: return undefined;
  }
}
