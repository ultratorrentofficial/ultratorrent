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

export interface MediaServerProvider {
  readonly kind: MediaServerKind;
  testConnection(cfg: MediaServerConfig): Promise<TestResult>;
  refreshLibrary(cfg: MediaServerConfig): Promise<void>;
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

/** Plex Media Server — token auth, XML/JSON endpoints. */
export class PlexProvider implements MediaServerProvider {
  readonly kind = 'plex' as const;

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
}

export class JellyfinProvider implements MediaServerProvider {
  readonly kind = 'jellyfin' as const;
  private readonly impl = new JellyfinEmbyBase('X-Emby-Token');
  testConnection(cfg: MediaServerConfig) {
    return this.impl.test(cfg, 'Jellyfin');
  }
  refreshLibrary(cfg: MediaServerConfig) {
    return this.impl.refresh(cfg);
  }
}

export class EmbyProvider implements MediaServerProvider {
  readonly kind = 'emby' as const;
  private readonly impl = new JellyfinEmbyBase('X-Emby-Token');
  testConnection(cfg: MediaServerConfig) {
    return this.impl.test(cfg, 'Emby');
  }
  refreshLibrary(cfg: MediaServerConfig) {
    return this.impl.refresh(cfg);
  }
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
