/**
 * Podnapisi (podnapisi.net) — via its unofficial but STRUCTURED JSON search
 * (`/subtitles/search/advanced?...&format=json`), not HTML scraping. Results carry
 * a download path to a ZIP, extracted with `zip.ts`.
 *
 * NOTE: unlike OpenSubtitles/SubDL this is not an official API, and the host did
 * not resolve from the build environment — the normalization is unit-verified
 * against Podnapisi's documented JSON shape but has NOT been confirmed against a
 * live response. Downloads are confined to podnapisi.net.
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

const BASE = 'https://www.podnapisi.net';
const HOSTS = new Set(['podnapisi.net', 'www.podnapisi.net']);
const TIMEOUT_MS = 12_000;
const MAX_SUB_BYTES = 3 * 1024 * 1024;

interface PodnapisiEntry {
  id?: string;
  language?: string;
  title?: string;
  year?: number;
  num_of_downloads?: number;
  rating?: number;
  flags?: { hearing_impaired?: boolean; foreign_only?: boolean };
  releases?: string[];
  download?: string;
  url?: string;
}

/** Absolute, host-guarded URL for a Podnapisi relative path, or null. Pure. */
export function resolvePodnapisiUrl(path: string): string | null {
  try {
    const abs = path.startsWith('http') ? path : `${BASE}/${path.replace(/^\/+/, '')}`;
    return HOSTS.has(new URL(abs).host) ? abs : null;
  } catch {
    return null;
  }
}

export class PodnapisiProvider implements SubtitleProvider {
  readonly name = 'podnapisi';
  private readonly logger = new Logger('PodnapisiProvider');

  validateConfiguration(): boolean {
    return true; // no credentials
  }

  getCapabilities(): SubtitleProviderCapabilities {
    return {
      hashSearch: false, releaseSearch: true, imdbSearch: false, tmdbSearch: false,
      tvdbSearch: false, seriesSearch: true, forcedSubtitles: true,
      hearingImpaired: true, machineTranslation: false,
    };
  }
  supportsHashSearch() { return false; }
  supportsReleaseSearch() { return true; }
  supportsImdbSearch() { return false; }
  supportsTmdbSearch() { return false; }
  supportsTvdbSearch() { return false; }
  supportsSeriesSearch() { return true; }
  supportsForcedSubtitles() { return true; }
  supportsHearingImpaired() { return true; }
  supportsMachineTranslation() { return false; }

  private fetch(url: string): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    return fetch(url, {
      headers: { 'User-Agent': SUBTITLE_USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      const res = await this.fetch(`${BASE}/subtitles/search/advanced?keywords=test&format=json`);
      return res.ok ? { healthy: true } : { healthy: false, message: `HTTP ${res.status}` };
    } catch (err) {
      return { healthy: false, message: (err as Error).message };
    }
  }

  /** Map one Podnapisi entry to the normalized shape. Pure — exported for tests. */
  normalizeEntry(e: PodnapisiEntry): NormalizedSubtitle | null {
    if (!e.id && !e.download) return null;
    const download = e.download ?? `/subtitles/${e.id}/download`;
    return {
      provider: this.name,
      providerFileId: e.id ?? download,
      language: (e.language ?? 'und').toLowerCase(),
      releaseName: e.releases?.[0] ?? e.title ?? null,
      filename: e.releases?.[0] ?? null,
      downloads: e.num_of_downloads ?? null,
      rating: e.rating ?? null,
      hearingImpaired: !!e.flags?.hearing_impaired,
      forced: !!e.flags?.foreign_only,
      trustedUploader: false,
      machineTranslated: false,
      downloadUrl: download,
      matchLevel: 2, // release-name based
      rawMetadata: e as Record<string, unknown>,
    };
  }

  async search(query: SubtitleSearchQuery): Promise<NormalizedSubtitle[]> {
    const keywords = query.title ?? query.releaseName;
    if (!keywords) return [];
    const params = new URLSearchParams({ keywords, format: 'json' });
    for (const l of query.languages ?? []) params.append('language', l.toLowerCase());
    if (query.mediaType === 'tv' || query.mediaType === 'anime') params.set('movie_type', 'tv-series');
    else if (query.mediaType === 'movie') params.set('movie_type', 'movie');
    if (query.season != null) params.set('seasons', String(query.season));
    if (query.episode != null) params.set('episodes', String(query.episode));
    if (query.year != null) params.set('year', String(query.year));

    try {
      const res = await this.fetch(`${BASE}/subtitles/search/advanced?${params.toString()}`);
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: PodnapisiEntry[] };
      if (!Array.isArray(body?.data)) return [];
      return body.data
        .map((e) => this.normalizeEntry(e))
        .filter((s): s is NormalizedSubtitle => s !== null);
    } catch (err) {
      this.logger.warn(`search failed: ${(err as Error).message}`);
      return [];
    }
  }

  async download(candidate: NormalizedSubtitle): Promise<DownloadedSubtitle> {
    const raw = candidate.downloadUrl ?? candidate.providerFileId;
    if (!raw) throw new Error('candidate has no download url');
    const url = resolvePodnapisiUrl(raw);
    if (!url) throw new Error(`refusing to fetch Podnapisi subtitle from "${raw}"`);
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`Podnapisi download failed (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());

    let name = candidate.filename ?? 'subtitle.srt';
    let content: Buffer = buf;
    if (looksLikeZip(buf)) {
      const entry = unzipFirstEntry(buf);
      if (!entry) throw new Error('could not extract subtitle from Podnapisi archive');
      name = entry.name;
      content = entry.content;
    }
    if (content.length === 0 || content.length > MAX_SUB_BYTES) {
      throw new Error(`subtitle size out of bounds (${content.length} bytes)`);
    }
    const format = detectSubtitleFormat(name) ?? 'srt';
    return { content: content.toString('utf8'), format, byteLength: content.length };
  }
}
