import {
  AddTorrentOptions,
  EngineHealth,
  EngineKind,
  FilePriority,
  GlobalStats,
  NormalizedFile,
  NormalizedPeer,
  NormalizedTorrent,
  NormalizedTracker,
  SessionStats,
  TorrentPriority,
} from '@ultratorrent/shared';

/**
 * The single seam between UltraTorrent's business logic and any concrete
 * torrent engine. The application & API layers depend ONLY on this interface.
 *
 * A new engine (qBittorrent, Transmission, Deluge) is added by implementing
 * this contract — no existing business logic changes.
 */
export interface TorrentEngineProvider {
  readonly engineId: string;
  readonly kind: EngineKind;

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<EngineHealth>;

  // Reads
  listTorrents(): Promise<NormalizedTorrent[]>;
  getTorrent(hash: string): Promise<NormalizedTorrent | null>;
  getFiles(hash: string): Promise<NormalizedFile[]>;
  getPeers(hash: string): Promise<NormalizedPeer[]>;
  getTrackers(hash: string): Promise<NormalizedTracker[]>;
  getGlobalStats(): Promise<GlobalStats>;
  getSessionStats(): Promise<SessionStats>;

  // Adding
  addMagnet(magnet: string, options?: AddTorrentOptions): Promise<string>;
  addTorrentFile(
    file: Buffer,
    options?: AddTorrentOptions,
  ): Promise<string>;
  addTorrentURL(url: string, options?: AddTorrentOptions): Promise<string>;

  // Removal
  removeTorrent(hash: string): Promise<void>;
  removeTorrentAndData(hash: string): Promise<void>;

  // State transitions
  startTorrent(hash: string): Promise<void>;
  stopTorrent(hash: string): Promise<void>;
  pauseTorrent(hash: string): Promise<void>;
  resumeTorrent(hash: string): Promise<void>;
  forceStart(hash: string): Promise<void>;
  recheckTorrent(hash: string): Promise<void>;

  // Mutation
  moveStorage(hash: string, destination: string): Promise<void>;
  renameTorrent(hash: string, name: string): Promise<void>;
  renameFile(hash: string, fileIndex: number, newName: string): Promise<void>;
  setFilePriority(
    hash: string,
    fileIndex: number,
    priority: FilePriority,
  ): Promise<void>;
  setTorrentPriority(hash: string, priority: TorrentPriority): Promise<void>;
  setUploadLimit(hash: string, bytesPerSec: number): Promise<void>;
  setDownloadLimit(hash: string, bytesPerSec: number): Promise<void>;

  // Trackers
  addTracker(hash: string, url: string): Promise<void>;
  removeTracker(hash: string, url: string): Promise<void>;
}

export interface EngineConnectionConfig {
  kind: EngineKind;
  engineId: string;
  // rTorrent transport
  mode?: 'scgi-tcp' | 'scgi-unix' | 'http';
  host?: string;
  port?: number;
  socketPath?: string;
  url?: string;
  timeoutMs?: number;
  // qBittorrent Web API transport
  baseUrl?: string;
  username?: string;
  password?: string;
}
