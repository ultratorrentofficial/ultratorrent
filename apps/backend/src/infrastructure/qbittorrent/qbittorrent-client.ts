/**
 * Minimal HTTP client for the qBittorrent Web API v2.
 *
 * qBittorrent authenticates with a session cookie: POST /api/v2/auth/login with
 * form username/password returns an `SID` cookie that must ride on every later
 * call. Node's global `fetch` does NOT persist cookies, so this client caches
 * the SID, attaches it, and transparently re-logs-in once on a 403 (expired
 * session). A `Referer` matching the base URL is sent so qBittorrent's
 * CSRF/DNS-rebind protection accepts the request.
 *
 * This is the qBittorrent analogue of `infrastructure/rtorrent/scgi-client.ts`.
 */

export interface QbittorrentClientOptions {
  /** e.g. `http://qbittorrent:8080` (no trailing `/api/v2`). */
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
}

export interface MultipartFile {
  field: string;
  buffer: Buffer;
  filename: string;
  contentType?: string;
}

/** The surface the provider depends on (kept small so tests can mock it). */
export interface QbittorrentApi {
  login(): Promise<void>;
  logout(): Promise<void>;
  getText(path: string, query?: Record<string, string | number>): Promise<string>;
  getJson<T = unknown>(
    path: string,
    query?: Record<string, string | number>,
  ): Promise<T>;
  postForm(
    path: string,
    fields: Record<string, string | number | undefined>,
  ): Promise<string>;
  postMultipart(
    path: string,
    fields: Record<string, string | number | undefined>,
    file?: MultipartFile,
  ): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 15000;

export class QbittorrentClient implements QbittorrentApi {
  private readonly base: string;
  private readonly api: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private sid: string | null = null;

  constructor(opts: QbittorrentClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.api = `${this.base}/api/v2`;
    this.username = opts.username;
    this.password = opts.password;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async login(): Promise<void> {
    const body = new URLSearchParams({
      username: this.username,
      password: this.password,
    }).toString();
    const res = await this.fetchRaw('POST', '/auth/login', {
      body,
      contentType: 'application/x-www-form-urlencoded',
      withAuth: false,
    });
    const text = (await res.text()).trim();
    if (res.status === 403) {
      throw new Error(
        'qBittorrent login failed: 403 (Web UI banned this client for too many failed attempts, or host-header validation rejected it)',
      );
    }
    if (res.status !== 200 || text !== 'Ok.') {
      throw new Error(
        `qBittorrent login failed (${res.status}): ${text || 'check username/password'}`,
      );
    }
    const sid = this.extractSid(res);
    if (!sid) {
      throw new Error('qBittorrent login succeeded but returned no SID cookie');
    }
    this.sid = sid;
  }

  async logout(): Promise<void> {
    if (!this.sid) return;
    try {
      await this.fetchRaw('POST', '/auth/logout', { withAuth: true });
    } catch {
      /* best-effort */
    }
    this.sid = null;
  }

  async getText(
    path: string,
    query?: Record<string, string | number>,
  ): Promise<string> {
    const res = await this.request('GET', path + this.qs(query));
    return (await res.text()).trim();
  }

  async getJson<T = unknown>(
    path: string,
    query?: Record<string, string | number>,
  ): Promise<T> {
    const res = await this.request('GET', path + this.qs(query));
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  async postForm(
    path: string,
    fields: Record<string, string | number | undefined>,
  ): Promise<string> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) params.append(k, String(v));
    }
    const res = await this.request('POST', path, {
      body: params.toString(),
      contentType: 'application/x-www-form-urlencoded',
    });
    return (await res.text()).trim();
  }

  async postMultipart(
    path: string,
    fields: Record<string, string | number | undefined>,
    file?: MultipartFile,
  ): Promise<string> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) form.append(k, String(v));
    }
    if (file) {
      form.append(
        file.field,
        new Blob([file.buffer], {
          type: file.contentType ?? 'application/x-bittorrent',
        }),
        file.filename,
      );
    }
    // Let fetch set the multipart Content-Type (with boundary) itself.
    const res = await this.request('POST', path, { formBody: form });
    return (await res.text()).trim();
  }

  // --- internals -----------------------------------------------------------

  /** Auth-aware request: lazy-login, attach SID, re-login once on 403. */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts: {
      body?: string;
      formBody?: FormData;
      contentType?: string;
    } = {},
  ): Promise<Response> {
    if (!this.sid) await this.login();
    let res = await this.fetchRaw(method, path, { ...opts, withAuth: true });
    if (res.status === 403) {
      // Session expired/invalidated — re-authenticate and retry once.
      this.sid = null;
      await this.login();
      res = await this.fetchRaw(method, path, { ...opts, withAuth: true });
    }
    if (res.status < 200 || res.status >= 300) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(
        `qBittorrent ${method} ${path} failed (${res.status})${text ? `: ${text}` : ''}`,
      );
    }
    return res;
  }

  private async fetchRaw(
    method: 'GET' | 'POST',
    path: string,
    opts: {
      body?: string;
      formBody?: FormData;
      contentType?: string;
      withAuth: boolean;
    },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { Referer: this.base };
      if (opts.contentType) headers['Content-Type'] = opts.contentType;
      if (opts.withAuth && this.sid) headers['Cookie'] = `SID=${this.sid}`;
      return await fetch(`${this.api}${path}`, {
        method,
        headers,
        body: opts.formBody ?? opts.body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(
          `qBittorrent ${method} ${path} timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new Error(
        `qBittorrent ${method} ${path} request failed: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private extractSid(res: Response): string | null {
    // Node 20+ exposes getSetCookie(); fall back to the combined header.
    const cookies: string[] =
      typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie ===
      'function'
        ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
        : [res.headers.get('set-cookie') ?? ''];
    for (const c of cookies) {
      const m = /(?:^|;\s*)SID=([^;]+)/.exec(c);
      if (m) return m[1];
    }
    return null;
  }

  private qs(query?: Record<string, string | number>): string {
    if (!query) return '';
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) params.append(k, String(v));
    const s = params.toString();
    return s ? `?${s}` : '';
  }
}
