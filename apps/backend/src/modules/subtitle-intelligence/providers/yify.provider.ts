/**
 * YIFY Subtitles (yifysubtitles.ch) — MOVIE subtitles keyed by IMDb id.
 *
 * ⚠️ SCRAPING PROVIDER. YIFY has no API; this parses the public movie page and
 * downloads the per-subtitle ZIP. It is best-effort by nature — a site redesign
 * can break the parser, and it is movie-only. Verified against the live site at
 * build time. Two live-confirmed quirks are handled:
 *   • the movie page is `/movie-imdb/{imdbId}` and rows carry `data-id` + a
 *     `/subtitles/{slug}` link + a `sub-lang` name;
 *   • the ZIP download 403s WITHOUT a `Referer` to the subtitle detail page — so
 *     we always send it. The body is a real ZIP, extracted with `zip.ts`.
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
import { langNameToCode } from './lang-names';
import { looksLikeZip, unzipFirstEntry } from './zip';

const BASE = 'https://yifysubtitles.ch';
const HOST = 'yifysubtitles.ch';
const TIMEOUT_MS = 12_000;
const MAX_SUB_BYTES = 3 * 1024 * 1024;

export interface YifyRow {
  slug: string;
  language: string; // ISO-639-1 or 'und'
  rating: number | null;
  hearingImpaired: boolean;
}

/** Parse the subtitle rows out of a YIFY movie page. Pure — exported for tests. */
export function parseYifyRows(html: string): YifyRow[] {
  const rows: YifyRow[] = [];
  const rowRe = /<tr[^>]*data-id="\d+"[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const inner = m[1];
    const slug = /href="\/subtitles\/([a-z0-9-]+)"/i.exec(inner)?.[1];
    if (!slug) continue;
    const name = /<span class="sub-lang">([^<]+)<\/span>/i.exec(inner)?.[1]?.trim() ?? '';
    const ratingStr = /rating-cell[^>]*>\s*<span[^>]*>(-?\d+)<\/span>/i.exec(inner)?.[1];
    rows.push({
      slug,
      language: langNameToCode(name),
      rating: ratingStr ? Number(ratingStr) : null,
      hearingImpaired: /hearing[\s-]?impaired|>\s*HI\s*</i.test(inner),
    });
  }
  return rows;
}

/** Build the (host-guarded) ZIP URL + the Referer YIFY requires. Pure. */
export function yifyDownload(slug: string): { url: string; referer: string } {
  return { url: `${BASE}/subtitle/${slug}.zip`, referer: `${BASE}/subtitle/${slug}` };
}

export class YifyProvider implements SubtitleProvider {
  readonly name = 'yify';
  private readonly logger = new Logger('YifyProvider');

  validateConfiguration(): boolean {
    return true; // no credentials
  }

  getCapabilities(): SubtitleProviderCapabilities {
    return {
      hashSearch: false, releaseSearch: false, imdbSearch: true, tmdbSearch: false,
      tvdbSearch: false, seriesSearch: false, forcedSubtitles: false,
      hearingImpaired: true, machineTranslation: false,
    };
  }
  supportsHashSearch() { return false; }
  supportsReleaseSearch() { return false; }
  supportsImdbSearch() { return true; }
  supportsTmdbSearch() { return false; }
  supportsTvdbSearch() { return false; }
  supportsSeriesSearch() { return false; }
  supportsForcedSubtitles() { return false; }
  supportsHearingImpaired() { return true; }
  supportsMachineTranslation() { return false; }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      const res = await this.fetch(`${BASE}/`);
      return res.ok ? { healthy: true } : { healthy: false, message: `HTTP ${res.status}` };
    } catch (err) {
      return { healthy: false, message: (err as Error).message };
    }
  }

  private fetch(url: string, referer?: string): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const headers: Record<string, string> = { 'User-Agent': SUBTITLE_USER_AGENT };
    if (referer) headers.Referer = referer;
    return fetch(url, { headers, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }

  async search(query: SubtitleSearchQuery): Promise<NormalizedSubtitle[]> {
    // Movie-only, IMDb-keyed. No imdb id → nothing to do.
    if (!query.imdbId || query.mediaType === 'tv' || query.mediaType === 'anime') return [];
    const imdb = query.imdbId.startsWith('tt') ? query.imdbId : `tt${query.imdbId}`;
    const wanted = (query.languages ?? []).map((l) => l.toLowerCase());
    try {
      const res = await this.fetch(`${BASE}/movie-imdb/${imdb}`);
      if (!res.ok) return [];
      const rows = parseYifyRows(await res.text());
      return rows
        .filter((r) => r.language !== 'und' && (wanted.length === 0 || wanted.includes(r.language)))
        .map((r) => ({
          provider: this.name,
          providerFileId: r.slug,
          language: r.language,
          releaseName: r.slug,
          filename: `${r.slug}.zip`,
          imdbId: imdb,
          hearingImpaired: r.hearingImpaired,
          forced: false,
          trustedUploader: false,
          machineTranslated: false,
          rating: r.rating,
          downloadUrl: yifyDownload(r.slug).url,
          matchLevel: 3, // keyed by external id (imdb)
          rawMetadata: { slug: r.slug },
        }));
    } catch (err) {
      this.logger.warn(`search failed: ${(err as Error).message}`);
      return [];
    }
  }

  async download(candidate: NormalizedSubtitle): Promise<DownloadedSubtitle> {
    const slug = candidate.providerFileId;
    if (!slug) throw new Error('candidate has no slug');
    const { url, referer } = yifyDownload(slug);
    if (new URL(url).host !== HOST) throw new Error('refusing non-YIFY host');

    const res = await this.fetch(url, referer); // Referer is REQUIRED or YIFY 403s
    if (!res.ok) throw new Error(`YIFY download failed (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!looksLikeZip(buf)) throw new Error('YIFY did not return a ZIP (likely an anti-bot page)');
    const entry = unzipFirstEntry(buf);
    if (!entry) throw new Error('could not extract subtitle from YIFY archive');
    if (entry.content.length === 0 || entry.content.length > MAX_SUB_BYTES) {
      throw new Error(`subtitle size out of bounds (${entry.content.length} bytes)`);
    }
    const format = detectSubtitleFormat(entry.name) ?? 'srt';
    return { content: entry.content.toString('utf8'), format, byteLength: entry.content.length };
  }
}
