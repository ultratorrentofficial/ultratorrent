/**
 * SubDL provider (api.subdl.com v1). Uses the official API with the operator's
 * own key. SubDL serves each subtitle as a ZIP archive, which we extract with the
 * dependency-free reader in `zip.ts` — no unzip binary needed.
 *
 * Like every provider, requests carry a real User-Agent; downloads are confined
 * to SubDL's own hosts (SSRF allow-list).
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
import { looksLikeZip, unzipFirstEntry } from './zip';

const API = 'https://api.subdl.com/api/v1/subtitles';
const DL_HOSTS = new Set(['dl.subdl.com', 'subdl.com', 'www.subdl.com']);
const TIMEOUT_MS = 12_000;
const MAX_SUB_BYTES = 3 * 1024 * 1024;

export interface SubDLConfig {
  apiKey?: string | null;
}

interface SubDLSub {
  release_name?: string;
  name?: string;
  lang?: string;
  language?: string;
  author?: string;
  url?: string;
  season?: number | null;
  episode?: number | null;
  hi?: boolean;
}

/** SubDL download paths are host-relative; resolve against the CDN + guard SSRF. */
export function resolveSubdlUrl(url: string): string | null {
  try {
    const abs = url.startsWith('http') ? url : `https://dl.subdl.com${url.startsWith('/') ? '' : '/'}${url}`;
    return DL_HOSTS.has(new URL(abs).host) ? abs : null;
  } catch {
    return null;
  }
}

export class SubDLProvider implements SubtitleProvider {
  readonly name = 'subdl';
  private readonly logger = new Logger('SubDLProvider');

  constructor(private readonly config: SubDLConfig) {}

  validateConfiguration(): boolean {
    return !!this.config.apiKey;
  }

  getCapabilities(): SubtitleProviderCapabilities {
    return {
      hashSearch: false,
      releaseSearch: true,
      imdbSearch: true,
      tmdbSearch: true,
      tvdbSearch: false,
      seriesSearch: true,
      forcedSubtitles: false,
      hearingImpaired: true,
      machineTranslation: false,
    };
  }
  supportsHashSearch() { return false; }
  supportsReleaseSearch() { return true; }
  supportsImdbSearch() { return true; }
  supportsTmdbSearch() { return true; }
  supportsTvdbSearch() { return false; }
  supportsSeriesSearch() { return true; }
  supportsForcedSubtitles() { return false; }
  supportsHearingImpaired() { return true; }
  supportsMachineTranslation() { return false; }

  private headers(): Record<string, string> {
    return { 'User-Agent': SUBTITLE_USER_AGENT, Accept: 'application/json' };
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.validateConfiguration()) return { healthy: false, message: 'API key not set' };
    try {
      const res = await this.get({ film_name: 'test', languages: 'EN' });
      return res.ok ? { healthy: true } : { healthy: false, message: `SubDL returned HTTP ${res.status}` };
    } catch (err) {
      return { healthy: false, message: (err as Error).message };
    }
  }

  private async get(params: Record<string, string>): Promise<{ ok: boolean; status: number; body: any }> {
    const url = new URL(API);
    url.searchParams.set('api_key', this.config.apiKey ?? '');
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: this.headers(), signal: ctrl.signal });
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* non-JSON */
      }
      return { ok: res.ok, status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Map one SubDL subtitle into the normalized shape. Pure over its input. */
  normalizeResult(s: SubDLSub, query: SubtitleSearchQuery): NormalizedSubtitle | null {
    if (!s.url) return null;
    const lang = (s.language ?? s.lang ?? 'und').toLowerCase();
    return {
      provider: this.name,
      providerFileId: s.url, // the zip path — resolved + guarded at download time
      language: lang,
      releaseName: s.release_name ?? null,
      filename: s.name ?? null,
      movieHash: null,
      imdbId: query.imdbId ?? null,
      tmdbId: query.tmdbId ?? null,
      tvdbId: null,
      season: s.season ?? query.season ?? null,
      episode: s.episode ?? query.episode ?? null,
      runtimeSec: null,
      downloads: null,
      uploader: s.author ?? null,
      rating: null,
      trustedUploader: false,
      machineTranslated: false,
      hearingImpaired: !!s.hi,
      forced: false,
      fileSize: null,
      downloadUrl: s.url,
      rawMetadata: s as Record<string, unknown>,
    };
  }

  async search(query: SubtitleSearchQuery): Promise<NormalizedSubtitle[]> {
    if (!this.validateConfiguration()) return [];
    const params: Record<string, string> = {
      languages: (query.languages ?? []).join(',').toUpperCase(),
      subs_per_page: '30',
    };
    if (query.imdbId) params.imdb_id = query.imdbId;
    else if (query.tmdbId) params.tmdb_id = query.tmdbId;
    else if (query.title) params.film_name = query.title;
    else return [];
    if (query.mediaType) params.type = query.mediaType === 'movie' ? 'movie' : 'tv';
    if (query.season != null) params.season_number = String(query.season);
    if (query.episode != null) params.episode_number = String(query.episode);

    try {
      const { ok, body } = await this.get(params);
      if (!ok || !Array.isArray(body?.subtitles)) return [];
      return (body.subtitles as SubDLSub[])
        .map((s) => this.normalizeResult(s, query))
        .filter((s): s is NormalizedSubtitle => s !== null);
    } catch (err) {
      this.logger.warn(`search failed: ${(err as Error).message}`);
      return [];
    }
  }

  async download(candidate: NormalizedSubtitle): Promise<DownloadedSubtitle> {
    const raw = candidate.downloadUrl ?? candidate.providerFileId;
    if (!raw) throw new Error('candidate has no download url');
    const url = resolveSubdlUrl(raw);
    if (!url) throw new Error(`refusing to fetch SubDL subtitle from "${raw}"`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': SUBTITLE_USER_AGENT }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`SubDL download failed (HTTP ${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());

      // SubDL serves a ZIP; extract the subtitle. A raw (non-zip) body is used as-is.
      let name = candidate.filename ?? 'subtitle.srt';
      let content: Buffer = buf;
      if (looksLikeZip(buf)) {
        const entry = unzipFirstEntry(buf);
        if (!entry) throw new Error('could not extract subtitle from SubDL archive');
        name = entry.name;
        content = entry.content;
      }
      if (content.length === 0 || content.length > MAX_SUB_BYTES) {
        throw new Error(`subtitle size out of bounds (${content.length} bytes)`);
      }
      const format = detectSubtitleFormat(name) ?? detectSubtitleFormat(candidate.filename) ?? 'srt';
      return { content: content.toString('utf8'), format, byteLength: content.length };
    } finally {
      clearTimeout(timer);
    }
  }
}
