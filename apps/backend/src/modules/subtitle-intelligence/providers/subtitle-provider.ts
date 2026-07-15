/**
 * Subtitle provider abstraction. Business logic (search strategy, scoring,
 * validation, install) depends ONLY on this interface — never on a concrete
 * provider — so OpenSubtitles, SubDL, a local repository, and future providers
 * (Addic7ed, Podnapisi, …) all drop in without touching the engine.
 *
 * A provider's job is narrow: turn a search request into NORMALIZED candidates
 * (metadata + a way to fetch the bytes), and hand back the raw subtitle bytes on
 * download. It never writes to disk, never scores, never validates — those belong
 * to the engine so every provider shares one implementation.
 */

/** What a media file looks like to a provider — its search identity. */
export interface SubtitleSearchQuery {
  /** ISO-639-1 languages to search for (e.g. ['en','es']). */
  languages: string[];
  /** OpenSubtitles movie hash (first+last 64KB + filesize), when computed. */
  movieHash?: string | null;
  fileSize?: number | null;
  /** Release/file name to release-match against. */
  releaseName?: string | null;
  releaseGroup?: string | null;
  title?: string | null;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  imdbId?: string | null;
  tmdbId?: string | null;
  tvdbId?: string | null;
  runtimeSec?: number | null;
  mediaType?: 'movie' | 'tv' | 'anime' | null;
  /** Include hearing-impaired results. */
  hearingImpaired?: boolean;
  /** Include forced-only tracks. */
  forced?: boolean;
}

/**
 * The single shape every provider result normalizes into. `providerFileId` +
 * `downloadUrl` are the two ways to later fetch the bytes; a provider populates
 * whichever it uses. `matchLevel` records HOW the provider matched (1 hash → 4
 * title) and feeds the scoring engine.
 */
export interface NormalizedSubtitle {
  provider: string;
  providerFileId?: string | null;
  language: string;
  releaseName?: string | null;
  filename?: string | null;
  movieHash?: string | null;
  imdbId?: string | null;
  tmdbId?: string | null;
  tvdbId?: string | null;
  season?: number | null;
  episode?: number | null;
  runtimeSec?: number | null;
  downloads?: number | null;
  uploader?: string | null;
  rating?: number | null;
  trustedUploader?: boolean;
  machineTranslated?: boolean;
  hearingImpaired?: boolean;
  forced?: boolean;
  fileSize?: number | null;
  downloadUrl?: string | null;
  /** 1 = exact hash · 2 = release · 3 = external id · 4 = title. */
  matchLevel?: number;
  /** The provider's untouched payload, kept for debugging + future re-scoring. */
  rawMetadata?: Record<string, unknown> | null;
}

/** The bytes a download resolves to, plus the format we detected. */
export interface DownloadedSubtitle {
  /** Decoded UTF-8 text of the subtitle. */
  content: string;
  /** Lower-case extension WITHOUT the dot: srt | ass | ssa | vtt | sub. */
  format: string;
  /** Bytes actually fetched (pre-decode). */
  byteLength: number;
}

/** Static declaration of what a provider can do — drives UI + strategy skips. */
export interface SubtitleProviderCapabilities {
  hashSearch: boolean;
  releaseSearch: boolean;
  imdbSearch: boolean;
  tmdbSearch: boolean;
  tvdbSearch: boolean;
  seriesSearch: boolean;
  forcedSubtitles: boolean;
  hearingImpaired: boolean;
  machineTranslation: boolean;
}

export interface ProviderHealth {
  healthy: boolean;
  message?: string;
  /** Remaining daily download quota, when the provider exposes one. */
  quotaRemaining?: number | null;
  quotaResetAt?: Date | null;
}

/**
 * The provider contract. Concrete providers implement this; the registry builds
 * the enabled set from stored config. Methods are intentionally granular so the
 * search strategy can skip a level a provider does not support
 * (`supportsHashSearch()` etc.) rather than issue a doomed request.
 */
export interface SubtitleProvider {
  readonly name: string;

  /** True once configured well enough to be queried (e.g. credentials present). */
  validateConfiguration(): boolean;
  /** Cheap liveness + quota probe; never throws (returns unhealthy instead). */
  healthCheck(): Promise<ProviderHealth>;

  getCapabilities(): SubtitleProviderCapabilities;
  supportsHashSearch(): boolean;
  supportsReleaseSearch(): boolean;
  supportsImdbSearch(): boolean;
  supportsTmdbSearch(): boolean;
  supportsTvdbSearch(): boolean;
  supportsSeriesSearch(): boolean;
  supportsForcedSubtitles(): boolean;
  supportsHearingImpaired(): boolean;
  supportsMachineTranslation(): boolean;

  /** Run one search; return normalized candidates (may be empty, never throws). */
  search(query: SubtitleSearchQuery): Promise<NormalizedSubtitle[]>;

  /** Fetch the bytes for a chosen candidate. Throws on hard failure. */
  download(candidate: NormalizedSubtitle): Promise<DownloadedSubtitle>;
}

/** Known subtitle file extensions (no dot), the only formats we install. */
export const SUBTITLE_FORMATS = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub']);

/**
 * A shared UA sent on EVERY provider HTTP call. OpenSubtitles (and any
 * Cloudflare-fronted host) reject a UA-less `fetch` outright — the exact trap the
 * Trakt integration hit, where a missing UA read as "invalid client". Never send
 * a provider request without this.
 */
export const SUBTITLE_USER_AGENT = 'UltraTorrent/1.0 (+subtitle-intelligence)';

/**
 * Infer the subtitle format from a filename or URL. Returns a value in
 * SUBTITLE_FORMATS, or null when it is not a subtitle we handle. Pure.
 */
export function detectSubtitleFormat(nameOrUrl: string | null | undefined): string | null {
  if (!nameOrUrl) return null;
  const clean = nameOrUrl.split('?')[0].split('#')[0];
  const m = /\.([a-z0-9]{2,4})$/i.exec(clean);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return SUBTITLE_FORMATS.has(ext) ? ext : null;
}
