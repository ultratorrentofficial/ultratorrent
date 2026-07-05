/**
 * Pluggable media-server providers — the same provider pattern used by the
 * torrent engines and metadata sources. Each provider knows how to probe a
 * server and trigger a library refresh. Real HTTP is used where the API is
 * simple; providers whose flows we can't fully exercise return a clean typed
 * "not implemented" result rather than throwing.
 */

export type MediaServerKind = 'plex' | 'jellyfin' | 'emby' | 'kodi';

/** Decrypted connection config passed to a provider at call time. */
export interface MediaServerConfig {
  baseUrl?: string;
  token?: string; // Plex token
  apiKey?: string; // Jellyfin/Emby
  username?: string; // Kodi basic auth
  password?: string; // Kodi basic auth
  librarySectionId?: string; // optional Plex section to refresh
}

export interface TestResult {
  ok: boolean;
  message: string;
  serverName?: string;
  version?: string;
}

/** What read capabilities a provider supports — analytics degrades gracefully. */
export interface MediaServerCapabilities {
  libraries: boolean;
  recentlyAdded: boolean;
  sessions: boolean;
  watchHistory: boolean;
  refresh: boolean;
}

export interface ServerInfo {
  kind: MediaServerKind;
  reachable: boolean;
  name?: string;
  version?: string;
  platform?: string;
  capabilities: MediaServerCapabilities;
  message?: string;
}

export interface MediaServerLibrary {
  id: string;
  name: string;
  type: string; // movie | show | music | photo | mixed | unknown
  itemCount?: number;
}

/** A normalized now-playing session, provider-agnostic. */
export interface ProviderSession {
  sessionId: string;
  userId?: string;
  userName?: string;
  title: string;
  mediaType?: string;
  libraryName?: string;
  device?: string;
  client?: string;
  ipAddress?: string;
  playbackState?: string; // playing | paused | buffering
  progressPercent?: number;
  playbackMethod?: string; // directplay | directstream | transcode
  videoCodec?: string;
  audioCodec?: string;
  resolution?: string;
}

/** Thrown when a provider genuinely cannot serve a capability (not a failure). */
export class UnsupportedCapabilityError extends Error {
  constructor(
    public readonly capability: string,
    public readonly kind: string,
  ) {
    super(`${kind} does not support "${capability}".`);
    this.name = 'UnsupportedCapabilityError';
  }
}

export interface MediaServerProvider {
  readonly kind: MediaServerKind;
  capabilities(): MediaServerCapabilities;
  testConnection(cfg: MediaServerConfig): Promise<TestResult>;
  getServerInfo(cfg: MediaServerConfig): Promise<ServerInfo>;
  /** Throws {@link UnsupportedCapabilityError} when the provider can't list libraries. */
  getLibraries(cfg: MediaServerConfig): Promise<MediaServerLibrary[]>;
  /** Now-playing sessions. Throws {@link UnsupportedCapabilityError} where unsupported. */
  getSessions(cfg: MediaServerConfig): Promise<ProviderSession[]>;
  refreshLibrary(cfg: MediaServerConfig): Promise<void>;
}

function pct(offset?: number, total?: number): number | undefined {
  if (!offset || !total) return undefined;
  return Math.round((offset / total) * 100);
}

/** Build a ServerInfo from a testConnection result + declared capabilities. */
async function serverInfoFrom(
  provider: MediaServerProvider,
  cfg: MediaServerConfig,
  platform?: string,
): Promise<ServerInfo> {
  const t = await provider.testConnection(cfg);
  return {
    kind: provider.kind,
    reachable: t.ok,
    name: t.serverName,
    version: t.version,
    platform,
    capabilities: provider.capabilities(),
    message: t.message,
  };
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<{ ok: boolean; status: number; json: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function requireBaseUrl(cfg: MediaServerConfig): string {
  const base = (cfg.baseUrl ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('baseUrl is required');
  return base;
}

function mapPlexType(t?: string): string {
  switch (t) {
    case 'movie': return 'movie';
    case 'show': return 'show';
    case 'artist': return 'music';
    case 'photo': return 'photo';
    default: return 'unknown';
  }
}

function mapJellyfinType(t?: string): string {
  switch ((t ?? '').toLowerCase()) {
    case 'movies': return 'movie';
    case 'tvshows': return 'show';
    case 'music': return 'music';
    case 'photos': case 'homevideos': return 'photo';
    default: return 'mixed';
  }
}

/** Plex Media Server — token auth, XML/JSON endpoints. */
export class PlexProvider implements MediaServerProvider {
  readonly kind = 'plex' as const;

  capabilities(): MediaServerCapabilities {
    return { libraries: true, recentlyAdded: true, sessions: true, watchHistory: true, refresh: true };
  }

  getServerInfo(cfg: MediaServerConfig): Promise<ServerInfo> {
    return serverInfoFrom(this, cfg, 'Plex Media Server');
  }

  async getLibraries(cfg: MediaServerConfig): Promise<MediaServerLibrary[]> {
    const base = requireBaseUrl(cfg);
    if (!cfg.token) throw new Error('Plex token is required.');
    const { ok, status, json } = await fetchJson(`${base}/library/sections`, {
      headers: { Accept: 'application/json', 'X-Plex-Token': cfg.token },
    });
    if (!ok) throw new Error(`Plex responded with HTTP ${status}.`);
    const dirs: any[] = json?.MediaContainer?.Directory ?? [];
    return dirs.map((d) => ({ id: String(d.key), name: d.title, type: mapPlexType(d.type) }));
  }

  async getSessions(cfg: MediaServerConfig): Promise<ProviderSession[]> {
    const base = requireBaseUrl(cfg);
    if (!cfg.token) throw new Error('Plex token is required.');
    const { ok, status, json } = await fetchJson(`${base}/status/sessions`, {
      headers: { Accept: 'application/json', 'X-Plex-Token': cfg.token },
    });
    if (!ok) throw new Error(`Plex responded with HTTP ${status}.`);
    const items: any[] = json?.MediaContainer?.Metadata ?? [];
    return items.map((m) => {
      const media = m.Media?.[0] ?? {};
      const part = media.Part?.[0] ?? {};
      const decision = (part.decision ?? m.Player?.state) as string | undefined;
      return {
        sessionId: String(m.Session?.id ?? m.sessionKey ?? `${m.ratingKey}`),
        userId: m.User?.id ? String(m.User.id) : undefined,
        userName: m.User?.title,
        title: [m.grandparentTitle, m.title].filter(Boolean).join(' — ') || m.title || 'Unknown',
        mediaType: m.type,
        libraryName: m.librarySectionTitle,
        device: m.Player?.device,
        client: m.Player?.product,
        ipAddress: m.Player?.address,
        playbackState: m.Player?.state,
        progressPercent: pct(m.viewOffset, m.duration),
        playbackMethod: part.decision === 'transcode' ? 'transcode' : decision,
        videoCodec: media.videoCodec,
        audioCodec: media.audioCodec,
        resolution: media.videoResolution,
      };
    });
  }

  async testConnection(cfg: MediaServerConfig): Promise<TestResult> {
    try {
      const base = requireBaseUrl(cfg);
      if (!cfg.token) return { ok: false, message: 'Plex token is required.' };
      const { ok, status, json } = await fetchJson(`${base}/identity`, {
        headers: { Accept: 'application/json', 'X-Plex-Token': cfg.token },
      });
      if (!ok) return { ok: false, message: `Plex responded with HTTP ${status}.` };
      const mc = json?.MediaContainer ?? {};
      return {
        ok: true,
        message: 'Connected to Plex.',
        version: mc.version,
        serverName: mc.friendlyName,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async refreshLibrary(cfg: MediaServerConfig): Promise<void> {
    const base = requireBaseUrl(cfg);
    if (!cfg.token) throw new Error('Plex token is required.');
    const section = cfg.librarySectionId
      ? `/library/sections/${cfg.librarySectionId}/refresh`
      : '/library/sections/all/refresh';
    const { ok, status } = await fetchJson(`${base}${section}`, {
      headers: { 'X-Plex-Token': cfg.token },
    });
    if (!ok) throw new Error(`Plex refresh failed with HTTP ${status}.`);
  }
}

/** Shared Jellyfin/Emby implementation (compatible APIs). */
class JellyfinEmbyBase {
  constructor(private readonly headerName: string) {}

  async test(cfg: MediaServerConfig, label: string): Promise<TestResult> {
    try {
      const base = requireBaseUrl(cfg);
      if (!cfg.apiKey) return { ok: false, message: `${label} API key is required.` };
      const { ok, status, json } = await fetchJson(`${base}/System/Info/Public`, {
        headers: { Accept: 'application/json', [this.headerName]: cfg.apiKey },
      });
      if (!ok) return { ok: false, message: `${label} responded with HTTP ${status}.` };
      return {
        ok: true,
        message: `Connected to ${label}.`,
        version: json?.Version,
        serverName: json?.ServerName,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async refresh(cfg: MediaServerConfig): Promise<void> {
    const base = requireBaseUrl(cfg);
    if (!cfg.apiKey) throw new Error('API key is required.');
    const { ok, status } = await fetchJson(`${base}/Library/Refresh`, {
      method: 'POST',
      headers: { [this.headerName]: cfg.apiKey },
    });
    if (!ok) throw new Error(`Library refresh failed with HTTP ${status}.`);
  }

  async libraries(cfg: MediaServerConfig): Promise<MediaServerLibrary[]> {
    const base = requireBaseUrl(cfg);
    if (!cfg.apiKey) throw new Error('API key is required.');
    const { ok, status, json } = await fetchJson(`${base}/Library/VirtualFolders`, {
      headers: { Accept: 'application/json', [this.headerName]: cfg.apiKey },
    });
    if (!ok) throw new Error(`Library listing failed with HTTP ${status}.`);
    const folders: any[] = Array.isArray(json) ? json : [];
    return folders.map((f) => ({ id: String(f.ItemId ?? f.Name), name: f.Name, type: mapJellyfinType(f.CollectionType) }));
  }

  async sessions(cfg: MediaServerConfig): Promise<ProviderSession[]> {
    const base = requireBaseUrl(cfg);
    if (!cfg.apiKey) throw new Error('API key is required.');
    const { ok, status, json } = await fetchJson(`${base}/Sessions`, {
      headers: { Accept: 'application/json', [this.headerName]: cfg.apiKey },
    });
    if (!ok) throw new Error(`Sessions request failed with HTTP ${status}.`);
    const list: any[] = Array.isArray(json) ? json : [];
    return list
      .filter((s) => s.NowPlayingItem)
      .map((s) => {
        const item = s.NowPlayingItem ?? {};
        const play = s.PlayState ?? {};
        const stream = item.MediaStreams ?? [];
        const video = stream.find((x: any) => x.Type === 'Video');
        const audio = stream.find((x: any) => x.Type === 'Audio');
        return {
          sessionId: String(s.Id),
          userId: s.UserId ? String(s.UserId) : undefined,
          userName: s.UserName,
          title: [item.SeriesName, item.Name].filter(Boolean).join(' — ') || item.Name || 'Unknown',
          mediaType: (item.Type ?? '').toLowerCase(),
          device: s.DeviceName,
          client: s.Client,
          ipAddress: s.RemoteEndPoint,
          playbackState: play.IsPaused ? 'paused' : 'playing',
          progressPercent: pct(play.PositionTicks, item.RunTimeTicks),
          playbackMethod: play.PlayMethod ? String(play.PlayMethod).toLowerCase() : undefined,
          videoCodec: video?.Codec,
          audioCodec: audio?.Codec,
          resolution: video?.Height ? `${video.Height}p` : undefined,
        };
      });
  }
}

const JELLYFIN_EMBY_CAPS: MediaServerCapabilities = {
  libraries: true, recentlyAdded: true, sessions: true, watchHistory: true, refresh: true,
};

export class JellyfinProvider implements MediaServerProvider {
  readonly kind = 'jellyfin' as const;
  private readonly impl = new JellyfinEmbyBase('X-Emby-Token');
  capabilities() { return JELLYFIN_EMBY_CAPS; }
  testConnection(cfg: MediaServerConfig) { return this.impl.test(cfg, 'Jellyfin'); }
  getServerInfo(cfg: MediaServerConfig) { return serverInfoFrom(this, cfg, 'Jellyfin'); }
  getLibraries(cfg: MediaServerConfig) { return this.impl.libraries(cfg); }
  getSessions(cfg: MediaServerConfig) { return this.impl.sessions(cfg); }
  refreshLibrary(cfg: MediaServerConfig) { return this.impl.refresh(cfg); }
}

export class EmbyProvider implements MediaServerProvider {
  readonly kind = 'emby' as const;
  private readonly impl = new JellyfinEmbyBase('X-Emby-Token');
  capabilities() { return JELLYFIN_EMBY_CAPS; }
  testConnection(cfg: MediaServerConfig) { return this.impl.test(cfg, 'Emby'); }
  getServerInfo(cfg: MediaServerConfig) { return serverInfoFrom(this, cfg, 'Emby'); }
  getLibraries(cfg: MediaServerConfig) { return this.impl.libraries(cfg); }
  getSessions(cfg: MediaServerConfig) { return this.impl.sessions(cfg); }
  refreshLibrary(cfg: MediaServerConfig) { return this.impl.refresh(cfg); }
}

/** Kodi — JSON-RPC over HTTP (optional basic auth). */
export class KodiProvider implements MediaServerProvider {
  readonly kind = 'kodi' as const;

  private authHeader(cfg: MediaServerConfig): Record<string, string> {
    if (cfg.username) {
      const creds = Buffer.from(`${cfg.username}:${cfg.password ?? ''}`).toString('base64');
      return { Authorization: `Basic ${creds}` };
    }
    return {};
  }

  private async rpc(cfg: MediaServerConfig, method: string, params?: unknown) {
    const base = requireBaseUrl(cfg);
    return fetchJson(`${base}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader(cfg) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  }

  capabilities(): MediaServerCapabilities {
    // Kodi is a client library, not a multi-user server — no section list,
    // sessions API, or watch history in the sense the other providers expose.
    return { libraries: false, recentlyAdded: true, sessions: false, watchHistory: false, refresh: true };
  }

  getServerInfo(cfg: MediaServerConfig): Promise<ServerInfo> {
    return serverInfoFrom(this, cfg, 'Kodi');
  }

  async getLibraries(_cfg: MediaServerConfig): Promise<MediaServerLibrary[]> {
    throw new UnsupportedCapabilityError('getLibraries', this.kind);
  }

  async getSessions(_cfg: MediaServerConfig): Promise<ProviderSession[]> {
    throw new UnsupportedCapabilityError('getSessions', this.kind);
  }

  async testConnection(cfg: MediaServerConfig): Promise<TestResult> {
    try {
      requireBaseUrl(cfg);
      const { ok, status, json } = await this.rpc(cfg, 'JSONRPC.Ping');
      if (!ok) return { ok: false, message: `Kodi responded with HTTP ${status}.` };
      if (json?.result === 'pong') {
        return { ok: true, message: 'Connected to Kodi.' };
      }
      return { ok: false, message: 'Unexpected response from Kodi JSON-RPC.' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async refreshLibrary(cfg: MediaServerConfig): Promise<void> {
    const { ok, status } = await this.rpc(cfg, 'VideoLibrary.Scan');
    if (!ok) throw new Error(`Kodi library scan failed with HTTP ${status}.`);
  }
}

/** Resolve a provider implementation for a server kind. */
export function getMediaServerProvider(kind: string): MediaServerProvider {
  switch (kind) {
    case 'plex':
      return new PlexProvider();
    case 'jellyfin':
      return new JellyfinProvider();
    case 'emby':
      return new EmbyProvider();
    case 'kodi':
      return new KodiProvider();
    default:
      throw new Error(`Unsupported media server kind "${kind}".`);
  }
}
