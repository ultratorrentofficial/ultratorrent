/**
 * OpenSubtitles.com REST (v1) provider.
 *
 * Uses the official documented API with the operator's own credentials — never
 * scraping. Two traps are handled up front:
 *  1. Every request sends `Api-Key` AND a real `User-Agent`. OpenSubtitles (like
 *     any Cloudflare-fronted host) rejects a UA-less fetch outright — the same
 *     failure the Trakt integration hit, where it looked like "invalid client".
 *  2. Downloads consume a small DAILY QUOTA and require a JWT from `/login`. We
 *     surface the remaining quota rather than discovering exhaustion mid-pipeline.
 *
 * `search()` never throws (returns []); `download()` throws on hard failure so the
 * pipeline records a failed download.
 */
import { Logger } from '@nestjs/common';
import {
  DownloadedSubtitle,
  NormalizedSubtitle,
  ProviderHealth,
  SubtitleProvider,
  SubtitleProviderCapabilities,
  SubtitleSearchQuery,
  SUBTITLE_USER_AGENT,
  detectSubtitleFormat,
} from './subtitle-provider';

const API = 'https://api.opensubtitles.com/api/v1';
const TIMEOUT_MS = 12_000;
const MAX_SUB_BYTES = 3 * 1024 * 1024; // a subtitle over 3 MB is not a subtitle

export interface OpenSubtitlesConfig {
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
}

interface OsFile { file_id?: number; file_name?: string }
interface OsFeature {
  imdb_id?: number | null;
  tmdb_id?: number | null;
  season_number?: number | null;
  episode_number?: number | null;
  title?: string | null;
}
interface OsAttributes {
  language?: string;
  release?: string;
  download_count?: number;
  hearing_impaired?: boolean;
  from_trusted?: boolean;
  ai_translated?: boolean;
  machine_translated?: boolean;
  foreign_parts_only?: boolean;
  moviehash_match?: boolean;
  ratings?: number;
  uploader?: { name?: string };
  feature_details?: OsFeature;
  files?: OsFile[];
}

export class OpenSubtitlesProvider implements SubtitleProvider {
  readonly name = 'opensubtitles';
  private readonly logger = new Logger('OpenSubtitlesProvider');
  private token: string | null = null;

  constructor(private readonly config: OpenSubtitlesConfig) {}

  validateConfiguration(): boolean {
    return !!this.config.apiKey;
  }

  getCapabilities(): SubtitleProviderCapabilities {
    return {
      hashSearch: true,
      releaseSearch: true,
      imdbSearch: true,
      tmdbSearch: true,
      tvdbSearch: false,
      seriesSearch: true,
      forcedSubtitles: true,
      hearingImpaired: true,
      machineTranslation: true,
    };
  }
  supportsHashSearch() { return true; }
  supportsReleaseSearch() { return true; }
  supportsImdbSearch() { return true; }
  supportsTmdbSearch() { return true; }
  supportsTvdbSearch() { return false; }
  supportsSeriesSearch() { return true; }
  supportsForcedSubtitles() { return true; }
  supportsHearingImpaired() { return true; }
  supportsMachineTranslation() { return true; }

  private headers(auth = false): Record<string, string> {
    const h: Record<string, string> = {
      'Api-Key': this.config.apiKey ?? '',
      'User-Agent': SUBTITLE_USER_AGENT,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (auth && this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async fetchJson(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: any }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* non-JSON error body */
      }
      return { ok: res.ok, status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.validateConfiguration()) return { healthy: false, message: 'API key not set' };
    try {
      // A cheap search proves the key + UA are accepted.
      const { ok, status } = await this.fetchJson(`${API}/subtitles?query=test&languages=en`, {
        method: 'GET',
        headers: this.headers(),
      });
      return ok
        ? { healthy: true }
        : { healthy: false, message: `OpenSubtitles returned HTTP ${status}` };
    } catch (err) {
      return { healthy: false, message: (err as Error).message };
    }
  }

  /** Turn one raw result into the normalized shape. Pure over its input. */
  normalizeResult(raw: { attributes?: OsAttributes }, queryHash?: string | null): NormalizedSubtitle | null {
    const a = raw.attributes;
    if (!a) return null;
    const file = a.files?.[0];
    const f = a.feature_details ?? {};
    return {
      provider: this.name,
      providerFileId: file?.file_id != null ? String(file.file_id) : null,
      language: (a.language ?? 'und').toLowerCase(),
      releaseName: a.release ?? null,
      filename: file?.file_name ?? null,
      movieHash: a.moviehash_match && queryHash ? queryHash : null,
      imdbId: f.imdb_id != null ? `tt${String(f.imdb_id).padStart(7, '0')}` : null,
      tmdbId: f.tmdb_id != null ? String(f.tmdb_id) : null,
      tvdbId: null,
      season: f.season_number ?? null,
      episode: f.episode_number ?? null,
      runtimeSec: null,
      downloads: a.download_count ?? null,
      uploader: a.uploader?.name ?? null,
      rating: a.ratings ?? null,
      trustedUploader: !!a.from_trusted,
      machineTranslated: !!(a.machine_translated || a.ai_translated),
      hearingImpaired: !!a.hearing_impaired,
      forced: !!a.foreign_parts_only,
      fileSize: null,
      downloadUrl: null,
      matchLevel: a.moviehash_match ? 1 : undefined,
      rawMetadata: a as Record<string, unknown>,
    };
  }

  async search(query: SubtitleSearchQuery): Promise<NormalizedSubtitle[]> {
    if (!this.validateConfiguration()) return [];
    const params = new URLSearchParams();
    if (query.languages?.length) params.set('languages', query.languages.join(',').toLowerCase());
    if (query.movieHash) params.set('moviehash', query.movieHash);
    if (query.imdbId) params.set('imdb_id', query.imdbId.replace(/^tt/i, ''));
    if (query.tmdbId) params.set('tmdb_id', query.tmdbId);
    if (query.season != null) params.set('season_number', String(query.season));
    if (query.episode != null) params.set('episode_number', String(query.episode));
    if (query.title && !query.imdbId && !query.tmdbId) params.set('query', query.title);
    if (query.releaseName && !query.imdbId && !query.movieHash && !query.title) {
      params.set('query', query.releaseName);
    }
    if (query.hearingImpaired === false) params.set('hearing_impaired', 'exclude');
    if (query.forced) params.set('foreign_parts_only', 'only');
    if ([...params.keys()].length === 0) return [];

    try {
      const { ok, body } = await this.fetchJson(`${API}/subtitles?${params.toString()}`, {
        method: 'GET',
        headers: this.headers(),
      });
      if (!ok || !Array.isArray(body?.data)) return [];
      return (body.data as Array<{ attributes?: OsAttributes }>)
        .map((d) => this.normalizeResult(d, query.movieHash))
        .filter((s): s is NormalizedSubtitle => s !== null);
    } catch (err) {
      this.logger.warn(`search failed: ${(err as Error).message}`);
      return [];
    }
  }

  /** Obtain (and cache) a JWT for downloads; throws when credentials are missing/invalid. */
  private async login(): Promise<void> {
    if (this.token) return;
    if (!this.config.username || !this.config.password) {
      throw new Error('OpenSubtitles username/password required to download');
    }
    const { ok, status, body } = await this.fetchJson(`${API}/login`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ username: this.config.username, password: this.config.password }),
    });
    if (!ok || !body?.token) throw new Error(`OpenSubtitles login failed (HTTP ${status})`);
    this.token = body.token as string;
  }

  async download(candidate: NormalizedSubtitle): Promise<DownloadedSubtitle> {
    if (!candidate.providerFileId) throw new Error('candidate has no file id');
    await this.login();

    const { ok, status, body } = await this.fetchJson(`${API}/download`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ file_id: Number(candidate.providerFileId) }),
    });
    if (!ok || !body?.link) {
      const msg = body?.message ? `: ${body.message}` : '';
      throw new Error(`OpenSubtitles download request failed (HTTP ${status})${msg}`);
    }

    // Fetch the actual subtitle bytes from the temporary link.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(body.link as string, {
        headers: { 'User-Agent': SUBTITLE_USER_AGENT },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`subtitle fetch failed (HTTP ${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_SUB_BYTES) {
        throw new Error(`subtitle size out of bounds (${buf.length} bytes)`);
      }
      const format =
        detectSubtitleFormat(body.file_name as string) ??
        detectSubtitleFormat(candidate.filename) ??
        'srt';
      return { content: buf.toString('utf8'), format, byteLength: buf.length };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Remaining daily download quota, read from a completed download response. */
  static quotaFrom(body: { remaining?: number; reset_time_utc?: string } | null): {
    quotaRemaining: number | null;
    quotaResetAt: Date | null;
  } {
    if (!body) return { quotaRemaining: null, quotaResetAt: null };
    return {
      quotaRemaining: typeof body.remaining === 'number' ? body.remaining : null,
      quotaResetAt: body.reset_time_utc ? new Date(body.reset_time_utc) : null,
    };
  }
}
