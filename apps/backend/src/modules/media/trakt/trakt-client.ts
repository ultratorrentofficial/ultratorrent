/**
 * Trakt.tv API client (API v2).
 *
 * Auth is the **device flow**: UltraTorrent is a server, often headless, with no
 * browser to redirect. We ask Trakt for a code, show it to the operator, and poll
 * until they approve it at trakt.tv/activate. The polling contract is precise and
 * unusually strict — Trakt distinguishes "still waiting" (400) from "you are
 * polling too fast" (429) from "the user said no" (418) — and getting it wrong
 * gets an application throttled, so each status is handled explicitly rather than
 * collapsed into a generic failure.
 *
 * The ID-selection logic is pure and exported, because it is where a scrobble can
 * go badly wrong: marking the wrong show watched in someone's account is not a
 * bug you can quietly fix later.
 */
const BASE = 'https://api.trakt.tv';
const TIMEOUT_MS = 10_000;

/**
 * Trakt sits behind Cloudflare, which BLOCKS Node's default fetch User-Agent
 * (undici sends none) with a 403 and an HTML challenge page — before the request
 * ever reaches Trakt. The credentials are irrelevant to it. Any identifying UA
 * gets through, so we send one; without this, every call fails 403 and looks
 * exactly like a rejected client ID.
 */
const USER_AGENT = 'UltraTorrent (+https://github.com/damirabal/ultratorrent-core)';

export interface TraktCredentials {
  clientId: string;
  clientSecret: string;
}

export interface TraktTokens {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry, computed from Trakt's `created_at` + `expires_in`. */
  expiresAt: Date;
  scope?: string;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInSec: number;
  intervalSec: number;
}

/** Why a device-code poll has not produced a token (yet, or ever). */
export type PollStatus =
  | 'pending' // 400 — the user has not entered the code yet
  | 'slow_down' // 429 — we polled faster than `interval`
  | 'not_found' // 404 — the device code is invalid
  | 'used' // 409 — already exchanged
  | 'expired' // 410 — the code timed out
  | 'denied'; // 418 — the user explicitly rejected it

export class TraktPollError extends Error {
  constructor(readonly status: PollStatus) {
    super(`Trakt device authorization: ${status}`);
  }
}

// ---------------------------------------------------------------------------
// Pure identity mapping — exported for tests.
// ---------------------------------------------------------------------------

export interface TraktIds {
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
  trakt?: number;
}

/**
 * Narrow our loose `{provider: id}` map to the ids Trakt accepts, coercing the
 * numeric ones. A non-numeric tmdb/tvdb id is DROPPED rather than sent as a
 * string — Trakt would silently ignore the whole object and match on nothing.
 */
export function toTraktIds(externalIds: Record<string, string> | null | undefined): TraktIds {
  const ids: TraktIds = {};
  if (!externalIds) return ids;
  const imdb = externalIds.imdb?.trim();
  if (imdb && /^tt\d+$/.test(imdb)) ids.imdb = imdb;
  for (const key of ['tmdb', 'tvdb', 'trakt'] as const) {
    const raw = externalIds[key];
    const n = Number(raw);
    if (raw && Number.isInteger(n) && n > 0) ids[key] = n;
  }
  return ids;
}

export function hasAnyId(ids: TraktIds): boolean {
  return Boolean(ids.imdb || ids.tmdb || ids.tvdb || ids.trakt);
}

export interface ScrobbleSubject {
  mediaType?: string | null;
  /** Ids of the item itself — the EPISODE's ids for an episode. */
  externalIds?: Record<string, string> | null;
  showTitle?: string | null;
  title?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  year?: number | null;
}

/**
 * Build the body Trakt identifies a play by, or null when we cannot identify it
 * confidently.
 *
 * Returning null is a feature. Trakt will happily accept a fuzzy title and mark
 * *something* watched; if we cannot say which episode of which show this is, the
 * right answer is to scrobble nothing rather than to pollute someone's history
 * with a guess.
 *
 * Order of preference:
 *   1. the item's own ids (an episode's ids identify it outright),
 *   2. show title + season + episode number (Trakt matches the show, we supply
 *      the numbering — no ambiguity about *which* episode),
 *   3. a movie's ids or its title + year.
 */
export function buildScrobbleBody(
  subject: ScrobbleSubject,
  progressPercent: number,
): Record<string, unknown> | null {
  const progress = Math.max(0, Math.min(100, progressPercent));
  const ids = toTraktIds(subject.externalIds);
  const isEpisode =
    subject.mediaType === 'episode' ||
    (subject.seasonNumber != null && subject.episodeNumber != null);

  if (isEpisode) {
    if (hasAnyId(ids)) return { episode: { ids }, progress };
    if (subject.showTitle && subject.seasonNumber != null && subject.episodeNumber != null) {
      return {
        show: { title: subject.showTitle, ...(subject.year ? { year: subject.year } : {}) },
        episode: { season: subject.seasonNumber, number: subject.episodeNumber },
        progress,
      };
    }
    // An episode we cannot number and have no id for: refuse.
    return null;
  }

  if (subject.mediaType === 'movie') {
    if (hasAnyId(ids)) return { movie: { ids }, progress };
    if (subject.title) {
      return {
        movie: { title: subject.title, ...(subject.year ? { year: subject.year } : {}) },
        progress,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------

export class TraktClient {
  constructor(private readonly creds: TraktCredentials) {}

  private headers(accessToken?: string): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': this.creds.clientId,
      // Required in practice — see USER_AGENT. Cloudflare 403s a UA-less request.
      'User-Agent': USER_AGENT,
    };
    if (accessToken) h.Authorization = `Bearer ${accessToken}`;
    return h;
  }

  private async call(
    path: string,
    init: RequestInit & { accessToken?: string; timeoutMs?: number } = {},
  ): Promise<{ status: number; json: any; pageCount: number }> {
    const { accessToken, timeoutMs, ...rest } = init;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? TIMEOUT_MS);
    try {
      const res = await fetch(BASE + path, {
        ...rest,
        headers: this.headers(accessToken),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      // Trakt paginates by header, not in the body — a truncated response looks
      // exactly like a complete one. Ignoring this is how a 11,297-entry history
      // silently syncs as its most recent 1,000 and reports success.
      const pageCount = Number(res.headers.get('x-pagination-page-count')) || 1;
      return { status: res.status, json, pageCount };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Step 1 of the device flow: get a code for the operator to enter. */
  async requestDeviceCode(): Promise<DeviceCode> {
    const { status, json } = await this.call('/oauth/device/code', {
      method: 'POST',
      body: JSON.stringify({ client_id: this.creds.clientId }),
    });
    if (status !== 200 || !json?.device_code) {
      // A 403 whose body did not parse as JSON never reached Trakt: it is
      // Cloudflare's HTML challenge page. Blaming the client ID for that sends
      // the operator off to re-check credentials that were never the problem —
      // which is exactly what happened before the User-Agent was added.
      if (status === 403 && json === null) {
        throw new Error(
          "Blocked by Trakt's CDN before the request reached Trakt (HTTP 403). This is not a credentials problem.",
        );
      }
      throw new Error(
        status === 403
          ? 'Trakt rejected the client ID. Check the application credentials.'
          : `Trakt could not issue a device code (HTTP ${status}).`,
      );
    }
    return {
      deviceCode: json.device_code,
      userCode: json.user_code,
      verificationUrl: json.verification_url,
      expiresInSec: json.expires_in,
      intervalSec: json.interval,
    };
  }

  /**
   * Step 2: exchange the device code for tokens — ONE attempt.
   *
   * The caller owns the polling loop and its interval; conflating the two here
   * would hide `slow_down` (429), which is the one response that must change the
   * caller's timing rather than just be retried.
   */
  async pollDeviceToken(deviceCode: string): Promise<TraktTokens> {
    const { status, json } = await this.call('/oauth/device/token', {
      method: 'POST',
      body: JSON.stringify({
        code: deviceCode,
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
      }),
    });
    if (status === 200 && json?.access_token) return this.tokensFrom(json);

    const map: Record<number, PollStatus> = {
      400: 'pending',
      404: 'not_found',
      409: 'used',
      410: 'expired',
      418: 'denied',
      429: 'slow_down',
    };
    throw new TraktPollError(map[status] ?? 'not_found');
  }

  /** Trade a refresh token for a fresh pair. */
  async refresh(refreshToken: string): Promise<TraktTokens> {
    const { status, json } = await this.call('/oauth/token', {
      method: 'POST',
      body: JSON.stringify({
        refresh_token: refreshToken,
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        grant_type: 'refresh_token',
      }),
    });
    if (status !== 200 || !json?.access_token) {
      throw new Error(`Trakt refused to refresh the token (HTTP ${status}).`);
    }
    return this.tokensFrom(json);
  }

  private tokensFrom(json: any): TraktTokens {
    // Trakt gives created_at + expires_in (seconds), not an absolute expiry.
    const createdMs = (Number(json.created_at) || Math.floor(Date.now() / 1000)) * 1000;
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: new Date(createdMs + Number(json.expires_in ?? 0) * 1000),
      scope: json.scope,
    };
  }

  /** The authenticated user — used to confirm and label the link. */
  async me(accessToken: string): Promise<{ username?: string; slug?: string }> {
    const { status, json } = await this.call('/users/me', { accessToken });
    if (status !== 200) throw new Error(`Trakt /users/me failed (HTTP ${status}).`);
    return { username: json?.username, slug: json?.ids?.slug };
  }

  async get<T = any>(path: string, accessToken: string): Promise<T> {
    const { status, json } = await this.call(path, { accessToken });
    if (status === 401) throw new Error('Trakt rejected the access token.');
    if (status < 200 || status >= 300) throw new Error(`Trakt GET ${path} failed (HTTP ${status}).`);
    return json as T;
  }

  /**
   * GET every page of a paginated collection.
   *
   * Trakt reports the page count in a HEADER; the body of a truncated first page
   * is indistinguishable from a complete result. So a single `limit=1000` GET of
   * an 11,297-entry history returns the most recent 1,000 and looks like a
   * success — which is exactly what it did, silently, until this existed.
   *
   * `truncated` is returned rather than swallowed: if a history is so large that
   * we hit the page ceiling, the caller says so out loud instead of reporting a
   * partial sync as a complete one.
   */
  async getAll<T = any>(
    path: string,
    accessToken: string,
    opts: { limit?: number; maxPages?: number } = {},
  ): Promise<{ items: T[]; pages: number; truncated: boolean }> {
    const limit = opts.limit ?? 1000;
    const maxPages = opts.maxPages ?? 100; // 100k entries at limit=1000
    const sep = path.includes('?') ? '&' : '?';
    const items: T[] = [];
    let page = 1;
    let pages = 1;

    do {
      const { status, json, pageCount } = await this.call(
        `${path}${sep}page=${page}&limit=${limit}`,
        { accessToken },
      );
      if (status === 401) throw new Error('Trakt rejected the access token.');
      if (status < 200 || status >= 300) {
        throw new Error(`Trakt GET ${path} page ${page} failed (HTTP ${status}).`);
      }
      if (Array.isArray(json)) items.push(...json);
      pages = pageCount;
      page++;
    } while (page <= pages && page <= maxPages);

    return { items, pages, truncated: pages > maxPages };
  }

  /**
   * `timeoutMs` exists for the sync endpoints: a collection or history batch is
   * thousands of entries, and Trakt takes far longer to chew on that than on the
   * small calls the 10s default was sized for.
   */
  async post<T = any>(
    path: string,
    body: unknown,
    accessToken: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const { status, json } = await this.call(path, {
      method: 'POST',
      body: JSON.stringify(body),
      accessToken,
      timeoutMs: opts.timeoutMs,
    });
    if (status === 401) throw new Error('Trakt rejected the access token.');
    // 409 on a scrobble means "already scrobbling this" — the caller decides
    // whether that is a problem, so surface the status rather than throwing.
    if (status === 409) return { conflict: true } as T;
    if (status < 200 || status >= 300) {
      throw new Error(`Trakt POST ${path} failed (HTTP ${status}).`);
    }
    return json as T;
  }
}
