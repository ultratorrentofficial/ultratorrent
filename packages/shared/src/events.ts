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
  IMDB_MATCH_COMPLETED: 'imdb.match.completed',
  IMDB_ENRICHMENT_COMPLETED: 'imdb.enrichment.completed',
} as const;

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
