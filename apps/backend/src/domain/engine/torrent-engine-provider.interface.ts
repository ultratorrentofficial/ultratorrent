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
/** Bytes per second, or `null` for unlimited. */
export interface GlobalRateLimits {
  downloadBytesPerSec: number | null;
  uploadBytesPerSec: number | null;
}

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
  /**
   * Run regardless of the engine's queue limits. Pass `false` to clear the flag and
   * hand the torrent back to the normal queue — the parking sweep needs both halves:
   * force-start to guarantee a parked torrent actually announces (a plain resume on a
   * full queue lands it in `queued`, where it never would), then clear it afterwards.
   */
  forceStart(hash: string, value?: boolean): Promise<void>;
  recheckTorrent(hash: string): Promise<void>;

  // Mutation
  /**
   * Point this torrent at `destination`.
   *
   * **Whether this MOVES the data is engine-specific**, which is why
   * {@link relocationMovesData} exists. qBittorrent's `setLocation` relocates
   * the payload; rTorrent's `d.directory.set` only updates where rTorrent
   * *believes* the data is and moves nothing. Calling this on rTorrent without
   * having physically moved the files first tells the client the data lives
   * somewhere it does not — and the torrent stops seeding for a reason nothing
   * reports.
   */
  moveStorage(hash: string, destination: string): Promise<void>;

  /**
   * Does {@link moveStorage} physically relocate the payload on disk?
   *
   * Declared rather than probed: finding out empirically would mean moving a
   * real torrent to see what happens. The Media Intake capability detector
   * reads this to decide whether `provider_relocation` is a usable import
   * strategy for a given engine, so the core engine stays free of any
   * engine-specific branching.
   */
  relocationMovesData(): boolean;
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

  /**
   * The engine's GLOBAL transfer ceiling, in bytes per second. `null` means
   * unlimited — never `-1` or `0`, which are engine conventions and belong
   * inside an adapter.
   *
   * Optional on purpose. Both shipped engines support it and already REPORT it
   * (`getGlobalStats` reads `dl_rate_limit` on qBittorrent and
   * `throttle.global_down.max_rate` on rTorrent), so only the setter was
   * missing. Making it optional means an engine someone else wrote keeps
   * compiling, and a caller that finds the method absent knows the capability is
   * genuinely unavailable rather than merely unimplemented here.
   */
  setGlobalRateLimits?(limits: GlobalRateLimits): Promise<void>;
  getGlobalRateLimits?(): Promise<GlobalRateLimits>;

  /**
   * Everything this engine has ever transferred, including torrents it no
   * longer holds — used once, to seed the transfer ledger's baseline so
   * adopting an engine does not discard its history.
   *
   * Optional, and the distinction it draws is the point. qBittorrent maintains
   * a genuine all-time counter across restarts; rTorrent's global totals reset
   * with the daemon, which makes them a session figure and an actively
   * misleading baseline. An engine that cannot answer truthfully must return
   * `null` (or omit the method) rather than substitute a number that merely
   * looks plausible — the ledger falls back to summing current torrents, which
   * is honestly incomplete instead of quietly wrong.
   */
  getAllTimeStats?(): Promise<{ downloaded: bigint; uploaded: bigint } | null>;

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
