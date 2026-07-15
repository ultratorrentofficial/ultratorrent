/**
 * SubtitleCat (subtitlecat.com) — broad, by-title subtitles, many auto-translated.
 *
 * ⚠️ SCRAPING PROVIDER. No API: this parses the search page for result detail
 * links, then each detail page for direct `.srt` download links (SubtitleCat auto-
 * translates, so a detail page exposes several languages, encoded in the filename
 * suffix, e.g. `Movie.en-en-es-419.srt` = an English source machine-translated to
 * es-419). Best-effort by nature; verified against the live site at build time.
 * Downloads are plain `.srt` (no ZIP) and are confined to SubtitleCat's hosts.
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
import { baseLang } from '../jobs/missing-languages';

const BASE = 'https://www.subtitlecat.com';
const HOSTS = new Set(['subtitlecat.com', 'www.subtitlecat.com']);
const TIMEOUT_MS = 12_000;
const MAX_SUB_BYTES = 3 * 1024 * 1024;
const MAX_DETAIL_FETCHES = 4; // bound the search fan-out

/** Absolute, host-guarded URL for a SubtitleCat relative path, or null. Pure. */
export function resolveSubtitleCatUrl(path: string): string | null {
  try {
    const abs = path.startsWith('http') ? path : `${BASE}/${path.replace(/^\/+/, '')}`;
    return HOSTS.has(new URL(abs).host) ? abs : null;
  } catch {
    return null;
  }
}

/** Result detail-page paths from a SubtitleCat search page. Pure. */
export function parseSubtitleCatResults(html: string): string[] {
  const out: string[] = [];
  const re = /href="((?:\/)?subs\/\d+\/[^"]+\.html)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return [...new Set(out)];
}

export interface SubtitleCatLink {
  href: string;
  language: string; // base ISO-639-1
  machineTranslated: boolean;
}

/** Derive language + machine-translated flag from a SubtitleCat `.srt` filename. Pure. */
export function subtitleCatLang(href: string): { language: string; machineTranslated: boolean } {
  const file = decodeURIComponent(href.split('/').pop() ?? '').replace(/\.srt$/i, '');
  const chain = file.split('.').pop() ?? '';
  const parts = chain.split('-').filter(Boolean);
  if (parts.length === 0) return { language: 'und', machineTranslated: false };
  const src = parts[0];
  const target = parts.length >= 3 ? parts.slice(2).join('-') : parts[parts.length - 1];
  return { language: baseLang(target) || 'und', machineTranslated: baseLang(src) !== baseLang(target) };
}

/** Direct `.srt` links on a SubtitleCat detail page. Pure. */
export function parseSubtitleCatSrtLinks(html: string): SubtitleCatLink[] {
  const out: SubtitleCatLink[] = [];
  const re = /href="((?:\/)?subs\/\d+\/[^"]+\.srt)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const { language, machineTranslated } = subtitleCatLang(href);
    out.push({ href, language, machineTranslated });
  }
  return out;
}

export class SubtitleCatProvider implements SubtitleProvider {
  readonly name = 'subtitlecat';
  private readonly logger = new Logger('SubtitleCatProvider');

  validateConfiguration(): boolean {
    return true; // no credentials
  }

  getCapabilities(): SubtitleProviderCapabilities {
    return {
      hashSearch: false, releaseSearch: false, imdbSearch: false, tmdbSearch: false,
      tvdbSearch: false, seriesSearch: true, forcedSubtitles: false,
      hearingImpaired: false, machineTranslation: true,
    };
  }
  supportsHashSearch() { return false; }
  supportsReleaseSearch() { return false; }
  supportsImdbSearch() { return false; }
  supportsTmdbSearch() { return false; }
  supportsTvdbSearch() { return false; }
  supportsSeriesSearch() { return true; }
  supportsForcedSubtitles() { return false; }
  supportsHearingImpaired() { return false; }
  supportsMachineTranslation() { return true; }

  private fetch(url: string): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    return fetch(url, { headers: { 'User-Agent': SUBTITLE_USER_AGENT }, signal: ctrl.signal }).finally(() =>
      clearTimeout(timer),
    );
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      const res = await this.fetch(`${BASE}/index.php?search=test`);
      return res.ok ? { healthy: true } : { healthy: false, message: `HTTP ${res.status}` };
    } catch (err) {
      return { healthy: false, message: (err as Error).message };
    }
  }

  async search(query: SubtitleSearchQuery): Promise<NormalizedSubtitle[]> {
    const title = query.title?.trim();
    if (!title) return [];
    const wanted = (query.languages ?? []).map((l) => baseLang(l));
    const term = query.season != null && query.episode != null
      ? `${title} S${String(query.season).padStart(2, '0')}E${String(query.episode).padStart(2, '0')}`
      : title;
    try {
      const res = await this.fetch(`${BASE}/index.php?search=${encodeURIComponent(term)}`);
      if (!res.ok) return [];
      const results = parseSubtitleCatResults(await res.text()).slice(0, MAX_DETAIL_FETCHES);

      const candidates: NormalizedSubtitle[] = [];
      for (const detailPath of results) {
        const url = resolveSubtitleCatUrl(detailPath);
        if (!url) continue;
        let links: SubtitleCatLink[];
        try {
          const dRes = await this.fetch(url);
          if (!dRes.ok) continue;
          links = parseSubtitleCatSrtLinks(await dRes.text());
        } catch {
          continue;
        }
        const releaseName = decodeURIComponent(detailPath.split('/').pop() ?? '').replace(/\.html$/i, '');
        for (const link of links) {
          if (link.language === 'und') continue;
          if (wanted.length && !wanted.includes(link.language)) continue;
          candidates.push({
            provider: this.name,
            providerFileId: link.href, // the direct .srt path
            language: link.language,
            releaseName,
            filename: decodeURIComponent(link.href.split('/').pop() ?? ''),
            machineTranslated: link.machineTranslated,
            hearingImpaired: false,
            forced: false,
            trustedUploader: false,
            downloadUrl: link.href,
            matchLevel: 4, // title-based
            rawMetadata: { detailPath },
          });
        }
      }
      return candidates;
    } catch (err) {
      this.logger.warn(`search failed: ${(err as Error).message}`);
      return [];
    }
  }

  async download(candidate: NormalizedSubtitle): Promise<DownloadedSubtitle> {
    const raw = candidate.providerFileId ?? candidate.downloadUrl;
    if (!raw) throw new Error('candidate has no srt path');
    const url = resolveSubtitleCatUrl(raw);
    if (!url) throw new Error(`refusing to fetch SubtitleCat subtitle from "${raw}"`);
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`SubtitleCat download failed (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_SUB_BYTES) {
      throw new Error(`subtitle size out of bounds (${buf.length} bytes)`);
    }
    const format = detectSubtitleFormat(url) ?? 'srt';
    return { content: buf.toString('utf8'), format, byteLength: buf.length };
  }
}
