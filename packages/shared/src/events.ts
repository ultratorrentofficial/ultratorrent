/**
 * WebSocket event contract shared by the gateway and the frontend client.
 */
import type { GlobalStats, NormalizedTorrent } from './torrent.js';

export const WS_EVENTS = {
  TORRENTS_UPDATE: 'torrents:update',
  TORRENT_UPDATE: 'torrent:update',
  STATS_UPDATE: 'stats:update',
  NOTIFICATION: 'notification',
  ENGINE_STATUS: 'engine:status',
  SYSTEM_HEALTH: 'system:health',
  FILES_OP_STARTED: 'files.operation.started',
  FILES_OP_PROGRESS: 'files.operation.progress',
  FILES_OP_COMPLETED: 'files.operation.completed',
  FILES_OP_FAILED: 'files.operation.failed',
  FILES_CLEANUP_COMPLETED: 'files.cleanup.completed',
  FILES_TRASH_UPDATED: 'files.trash.updated',
  // Media Manager job progress (scoped to media_manager.view).
  MEDIA_JOB_STARTED: 'media_manager.job.started',
  MEDIA_JOB_PROGRESS: 'media_manager.job.progress',
  MEDIA_JOB_COMPLETED: 'media_manager.job.completed',
  MEDIA_JOB_FAILED: 'media_manager.job.failed',
  // Duplicate Center (scoped to media_manager.view).
  //
  // Named `media_manager.*` rather than `media.*` deliberately: the gateway derives
  // a room from the event-name PREFIX, and `media.` falls through to the
  // `authenticated` room — i.e. every logged-in user, regardless of permission.
  // These carry library paths and file counts, so they take the prefix that is
  // actually scoped to `media_manager.view`.
  MEDIA_DUPLICATE_SCAN_STARTED: 'media_manager.duplicates.scan.started',
  MEDIA_DUPLICATE_SCAN_PROGRESS: 'media_manager.duplicates.scan.progress',
  MEDIA_DUPLICATE_SCAN_COMPLETED: 'media_manager.duplicates.scan.completed',
  MEDIA_DUPLICATE_SCAN_FAILED: 'media_manager.duplicates.scan.failed',
  MEDIA_DUPLICATE_SCAN_CANCELLED: 'media_manager.duplicates.scan.cancelled',
  MEDIA_DUPLICATE_GROUP_UPDATED: 'media_manager.duplicates.group.updated',
  MEDIA_DUPLICATE_RESOLUTION_STARTED: 'media_manager.duplicates.resolution.started',
  MEDIA_DUPLICATE_RESOLUTION_PROGRESS: 'media_manager.duplicates.resolution.progress',
  MEDIA_DUPLICATE_RESOLUTION_COMPLETED: 'media_manager.duplicates.resolution.completed',
  MEDIA_DUPLICATE_RESOLUTION_PARTIAL: 'media_manager.duplicates.resolution.partial',
  MEDIA_DUPLICATE_RESOLUTION_FAILED: 'media_manager.duplicates.resolution.failed',
  MEDIA_DUPLICATE_RESTORED: 'media_manager.duplicates.restored',
  // IMDb metadata provider (scoped to media_manager.view).
  IMDB_DATASET_VALIDATE_STARTED: 'imdb.dataset.validate.started',
  IMDB_DATASET_VALIDATE_COMPLETED: 'imdb.dataset.validate.completed',
  IMDB_DATASET_VALIDATE_FAILED: 'imdb.dataset.validate.failed',
  IMDB_DATASET_DOWNLOAD_STARTED: 'imdb.dataset.download.started',
  IMDB_DATASET_DOWNLOAD_PROGRESS: 'imdb.dataset.download.progress',
  IMDB_DATASET_DOWNLOAD_COMPLETED: 'imdb.dataset.download.completed',
  IMDB_DATASET_DOWNLOAD_FAILED: 'imdb.dataset.download.failed',
  IMDB_DATASET_IMPORT_PROGRESS: 'imdb.dataset.import.progress',
  IMDB_DATASET_IMPORT_COMPLETED: 'imdb.dataset.import.completed',
  IMDB_DATASET_IMPORT_FAILED: 'imdb.dataset.import.failed',
  IMDB_DATASET_IMPORT_CANCELLED: 'imdb.dataset.import.cancelled',
  IMDB_MATCH_COMPLETED: 'imdb.match.completed',
  IMDB_ENRICHMENT_COMPLETED: 'imdb.enrichment.completed',
  // RSS TV-show airing-status awareness (scoped to rss.view).
  RSS_SHOW_STATUS_LOOKUP_COMPLETED: 'rss.show_status.lookup.completed',
  RSS_SHOW_STATUS_LOOKUP_FAILED: 'rss.show_status.lookup.failed',
  RSS_RULE_CREATED_FOR_INACTIVE_SHOW: 'rss.rule.created_for_inactive_show',
  RSS_SHOW_STATUS_CHANGED: 'rss.show_status.changed',
  RSS_SHOW_BECAME_ACTIVE: 'rss.show.became_active',
  RSS_SHOW_ENDED: 'rss.show.ended',
  RSS_SHOW_CANCELED: 'rss.show.canceled',
  // Notification Center realtime (scoped to notifications.view).
  NOTIFICATION_SENT: 'notification.sent',
  NOTIFICATION_FAILED: 'notification.failed',
  NOTIFICATION_RETRY: 'notification.retry',
  NOTIFICATION_QUEUE_UPDATED: 'notification.queue.updated',
  NOTIFICATION_PROVIDER_ONLINE: 'notification.provider.online',
  NOTIFICATION_PROVIDER_OFFLINE: 'notification.provider.offline',
  NOTIFICATION_RULE_TRIGGERED: 'notification.rule.triggered',
  // Subtitle Intelligence (scoped to subtitle_intelligence.view). Job progress +
  // per-subtitle lifecycle for live UI.
  SUBTITLE_JOB_STARTED: 'subtitle_intelligence.job.started',
  SUBTITLE_JOB_PROGRESS: 'subtitle_intelligence.job.progress',
  SUBTITLE_JOB_COMPLETED: 'subtitle_intelligence.job.completed',
  SUBTITLE_JOB_FAILED: 'subtitle_intelligence.job.failed',
  SUBTITLE_DOWNLOADED: 'subtitle_intelligence.downloaded',
  SUBTITLE_DOWNLOAD_FAILED: 'subtitle_intelligence.download_failed',
  SUBTITLE_SYNCHRONIZED: 'subtitle_intelligence.synchronized',
  SUBTITLE_VALIDATION_FAILED: 'subtitle_intelligence.validation_failed',

  // Unified Jobs Center — the platform-wide job lifecycle channel. Unlike the
  // per-module channels above (scoped by event-name prefix), these are emitted
  // scoped to each job's OWN required permission via `emitToPermission`, so a
  // client only sees jobs it is authorised to view. Payload: JobEventPayload.
  JOB_CREATED: 'jobs.created',
  JOB_QUEUED: 'jobs.queued',
  JOB_STARTED: 'jobs.started',
  JOB_PROGRESS: 'jobs.progress',
  JOB_PHASE_CHANGED: 'jobs.phase_changed',
  JOB_WARNING: 'jobs.warning',
  JOB_PAUSED: 'jobs.paused',
  JOB_RESUMED: 'jobs.resumed',
  JOB_RETRYING: 'jobs.retrying',
  JOB_COMPLETED: 'jobs.completed',
  JOB_FAILED: 'jobs.failed',
  JOB_CANCELLING: 'jobs.cancelling',
  JOB_CANCELLED: 'jobs.cancelled',
  JOB_STALLED: 'jobs.stalled',
  JOB_CHILD_CREATED: 'jobs.child_created',
} as const;

/** Payload for the unified `jobs.*` channel (bounded + sanitized — never secrets). */
export interface JobEventPayload {
  jobId: string;
  type: string;
  moduleKey: string;
  workspaceKey?: string | null;
  status: string;
  phase?: string | null;
  progress?: number | null;
  parentJobId?: string | null;
  rootJobId?: string | null;
  correlationId?: string | null;
  errorCode?: string | null;
  message?: string | null;
  at: string;
}

/**
 * Canonical domain-event names that modules publish onto the internal event bus
 * (`@nestjs/event-emitter`). The Notification Center subscribes to these and
 * evaluates rules; this is the seed catalog every module's events register under.
 * Names are dot-namespaced `module.entity_verb`. Not WebSocket events.
 */
export const NOTIFICATION_EVENTS = {
  // Media Server Analytics
  MEDIA_SERVER_USER_STARTED_WATCHING: 'media_server.user_started_watching',
  MEDIA_SERVER_USER_FINISHED_WATCHING: 'media_server.user_finished_watching',
  MEDIA_SERVER_USER_PAUSED: 'media_server.user_paused',
  MEDIA_SERVER_USER_RESUMED: 'media_server.user_resumed',
  MEDIA_SERVER_USER_STOPPED: 'media_server.user_stopped',
  MEDIA_SERVER_MEDIA_ADDED: 'media_server.media_added',
  MEDIA_SERVER_MEDIA_UPGRADED: 'media_server.media_upgraded',
  MEDIA_SERVER_SERVER_ONLINE: 'media_server.server_online',
  MEDIA_SERVER_SERVER_OFFLINE: 'media_server.server_offline',
  MEDIA_SERVER_NEWSLETTER_SENT: 'media_server.newsletter_sent',
  MEDIA_SERVER_NEWSLETTER_FAILED: 'media_server.newsletter_failed',
  MEDIA_SERVER_TRANSCODE_DETECTED: 'media_server.transcode_detected',
  MEDIA_SERVER_HIGH_BANDWIDTH: 'media_server.high_bandwidth',
  // Downloads
  DOWNLOAD_TORRENT_ADDED: 'download.torrent_added',
  DOWNLOAD_TORRENT_STARTED: 'download.torrent_started',
  DOWNLOAD_TORRENT_COMPLETED: 'download.torrent_completed',
  DOWNLOAD_TORRENT_FAILED: 'download.torrent_failed',
  DOWNLOAD_STALLED: 'download.stalled',
  DOWNLOAD_RATIO_REACHED: 'download.ratio_reached',
  DOWNLOAD_CATEGORY_CHANGED: 'download.category_changed',
  // RSS
  RSS_FEED_FAILED: 'rss.feed_failed',
  RSS_RULE_MATCHED: 'rss.rule_matched',
  RSS_CANDIDATE_APPROVED: 'rss.candidate_approved',
  RSS_CANDIDATE_REJECTED: 'rss.candidate_rejected',
  RSS_INACTIVE_SERIES_WARNING: 'rss.inactive_series_warning',
  RSS_NEW_EPISODE_AVAILABLE: 'rss.new_episode_available',
  // Media Manager
  MEDIA_METADATA_MATCH_FAILED: 'media.metadata_match_failed',
  MEDIA_MISSING_ARTWORK: 'media.missing_artwork',
  MEDIA_MISSING_SUBTITLES: 'media.missing_subtitles',
  MEDIA_RENAMED: 'media.renamed',
  MEDIA_PROCESSING_COMPLETED: 'media.processing_completed',
  MEDIA_PROCESSING_FAILED: 'media.processing_failed',
  MEDIA_DUPLICATE: 'media.duplicate',
  MEDIA_DUPLICATE_DETECTED_EVENT: 'media.duplicate_detected',
  MEDIA_DUPLICATE_REVIEW_REQUIRED: 'media.duplicate_review_required',
  MEDIA_DUPLICATE_SAVINGS_THRESHOLD: 'media.duplicate_savings_threshold',
  MEDIA_DUPLICATE_CLEANUP_COMPLETED: 'media.duplicate_cleanup_completed',
  MEDIA_DUPLICATE_CLEANUP_FAILED: 'media.duplicate_cleanup_failed',
  MEDIA_MISSING_EPISODE_FILLED: 'media.missing_episode_filled',
  MEDIA_LIBRARY_SCAN_COMPLETED: 'media.library_scan_completed',
  // Subtitle Intelligence
  SUBTITLE_DOWNLOADED: 'subtitle.downloaded',
  SUBTITLE_FAILED: 'subtitle.failed',
  SUBTITLE_MISSING: 'subtitle.missing',
  SUBTITLE_SYNCHRONIZED: 'subtitle.synchronized',
  SUBTITLE_VALIDATION_FAILED: 'subtitle.validation_failed',
  SUBTITLE_UPDATED: 'subtitle.updated',
  // System
  SYSTEM_DISK_SPACE_LOW: 'system.disk_space_low',
  SYSTEM_CPU_HIGH: 'system.cpu_high',
  SYSTEM_MEMORY_HIGH: 'system.memory_high',
  SYSTEM_PROVIDER_OFFLINE: 'system.provider_offline',
  SYSTEM_BACKUP_FAILED: 'system.backup_failed',
  SYSTEM_DATABASE_ERROR: 'system.database_error',
  SYSTEM_UPDATE_AVAILABLE: 'system.update_available',
  SYSTEM_SECURITY_ALERT: 'system.security_alert',
  SYSTEM_FAILED_LOGIN: 'system.failed_login',
  SYSTEM_NEW_LOGIN: 'system.new_login',
  SYSTEM_API_KEY_CREATED: 'system.api_key_created',
  SYSTEM_SETTINGS_CHANGED: 'system.settings_changed',
} as const;

/**
 * The single internal event-bus channel every module emits domain events on.
 * Modules call `eventBus.emit(NOTIFICATION_BUS_CHANNEL, envelope)` and stay fully
 * decoupled from the Notification Center, which is the sole subscriber.
 */
export const NOTIFICATION_BUS_CHANNEL = 'notification.event';

/** A domain-event name (value of NOTIFICATION_EVENTS). */
export type NotificationEventName = (typeof NOTIFICATION_EVENTS)[keyof typeof NOTIFICATION_EVENTS];

/**
 * Envelope every module publishes onto the bus. `payload` carries the template
 * variables (mediaTitle, userDisplayName, posterUrl, …). Never include secrets.
 */
export interface DomainEventEnvelope {
  event: NotificationEventName | string;
  /** Optional dedup/correlation key; the rule engine dedups on (rule, dedupeKey). */
  dedupeKey?: string;
  /** Template variables + condition inputs. */
  payload: Record<string, unknown>;
  /** ISO timestamp; set by the publisher or the center. */
  at?: string;
}

/**
 * An IMDb provider lifecycle event over WebSocket (dataset validate/import,
 * manual match, cross-provider enrichment). Never carries secrets.
 */
export interface ImdbEventPayload {
  /** Dataset import id (validate/import events) or media item id (match/enrichment). */
  id?: string | null;
  itemId?: string | null;
  imdbId?: string | null;
  status?: string;
  progress?: number;
  message?: string | null;
  /** Per-file / summary counts (never secrets). */
  recordsImported?: number;
  filesImported?: string[];
  error?: string | null;
  at: string;
}

/** A Media Manager background job's lifecycle event over WebSocket. */
export interface MediaJobEventPayload {
  jobId: string;
  /** library_scan | media_identification | metadata_fetch | artwork_fetch | subtitle_scan | rename_execute | nfo_generate | media_server_refresh */
  type: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  libraryId?: string | null;
  itemId?: string | null;
  message?: string | null;
  result?: unknown;
  error?: string | null;
  at: string;
}

/**
 * A Duplicate Center scan or cleanup, over WebSocket.
 *
 * `scanId`/`resolutionId` are what a client correlates on — the page starts a scan,
 * gets an id back, and ignores every event that is not its own.
 */
export interface DuplicateScanEventPayload {
  scanId: string;
  progress: number;
  message?: string | null;
  /** Present on `completed`: the run's metrics. */
  metrics?: {
    itemsScanned: number;
    groupsDetected: number;
    groupsCreated: number;
    groupsRemoved: number;
    requiresReview: number;
    potentialSavingsBytes: number;
    durationMs: number;
    unchanged: boolean;
  };
  error?: string | null;
  at: string;
}

export interface DuplicateResolutionEventPayload {
  resolutionId: string;
  groupId?: string | null;
  status: 'started' | 'running' | 'completed' | 'partial' | 'failed';
  trashed?: number;
  skipped?: number;
  failed?: number;
  reclaimedBytes?: number;
  error?: string | null;
  at: string;
}

/** A Subtitle Intelligence background job's lifecycle event over WebSocket. */
export interface SubtitleJobEventPayload {
  jobId: string;
  /** missing_scan | search | download | validate | synchronize | provider_health | bulk_scan */
  type: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  libraryId?: string | null;
  itemId?: string | null;
  provider?: string | null;
  language?: string | null;
  message?: string | null;
  result?: unknown;
  error?: string | null;
  at: string;
}

export interface StatsUpdatePayload {
  engineId: string;
  stats: GlobalStats;
  at: string;
}

export interface TorrentsUpdatePayload {
  engineId: string;
  torrents: NormalizedTorrent[];
  at: string;
}

export interface NotificationPayload {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  createdAt: string;
}

export interface EngineStatusPayload {
  engineId: string;
  online: boolean;
  error: string | null;
  at: string;
}
