import { Logger } from '@nestjs/common';
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
  TorrentState,
} from '@ultratorrent/shared';
import {
  EngineConnectionConfig,
  TorrentEngineProvider,
} from '../../../domain/engine/torrent-engine-provider.interface';
import {
  QbittorrentApi,
  QbittorrentClient,
} from '../../qbittorrent/qbittorrent-client';
import { infoHashFromTorrent } from '../../rtorrent/bencode';
import { fetchRemoteTorrent } from '../../../common/ssrf';

/** Derive the lowercase info-hash from a magnet URI (40-hex or base32). */
function magnetHash(magnet: string): string | null {
  const m = /xt=urn:btih:([a-zA-Z0-9]+)/.exec(magnet);
  if (!m) return null;
  const raw = m[1];
  if (raw.length === 32) return base32ToHex(raw).toLowerCase();
  return raw.toLowerCase();
}

function base32ToHex(input: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of input.toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/** qBittorrent `torrents/info` item (only the fields this provider reads). */
interface QbTorrentInfo {
  hash: string;
  name: string;
  state: string;
  progress: number;
  size: number;
  downloaded: number;
  uploaded: number;
  ratio: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  num_seeds: number;
  num_complete: number;
  num_leechs: number;
  num_incomplete: number;
  category?: string;
  save_path: string;
  added_on: number;
  completion_on: number;
  private?: boolean;
}

// qBittorrent uses 8640000 (100 days) as its "infinite ETA" sentinel.
const QB_INFINITE_ETA = 8640000;

/**
 * Map qBittorrent's rich `state` string enum onto the normalized `TorrentState`.
 * https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-5.0)
 */
function mapState(state: string): TorrentState {
  switch (state) {
    case 'error':
    case 'missingFiles':
      return TorrentState.ERROR;
    case 'pausedUP':
    case 'pausedDL':
    case 'stoppedUP':
    case 'stoppedDL':
      return TorrentState.PAUSED;
    case 'queuedUP':
    case 'queuedDL':
    case 'queuedForChecking':
      return TorrentState.QUEUED;
    case 'uploading':
    case 'forcedUP':
    case 'stalledUP':
      return TorrentState.SEEDING;
    case 'checkingUP':
    case 'checkingDL':
    case 'checkingResumeData':
    case 'moving':
      return TorrentState.CHECKING;
    case 'allocating':
      return TorrentState.ALLOCATING;
    case 'downloading':
    case 'forcedDL':
    case 'stalledDL':
    case 'metaDL':
    case 'forcedMetaDL':
      return TorrentState.DOWNLOADING;
    default:
      return TorrentState.UNKNOWN;
  }
}

/** qBittorrent file priority (0 skip, 1 normal, 6 high, 7 maximal) → normalized. */
function mapFilePriorityFromQb(p: number): FilePriority {
  if (p <= 0) return FilePriority.SKIP;
  if (p === 1) return FilePriority.NORMAL;
  return FilePriority.HIGH;
}

/** Normalized file priority → qBittorrent scale. */
function mapFilePriorityToQb(p: FilePriority): number {
  if (p === FilePriority.SKIP) return 0;
  if (p === FilePriority.HIGH) return 6;
  return 1;
}

/**
 * qBittorrent engine provider over the Web API v2.
 *
 * Recommended over rTorrent for large libraries: rTorrent 0.9.8 has an unfixed
 * scheduler crash that scales with active-torrent count, whereas qBittorrent
 * handles thousands of torrents comfortably.
 */
export class QbittorrentProvider implements TorrentEngineProvider {
  readonly kind: EngineKind = 'qbittorrent';
  readonly engineId: string;
  private readonly client: QbittorrentApi;
  private readonly logger = new Logger(QbittorrentProvider.name);

  /**
   * `torrents/add` returns "Ok."/"Fails." — not the info-hash, and the torrent
   * is not listed synchronously. As with rTorrent we poll until the hash (which
   * we derive locally) appears. A timeout is a hard failure for a .torrent file
   * (metadata present → registers fast) but only "still loading" for a magnet
   * (metadata resolves via DHT/peers, often minutes later). ~6s total.
   */
  private addConfirmAttempts = 20;
  private addConfirmIntervalMs = 300;

  constructor(cfgOrClient: EngineConnectionConfig | QbittorrentApi) {
    if ('kind' in cfgOrClient) {
      const cfg = cfgOrClient;
      this.engineId = cfg.engineId;
      this.client = new QbittorrentClient({
        baseUrl: cfg.baseUrl ?? cfg.url ?? `http://${cfg.host}:${cfg.port ?? 8080}`,
        username: cfg.username ?? '',
        password: cfg.password ?? '',
        timeoutMs: cfg.timeoutMs,
      });
    } else {
      // Test seam: inject a mock client. engineId is set separately in tests.
      this.engineId = 'engine-qbit';
      this.client = cfgOrClient;
    }
  }

  // --- lifecycle -----------------------------------------------------------
  async connect(): Promise<void> {
    await this.client.login();
  }

  async disconnect(): Promise<void> {
    await this.client.logout();
  }

  async healthCheck(): Promise<EngineHealth> {
    const started = Date.now();
    try {
      const version = await this.client.getText('/app/version');
      return {
        online: true,
        latencyMs: Date.now() - started,
        version: version.replace(/^v/, ''),
        error: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        online: false,
        latencyMs: null,
        version: null,
        error: (err as Error).message,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  // --- reads ---------------------------------------------------------------
  async listTorrents(): Promise<NormalizedTorrent[]> {
    const rows = await this.client.getJson<QbTorrentInfo[]>('/torrents/info');
    return (rows ?? []).map((t) => this.mapTorrent(t));
  }

  async getTorrent(hash: string): Promise<NormalizedTorrent | null> {
    const rows = await this.client.getJson<QbTorrentInfo[]>('/torrents/info', {
      hashes: hash.toLowerCase(),
    });
    const row = (rows ?? [])[0];
    return row ? this.mapTorrent(row) : null;
  }

  private mapTorrent(t: QbTorrentInfo): NormalizedTorrent {
    return {
      hash: (t.hash ?? '').toLowerCase(),
      name: t.name ?? '',
      state: mapState(t.state),
      progress: t.progress ?? 0,
      size: t.size ?? 0,
      downloaded: t.downloaded ?? 0,
      uploaded: t.uploaded ?? 0,
      ratio: t.ratio ?? 0,
      downloadRate: t.dlspeed ?? 0,
      uploadRate: t.upspeed ?? 0,
      eta: t.eta == null || t.eta >= QB_INFINITE_ETA ? null : t.eta,
      seedsConnected: t.num_seeds ?? 0,
      seedsTotal: Math.max(0, t.num_complete ?? 0),
      peersConnected: t.num_leechs ?? 0,
      peersTotal: Math.max(0, t.num_incomplete ?? 0),
      // qBittorrent's per-torrent "priority" is a queue position, not our
      // OFF/LOW/NORMAL/HIGH scale — report NORMAL rather than mislabel it.
      priority: TorrentPriority.NORMAL,
      label: t.category || null,
      savePath: t.save_path ?? '',
      isPrivate: t.private ?? false,
      message: null,
      addedAt: t.added_on ? new Date(t.added_on * 1000).toISOString() : null,
      completedAt:
        t.completion_on && t.completion_on > 0
          ? new Date(t.completion_on * 1000).toISOString()
          : null,
      engineId: this.engineId,
    };
  }

  async getFiles(hash: string): Promise<NormalizedFile[]> {
    const rows = await this.client.getJson<
      Array<{ index?: number; name: string; size: number; progress: number; priority: number }>
    >('/torrents/files', { hash: hash.toLowerCase() });
    return (rows ?? []).map((f, i) => {
      const size = f.size ?? 0;
      const progress = f.progress ?? 0;
      return {
        index: f.index ?? i,
        path: f.name ?? '',
        size,
        downloaded: Math.round(size * progress),
        progress,
        priority: mapFilePriorityFromQb(f.priority ?? 1),
      };
    });
  }

  async getPeers(hash: string): Promise<NormalizedPeer[]> {
    const data = await this.client.getJson<{
      peers?: Record<
        string,
        {
          ip: string;
          port: number;
          client?: string;
          country_code?: string;
          country?: string;
          progress?: number;
          dl_speed?: number;
          up_speed?: number;
          flags?: string;
        }
      >;
    }>('/sync/torrentPeers', { hash: hash.toLowerCase(), rid: 0 });
    return Object.values(data?.peers ?? {}).map((p) => ({
      ip: p.ip,
      port: p.port,
      client: p.client || null,
      country: p.country_code || p.country || null,
      progress: p.progress ?? 0,
      downloadRate: p.dl_speed ?? 0,
      uploadRate: p.up_speed ?? 0,
      encrypted: /E/.test(p.flags ?? ''),
    }));
  }

  async getTrackers(hash: string): Promise<NormalizedTracker[]> {
    const rows = await this.client.getJson<
      Array<{
        url: string;
        tier: number;
        status: number;
        num_seeds?: number;
        num_leeches?: number;
        msg?: string;
      }>
    >('/torrents/trackers', { hash: hash.toLowerCase() });
    return (rows ?? [])
      // Drop the DHT/PeX/LSD pseudo-rows (url like `** [DHT] **`, tier -1).
      .filter((t) => !t.url.startsWith('**'))
      .map((t) => ({
        url: t.url,
        tier: Math.max(0, t.tier ?? 0),
        status: mapTrackerStatus(t.status),
        seeders: t.num_seeds != null && t.num_seeds >= 0 ? t.num_seeds : null,
        leechers:
          t.num_leeches != null && t.num_leeches >= 0 ? t.num_leeches : null,
        message: t.msg || null,
      }));
  }

  async getGlobalStats(): Promise<GlobalStats> {
    const [transfer, torrents] = await Promise.all([
      this.client.getJson<{
        dl_info_speed: number;
        up_info_speed: number;
        dl_rate_limit: number;
        up_rate_limit: number;
      }>('/transfer/info'),
      this.listTorrents(),
    ]);
    return {
      downloadRate: transfer?.dl_info_speed ?? 0,
      uploadRate: transfer?.up_info_speed ?? 0,
      downloadRateLimit: transfer?.dl_rate_limit ?? 0,
      uploadRateLimit: transfer?.up_rate_limit ?? 0,
      totalDownloaded: torrents.reduce((a, t) => a + t.downloaded, 0),
      totalUploaded: torrents.reduce((a, t) => a + t.uploaded, 0),
      torrentCount: torrents.length,
      activeCount: torrents.filter(
        (t) =>
          t.state === TorrentState.DOWNLOADING ||
          t.state === TorrentState.SEEDING,
      ).length,
    };
  }

  async getSessionStats(): Promise<SessionStats> {
    const [version, prefs, main] = await Promise.all([
      this.client.getText('/app/version'),
      this.client.getJson<{ listen_port?: number; dht?: boolean }>(
        '/app/preferences',
      ),
      this.client
        .getJson<{ server_state?: { free_space_on_disk?: number } }>(
          '/sync/maindata',
          { rid: 0 },
        )
        .catch(() => null),
    ]);
    return {
      engineVersion: version.replace(/^v/, ''),
      peerId: null,
      listenPort: prefs?.listen_port ?? null,
      dhtEnabled: prefs?.dht ?? false,
      freeDiskBytes: main?.server_state?.free_space_on_disk ?? null,
      totalDiskBytes: null,
    };
  }

  // --- adding --------------------------------------------------------------
  private addFields(
    options?: AddTorrentOptions,
  ): Record<string, string | number | undefined> {
    return {
      savepath: options?.savePath,
      category: options?.category,
      tags: options?.tags?.length ? options.tags.join(',') : undefined,
      rename: options?.rename,
      paused: options?.startPaused ? 'true' : undefined,
      stopped: options?.startPaused ? 'true' : undefined, // qB 5.0 alias
      sequentialDownload: options?.sequentialDownload ? 'true' : undefined,
      firstLastPiecePrio: options?.firstLastPiecePriority ? 'true' : undefined,
      upLimit: options?.uploadLimit,
      dlLimit: options?.downloadLimit,
    };
  }

  async addMagnet(magnet: string, options?: AddTorrentOptions): Promise<string> {
    const hash = magnetHash(magnet);
    if (!hash) throw new Error('Could not derive info-hash from magnet URI');
    await this.assertOk(
      this.client.postMultipart('/torrents/add', {
        urls: magnet,
        ...this.addFields(options),
      }),
    );
    await this.confirmTorrentLoaded(hash, { magnet: true });
    return hash;
  }

  async addTorrentFile(
    file: Buffer,
    options?: AddTorrentOptions,
  ): Promise<string> {
    const hash = infoHashFromTorrent(file);
    await this.assertOk(
      this.client.postMultipart(
        '/torrents/add',
        this.addFields(options),
        { field: 'torrents', buffer: file, filename: 'file.torrent' },
      ),
    );
    await this.confirmTorrentLoaded(hash);
    return hash;
  }

  async addTorrentURL(
    url: string,
    options?: AddTorrentOptions,
  ): Promise<string> {
    // SSRF-safe fetch (scheme allow-list, internal-IP block, no redirects, size
    // cap) then add as a file — same as rTorrent, and it yields the info-hash.
    const buf = await fetchRemoteTorrent(url);
    return this.addTorrentFile(buf, options);
  }

  /** `torrents/add` answers "Ok."/"Fails." — turn "Fails." into an error. */
  private async assertOk(pending: Promise<string>): Promise<void> {
    const body = await pending;
    if (/^fails\.?$/i.test(body.trim())) {
      throw new Error('qBittorrent rejected the torrent (Fails.)');
    }
  }

  /**
   * Poll until the added info-hash appears. A .torrent file that never shows up
   * is a hard failure; a magnet that doesn't is just "still resolving metadata"
   * (see the rTorrent provider — same rationale/observed behaviour).
   */
  private async confirmTorrentLoaded(
    hash: string,
    opts?: { magnet?: boolean },
  ): Promise<void> {
    const target = hash.toLowerCase();
    for (let attempt = 0; ; attempt++) {
      try {
        const t = await this.getTorrent(target);
        if (t) return;
      } catch {
        // Transient transport error — keep polling within the window.
      }
      if (attempt >= this.addConfirmAttempts - 1) break;
      await new Promise((r) => setTimeout(r, this.addConfirmIntervalMs));
    }
    const secs = (this.addConfirmAttempts * this.addConfirmIntervalMs) / 1000;
    if (opts?.magnet) {
      this.logger.debug(
        `Magnet ${hash} not yet registered after ${secs}s — still fetching metadata; leaving it to load.`,
      );
      return;
    }
    throw new Error(
      `qBittorrent accepted the request but never registered torrent ${hash} within ${secs}s — it likely failed to load (e.g. an unusable torrent)`,
    );
  }

  // --- removal -------------------------------------------------------------
  async removeTorrent(hash: string): Promise<void> {
    await this.client.postForm('/torrents/delete', {
      hashes: hash.toLowerCase(),
      deleteFiles: 'false',
    });
  }

  async removeTorrentAndData(hash: string): Promise<void> {
    await this.client.postForm('/torrents/delete', {
      hashes: hash.toLowerCase(),
      deleteFiles: 'true',
    });
  }

  // --- state transitions ---------------------------------------------------
  async startTorrent(hash: string): Promise<void> {
    await this.client.postForm('/torrents/resume', { hashes: hash.toLowerCase() });
  }
  async stopTorrent(hash: string): Promise<void> {
    await this.client.postForm('/torrents/pause', { hashes: hash.toLowerCase() });
  }
  async pauseTorrent(hash: string): Promise<void> {
    await this.client.postForm('/torrents/pause', { hashes: hash.toLowerCase() });
  }
  async resumeTorrent(hash: string): Promise<void> {
    await this.client.postForm('/torrents/resume', { hashes: hash.toLowerCase() });
  }
  async forceStart(hash: string): Promise<void> {
    await this.client.postForm('/torrents/setForceStart', {
      hashes: hash.toLowerCase(),
      value: 'true',
    });
  }
  async recheckTorrent(hash: string): Promise<void> {
    await this.client.postForm('/torrents/recheck', {
      hashes: hash.toLowerCase(),
    });
  }

  // --- mutation ------------------------------------------------------------
  async moveStorage(hash: string, destination: string): Promise<void> {
    await this.client.postForm('/torrents/setLocation', {
      hashes: hash.toLowerCase(),
      location: destination,
    });
  }
  async renameTorrent(hash: string, name: string): Promise<void> {
    await this.client.postForm('/torrents/rename', {
      hash: hash.toLowerCase(),
      name,
    });
  }
  async renameFile(
    hash: string,
    fileIndex: number,
    newName: string,
  ): Promise<void> {
    // qBittorrent renames by path, not index — resolve the current path first.
    const files = await this.getFiles(hash);
    const file = files.find((f) => f.index === fileIndex);
    if (!file) throw new Error(`File index ${fileIndex} not found`);
    const oldPath = file.path;
    // A bare new name replaces just the last path segment; an explicit path is
    // used verbatim.
    const newPath = newName.includes('/')
      ? newName
      : oldPath.includes('/')
        ? `${oldPath.slice(0, oldPath.lastIndexOf('/'))}/${newName}`
        : newName;
    await this.client.postForm('/torrents/renameFile', {
      hash: hash.toLowerCase(),
      oldPath,
      newPath,
    });
  }
  async setFilePriority(
    hash: string,
    fileIndex: number,
    priority: FilePriority,
  ): Promise<void> {
    await this.client.postForm('/torrents/filePrio', {
      hash: hash.toLowerCase(),
      id: fileIndex,
      priority: mapFilePriorityToQb(priority),
    });
  }
  async setTorrentPriority(
    hash: string,
    priority: TorrentPriority,
  ): Promise<void> {
    // qBittorrent has no fixed priority scale — only queue position. Map the
    // extremes to top/bottom of the queue; NORMAL is a no-op. (Requires queue
    // management enabled in qBittorrent; a 409 is swallowed as a no-op.)
    let path: string | null = null;
    if (priority === TorrentPriority.HIGH) path = '/torrents/topPrio';
    else if (priority === TorrentPriority.OFF || priority === TorrentPriority.LOW)
      path = '/torrents/bottomPrio';
    if (!path) return;
    try {
      await this.client.postForm(path, { hashes: hash.toLowerCase() });
    } catch (err) {
      if (/\b409\b/.test((err as Error).message)) return; // queueing disabled
      throw err;
    }
  }
  async setUploadLimit(hash: string, bytesPerSec: number): Promise<void> {
    await this.client.postForm('/torrents/setUploadLimit', {
      hashes: hash.toLowerCase(),
      limit: bytesPerSec,
    });
  }
  async setDownloadLimit(hash: string, bytesPerSec: number): Promise<void> {
    await this.client.postForm('/torrents/setDownloadLimit', {
      hashes: hash.toLowerCase(),
      limit: bytesPerSec,
    });
  }

  // --- trackers ------------------------------------------------------------
  async addTracker(hash: string, url: string): Promise<void> {
    await this.client.postForm('/torrents/addTrackers', {
      hash: hash.toLowerCase(),
      urls: url,
    });
  }
  async removeTracker(hash: string, url: string): Promise<void> {
    await this.client.postForm('/torrents/removeTrackers', {
      hash: hash.toLowerCase(),
      urls: url,
    });
  }
}

/** qBittorrent tracker status code → normalized status. */
function mapTrackerStatus(status: number): NormalizedTracker['status'] {
  switch (status) {
    case 0:
      return 'disabled';
    case 2:
      return 'working';
    case 4:
      return 'error';
    default:
      return 'enabled'; // 1 not-contacted, 3 updating
  }
}
