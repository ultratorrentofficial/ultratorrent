/**
 * Normalized, engine-agnostic torrent domain types.
 *
 * Every TorrentEngineProvider maps its native representation into these shapes.
 * The frontend and application layer ONLY ever see these — never raw rTorrent /
 * qBittorrent / Transmission fields. This is the core of the provider abstraction.
 */

export enum TorrentState {
  DOWNLOADING = 'downloading',
  SEEDING = 'seeding',
  PAUSED = 'paused',
  STOPPED = 'stopped',
  QUEUED = 'queued',
  CHECKING = 'checking',
  ERROR = 'error',
  COMPLETED = 'completed',
  ALLOCATING = 'allocating',
  UNKNOWN = 'unknown',
}

export enum FilePriority {
  SKIP = 0,
  NORMAL = 1,
  HIGH = 2,
}

export enum TorrentPriority {
  OFF = 0,
  LOW = 1,
  NORMAL = 2,
  HIGH = 3,
}

export interface NormalizedTorrent {
  /** Lowercase info-hash, the stable cross-engine identity. */
  hash: string;
  name: string;
  state: TorrentState;
  /** 0..1 fraction complete. */
  progress: number;
  /** Total size in bytes. */
  size: number;
  /** Bytes downloaded (this session-independent, total). */
  downloaded: number;
  /** Bytes uploaded total. */
  uploaded: number;
  ratio: number;
  downloadRate: number; // bytes/sec
  uploadRate: number; // bytes/sec
  /** Estimated seconds remaining, or null when not downloading. */
  eta: number | null;
  seedsConnected: number;
  seedsTotal: number;
  peersConnected: number;
  peersTotal: number;
  priority: TorrentPriority;
  label: string | null;
  savePath: string;
  isPrivate: boolean;
  message: string | null;
  addedAt: string | null; // ISO 8601
  completedAt: string | null; // ISO 8601
  engineId: string;
}

/**
 * The RSS automation rule that auto-downloaded a torrent, resolved by info-hash
 * from the recorded match evaluation. Null when the torrent was added manually
 * or by a legacy (non-preference-list) rule that logs no evaluation.
 */
export interface TorrentMatchedRule {
  ruleId: string;
  ruleName: string;
  feedId: string;
  /** Winning preference-list candidate, when the rule used one. */
  matchedCandidateId: string | null;
  /** When the auto-download was triggered (ISO 8601). */
  matchedAt: string;
}

export interface NormalizedFile {
  index: number;
  path: string;
  size: number;
  downloaded: number;
  progress: number;
  priority: FilePriority;
}

export interface NormalizedPeer {
  ip: string;
  port: number;
  client: string | null;
  country: string | null;
  progress: number;
  downloadRate: number;
  uploadRate: number;
  encrypted: boolean;
}

export interface NormalizedTracker {
  url: string;
  tier: number;
  status: 'enabled' | 'disabled' | 'working' | 'error';
  seeders: number | null;
  leechers: number | null;
  message: string | null;
}

export interface GlobalStats {
  downloadRate: number;
  uploadRate: number;
  downloadRateLimit: number;
  uploadRateLimit: number;
  totalDownloaded: number;
  totalUploaded: number;
  torrentCount: number;
  activeCount: number;
}

export interface SessionStats {
  engineVersion: string;
  peerId: string | null;
  listenPort: number | null;
  dhtEnabled: boolean;
  freeDiskBytes: number | null;
  totalDiskBytes: number | null;
}

export interface AddTorrentOptions {
  category?: string;
  tags?: string[];
  savePath?: string;
  rename?: string;
  startPaused?: boolean;
  sequentialDownload?: boolean;
  firstLastPiecePriority?: boolean;
  uploadLimit?: number;
  downloadLimit?: number;
  queuePosition?: 'top' | 'bottom';
}

export type EngineKind = 'rtorrent' | 'qbittorrent' | 'transmission' | 'deluge';

export interface EngineHealth {
  online: boolean;
  latencyMs: number | null;
  version: string | null;
  error: string | null;
  checkedAt: string;
}
