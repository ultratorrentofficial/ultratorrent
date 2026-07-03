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
} as const;

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
