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
  createRtorrentTransport,
  RtorrentTransport,
} from '../../rtorrent/scgi-client';
import { XmlRpcBase64, XmlRpcValue } from '../../rtorrent/xmlrpc';
import { infoHashFromTorrent } from '../../rtorrent/bencode';
import { fetchRemoteTorrent } from '../../../common/ssrf';

/** Field accessors requested per torrent in d.multicall2 (order matters). */
const TORRENT_FIELDS = [
  'd.hash=',
  'd.name=',
  'd.size_bytes=',
  'd.completed_bytes=',
  'd.up.total=',
  'd.down.rate=',
  'd.up.rate=',
  'd.ratio=',
  'd.left_bytes=',
  'd.state=',
  'd.is_active=',
  'd.complete=',
  'd.is_open=',
  'd.hashing=',
  'd.message=',
  'd.priority=',
  'd.directory=',
  'd.custom1=',
  'd.timestamp.started=',
  'd.timestamp.finished=',
  'd.peers_connected=',
  'd.peers_complete=',
  'd.peers_accounted=',
  'd.is_private=',
] as const;

function num(v: XmlRpcValue): number {
  return typeof v === 'number' ? v : Number(v) || 0;
}
function str(v: XmlRpcValue): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

function mapState(row: Record<number, XmlRpcValue>): TorrentState {
  const state = num(row[9]); // d.state (0 stopped, 1 started)
  const isActive = num(row[10]) === 1;
  const complete = num(row[11]) === 1;
  const isOpen = num(row[12]) === 1;
  const hashing = num(row[13]) !== 0;
  const message = str(row[14]);

  if (hashing) return TorrentState.CHECKING;
  if (message && /error|unreachable|denied/i.test(message))
    return TorrentState.ERROR;
  if (state === 0) return TorrentState.STOPPED;
  if (!isActive && isOpen) return TorrentState.PAUSED;
  if (complete) return TorrentState.SEEDING;
  return TorrentState.DOWNLOADING;
}

function magnetHash(magnet: string): string | null {
  const m = /xt=urn:btih:([a-zA-Z0-9]+)/.exec(magnet);
  if (!m) return null;
  const raw = m[1];
  if (raw.length === 40) return raw.toLowerCase();
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

export class RTorrentProvider implements TorrentEngineProvider {
  readonly kind: EngineKind = 'rtorrent';
  readonly engineId: string;
  private readonly transport: RtorrentTransport;

  /**
   * How long to wait for rtorrent to actually register an added torrent before
   * treating the add as failed. `load.*` is fire-and-forget (returns 0
   * immediately and loads asynchronously), so without this an add that rtorrent
   * silently dropped — a bad magnet, or an engine crash mid-announce — would be
   * reported as success and the caller would record a phantom download.
   * ~6s total; overridden to tiny values in tests.
   */
  private addConfirmAttempts = 20;
  private addConfirmIntervalMs = 300;

  constructor(cfg: EngineConnectionConfig) {
    this.engineId = cfg.engineId;
    this.transport = createRtorrentTransport({
      mode: cfg.mode ?? 'scgi-tcp',
      host: cfg.host,
      port: cfg.port,
      socketPath: cfg.socketPath,
      url: cfg.url,
      timeoutMs: cfg.timeoutMs,
    });
  }

  // --- lifecycle -----------------------------------------------------------
  async connect(): Promise<void> {
    await this.transport.call('system.client_version');
  }

  async disconnect(): Promise<void> {
    // Stateless transport — nothing to tear down.
  }

  async healthCheck(): Promise<EngineHealth> {
    const started = Date.now();
    try {
      const version = await this.transport.call('system.client_version');
      return {
        online: true,
        latencyMs: Date.now() - started,
        version: str(version),
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
    const result = (await this.transport.call('d.multicall2', [
      '',
      'main',
      ...TORRENT_FIELDS,
    ])) as XmlRpcValue[];
    return (result ?? []).map((row) =>
      this.mapTorrentRow(row as XmlRpcValue[]),
    );
  }

  async getTorrent(hash: string): Promise<NormalizedTorrent | null> {
    try {
      const values = await Promise.all(
        TORRENT_FIELDS.map((f) =>
          this.transport.call(f.replace(/=$/, ''), [hash]),
        ),
      );
      return this.mapTorrentRow(values);
    } catch {
      return null;
    }
  }

  private mapTorrentRow(row: XmlRpcValue[]): NormalizedTorrent {
    const r = row as unknown as Record<number, XmlRpcValue>;
    const size = num(r[2]);
    const completed = num(r[3]);
    const startedTs = num(r[18]);
    const finishedTs = num(r[19]);
    return {
      hash: str(r[0]).toLowerCase(),
      name: str(r[1]),
      size,
      downloaded: completed,
      uploaded: num(r[4]),
      downloadRate: num(r[5]),
      uploadRate: num(r[6]),
      ratio: num(r[7]) / 1000,
      progress: size > 0 ? Math.min(1, completed / size) : 0,
      eta: this.computeEta(num(r[8]), num(r[5])),
      state: mapState(r),
      message: str(r[14]) || null,
      priority: this.mapPriority(num(r[15])),
      savePath: str(r[16]),
      label: str(r[17]) || null,
      addedAt: startedTs ? new Date(startedTs * 1000).toISOString() : null,
      completedAt: finishedTs
        ? new Date(finishedTs * 1000).toISOString()
        : null,
      peersConnected: num(r[20]),
      seedsConnected: num(r[21]),
      peersTotal: num(r[22]),
      seedsTotal: num(r[21]),
      isPrivate: num(r[23]) === 1,
      engineId: this.engineId,
    };
  }

  private computeEta(leftBytes: number, downRate: number): number | null {
    if (leftBytes <= 0) return 0;
    if (downRate <= 0) return null;
    return Math.round(leftBytes / downRate);
  }

  private mapPriority(p: number): TorrentPriority {
    if (p <= 0) return TorrentPriority.OFF;
    if (p === 1) return TorrentPriority.LOW;
    if (p === 3) return TorrentPriority.HIGH;
    return TorrentPriority.NORMAL;
  }

  async getFiles(hash: string): Promise<NormalizedFile[]> {
    const rows = (await this.transport.call('f.multicall', [
      hash,
      '',
      'f.path=',
      'f.size_bytes=',
      'f.completed_chunks=',
      'f.size_chunks=',
      'f.priority=',
    ])) as XmlRpcValue[];
    return (rows ?? []).map((raw, index) => {
      const r = raw as XmlRpcValue[];
      const completedChunks = num(r[2]);
      const sizeChunks = num(r[3]);
      const progress = sizeChunks > 0 ? completedChunks / sizeChunks : 0;
      const size = num(r[1]);
      return {
        index,
        path: str(r[0]),
        size,
        downloaded: Math.round(size * progress),
        progress,
        priority: num(r[4]) as FilePriority,
      };
    });
  }

  async getPeers(hash: string): Promise<NormalizedPeer[]> {
    const rows = (await this.transport.call('p.multicall', [
      hash,
      '',
      'p.address=',
      'p.port=',
      'p.client_version=',
      'p.completed_percent=',
      'p.down_rate=',
      'p.up_rate=',
      'p.is_encrypted=',
    ])) as XmlRpcValue[];
    return (rows ?? []).map((raw) => {
      const r = raw as XmlRpcValue[];
      return {
        ip: str(r[0]),
        port: num(r[1]),
        client: str(r[2]) || null,
        country: null,
        progress: num(r[3]) / 100,
        downloadRate: num(r[4]),
        uploadRate: num(r[5]),
        encrypted: num(r[6]) === 1,
      };
    });
  }

  async getTrackers(hash: string): Promise<NormalizedTracker[]> {
    const rows = (await this.transport.call('t.multicall', [
      hash,
      '',
      't.url=',
      't.group=',
      't.is_enabled=',
      't.scrape_complete=',
      't.scrape_incomplete=',
    ])) as XmlRpcValue[];
    return (rows ?? []).map((raw) => {
      const r = raw as XmlRpcValue[];
      return {
        url: str(r[0]),
        tier: num(r[1]),
        status: num(r[2]) === 1 ? 'enabled' : 'disabled',
        seeders: num(r[3]) || null,
        leechers: num(r[4]) || null,
        message: null,
      } as NormalizedTracker;
    });
  }

  async getGlobalStats(): Promise<GlobalStats> {
    const [down, up, downMax, upMax] = await Promise.all([
      this.transport.call('throttle.global_down.rate'),
      this.transport.call('throttle.global_up.rate'),
      this.transport.call('throttle.global_down.max_rate'),
      this.transport.call('throttle.global_up.max_rate'),
    ]);
    const torrents = await this.listTorrents();
    return {
      downloadRate: num(down),
      uploadRate: num(up),
      downloadRateLimit: num(downMax),
      uploadRateLimit: num(upMax),
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
    const [version, port] = await Promise.all([
      this.transport.call('system.client_version'),
      this.transport.call('network.listen.port').catch(() => 0),
    ]);
    return {
      engineVersion: str(version),
      peerId: null,
      listenPort: num(port) || null,
      dhtEnabled: false,
      freeDiskBytes: null,
      totalDiskBytes: null,
    };
  }

  // --- adding --------------------------------------------------------------
  /**
   * rTorrent load options are string-interpolated into quoted commands, and the
   * XML-RPC escaper does NOT escape `"`. Reject quote/control chars so a value
   * cannot break out of the quoted literal into an `execute`-family command.
   * (The service also validates savePath against the allowed roots.)
   */
  private assertCommandSafe(value: string, label: string): void {
    if (/["\r\n\t\0]/.test(value)) {
      throw new Error(`Illegal ${label}: contains quote or control characters`);
    }
  }

  private buildLoadCommands(options?: AddTorrentOptions): string[] {
    const cmds: string[] = [];
    if (options?.savePath) {
      this.assertCommandSafe(options.savePath, 'save path');
      cmds.push(`d.directory.set="${options.savePath}"`);
    }
    if (options?.category) {
      this.assertCommandSafe(options.category, 'category');
      cmds.push(`d.custom1.set="${options.category}"`);
    }
    if (options?.uploadLimit)
      cmds.push(`d.throttle_name.set=`); // throttle group hook point
    return cmds;
  }

  async addMagnet(magnet: string, options?: AddTorrentOptions): Promise<string> {
    const hash = magnetHash(magnet);
    if (!hash) throw new Error('Could not derive info-hash from magnet URI');
    const method = options?.startPaused ? 'load.normal' : 'load.start';
    await this.transport.call(method, [
      '',
      magnet,
      ...this.buildLoadCommands(options),
    ]);
    await this.confirmTorrentLoaded(hash);
    return hash;
  }

  async addTorrentFile(
    file: Buffer,
    options?: AddTorrentOptions,
  ): Promise<string> {
    const method = options?.startPaused ? 'load.raw' : 'load.raw_start';
    await this.transport.call(method, [
      '',
      new XmlRpcBase64(file),
      ...this.buildLoadCommands(options),
    ]);
    const hash = infoHashFromTorrent(file);
    await this.confirmTorrentLoaded(hash);
    return hash;
  }

  /**
   * Poll rtorrent until the added info-hash shows up in the download list, so a
   * successful return genuinely means "rtorrent has this torrent". Throws if it
   * never appears within the confirm window — callers must treat that as a
   * failed add and NOT record a download. Compares case-insensitively:
   * `magnetHash`/`infoHashFromTorrent` yield lowercase and `listTorrents`
   * lowercases too, but rtorrent stores hashes uppercase, so normalize.
   */
  private async confirmTorrentLoaded(hash: string): Promise<void> {
    const target = hash.toLowerCase();
    for (let attempt = 0; ; attempt++) {
      try {
        const list = await this.listTorrents();
        if (list.some((t) => t.hash.toLowerCase() === target)) return;
      } catch {
        // Transport error (engine busy, crashed, or mid-restart) — keep polling
        // within the window; a persistent failure falls through to the throw.
      }
      if (attempt >= this.addConfirmAttempts - 1) break;
      await new Promise((r) => setTimeout(r, this.addConfirmIntervalMs));
    }
    throw new Error(
      `rtorrent accepted the request but never registered torrent ${hash} ` +
        `within ${(this.addConfirmAttempts * this.addConfirmIntervalMs) / 1000}s ` +
        `— it likely failed to load (e.g. an engine crash or an unusable magnet/torrent)`,
    );
  }

  async addTorrentURL(
    url: string,
    options?: AddTorrentOptions,
  ): Promise<string> {
    // SSRF-safe: scheme allow-list, internal-IP block, no redirects, size cap.
    const buf = await fetchRemoteTorrent(url);
    return this.addTorrentFile(buf, options);
  }

  // --- removal -------------------------------------------------------------
  async removeTorrent(hash: string): Promise<void> {
    await this.transport.call('d.erase', [hash]);
  }

  async removeTorrentAndData(hash: string): Promise<void> {
    // Resolve the torrent's OWN data path. For a single-file torrent this is the
    // file itself; for a multi-file torrent it is that torrent's directory.
    // We deliberately use d.base_path, NOT d.directory: for a single-file
    // torrent stored directly under the download root, d.directory is the shared
    // root — deleting it would wipe every torrent's data. base_path is scoped to
    // this torrent only. Must be read BEFORE erasing the torrent.
    const basePath = str(await this.transport.call('d.base_path', [hash]));

    // Stop and remove from the session first so rTorrent releases the files.
    await this.stopTorrent(hash).catch(() => undefined);
    await this.transport.call('d.erase', [hash]);

    // Guard against pathological paths before a recursive delete.
    const unsafe =
      !basePath ||
      basePath === '/' ||
      !basePath.startsWith('/') ||
      basePath.split('/').filter(Boolean).length < 2;
    if (!unsafe) {
      await this.transport
        .call('execute.throw', ['', 'rm', '-rf', basePath])
        .catch(() => undefined);
    }
  }

  // --- state transitions ---------------------------------------------------
  async startTorrent(hash: string): Promise<void> {
    await this.transport.call('d.start', [hash]);
  }
  async stopTorrent(hash: string): Promise<void> {
    await this.transport.call('d.stop', [hash]);
    await this.transport.call('d.close', [hash]).catch(() => undefined);
  }
  async pauseTorrent(hash: string): Promise<void> {
    await this.transport.call('d.pause', [hash]);
  }
  async resumeTorrent(hash: string): Promise<void> {
    await this.transport.call('d.resume', [hash]);
  }
  async forceStart(hash: string): Promise<void> {
    await this.transport.call('d.priority.set', [hash, 3]);
    await this.transport.call('d.start', [hash]);
  }
  async recheckTorrent(hash: string): Promise<void> {
    await this.transport.call('d.check_hash', [hash]);
  }

  // --- mutation ------------------------------------------------------------
  async moveStorage(hash: string, destination: string): Promise<void> {
    await this.transport.call('d.directory.set', [hash, destination]);
  }
  async renameTorrent(hash: string, name: string): Promise<void> {
    await this.transport.call('d.custom.set', [hash, 'name', name]);
  }
  async renameFile(): Promise<void> {
    // rTorrent does not expose per-file rename via XML-RPC; surfaced as
    // unsupported so the application layer can degrade gracefully.
    throw new Error('renameFile is not supported by the rTorrent engine');
  }
  async setFilePriority(
    hash: string,
    fileIndex: number,
    priority: FilePriority,
  ): Promise<void> {
    await this.transport.call('f.priority.set', [
      `${hash}:f${fileIndex}`,
      priority,
    ]);
    await this.transport.call('d.update_priorities', [hash]);
  }
  async setTorrentPriority(
    hash: string,
    priority: TorrentPriority,
  ): Promise<void> {
    await this.transport.call('d.priority.set', [hash, priority]);
  }
  async setUploadLimit(hash: string, bytesPerSec: number): Promise<void> {
    await this.transport.call('d.up.rate.set', [hash, bytesPerSec]).catch(
      async () => {
        await this.transport.call('d.throttle.up.set', [hash, bytesPerSec]);
      },
    );
  }
  async setDownloadLimit(hash: string, bytesPerSec: number): Promise<void> {
    await this.transport
      .call('d.down.rate.set', [hash, bytesPerSec])
      .catch(async () => {
        await this.transport.call('d.throttle.down.set', [hash, bytesPerSec]);
      });
  }

  // --- trackers ------------------------------------------------------------
  async addTracker(hash: string, url: string): Promise<void> {
    await this.transport.call('d.tracker.insert', [hash, '0', url]);
  }
  async removeTracker(hash: string, url: string): Promise<void> {
    const trackers = await this.getTrackers(hash);
    const index = trackers.findIndex((t) => t.url === url);
    if (index === -1) throw new Error('Tracker not found');
    await this.transport.call('t.disable', [`${hash}:t${index}`]);
  }
}
