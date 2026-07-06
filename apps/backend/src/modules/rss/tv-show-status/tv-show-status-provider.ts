/**
 * Pluggable TV-show airing-status providers.
 *
 * A provider resolves a show title/id into an airing status and episode dates.
 * The RSS layer never interprets provider-specific status strings itself — each
 * provider (or the shared normalizer below) maps its raw status onto the
 * provider-agnostic `NormalizedShowStatus`, and `recommendationFor` derives the
 * RSS recommendation. New sources (TVDB, OMDb, AniList) implement this same
 * interface — the same pattern as `MediaMetadataProvider`/`ArtworkProvider`.
 */

/** Provider-agnostic airing status. */
export type NormalizedShowStatus =
  | 'continuing'
  | 'returning'
  | 'planned'
  | 'on_hiatus'
  | 'ended'
  | 'canceled'
  | 'unknown';

/** RSS monitoring recommendation derived from the normalized status. */
export type Recommendation = 'recommended' | 'caution' | 'not_recommended' | 'unknown';

export interface ProviderCapabilities {
  name: string;
  canSearch: boolean;
  canStatus: boolean;
  canNextEpisode: boolean;
  canLastEpisode: boolean;
  /** Baseline confidence (0..1) of this provider's status answers. */
  confidence: number;
}

export interface ShowSearchHit {
  providerShowId: string;
  title: string;
  year: number | null;
}

export interface EpisodeRef {
  airDate: string | null; // ISO YYYY-MM-DD
  title: string | null;
}

export interface ShowDetails {
  providerShowId: string;
  title: string;
  originalStatus: string | null;
  firstAirDate: string | null;
  lastAirDate: string | null;
  nextEpisode: EpisodeRef | null;
  lastEpisode: EpisodeRef | null;
  totalSeasons: number | null;
  totalEpisodes: number | null;
  overview: string | null;
  posterUrl: string | null;
  /** Extra normalizer signals a provider can surface (e.g. IMDb endYear). */
  endYear?: number | null;
  assumeContinuing?: boolean;
}

export interface TvShowStatusProvider {
  readonly name: string;
  getProviderCapabilities(): ProviderCapabilities;
  searchShow(query: string, year?: number | null): Promise<ShowSearchHit[]>;
  getShowStatus(externalId: string): Promise<string | null>;
  getShowDetails(externalId: string): Promise<ShowDetails | null>;
  getNextEpisode(externalId: string): Promise<EpisodeRef | null>;
  getLastEpisode(externalId: string): Promise<EpisodeRef | null>;
}

/** The provider-agnostic result surfaced to the RSS flow + API + rule snapshot. */
export interface ShowStatusResult {
  title: string;
  normalizedTitle: string;
  provider: string;
  providerShowId: string | null;
  originalStatus: string | null;
  normalizedStatus: NormalizedShowStatus;
  recommendation: Recommendation;
  confidence: number;
  firstAirDate: string | null;
  lastAirDate: string | null;
  nextEpisodeAirDate: string | null;
  lastEpisodeTitle: string | null;
  nextEpisodeTitle: string | null;
  totalSeasons: number | null;
  totalEpisodes: number | null;
  overview: string | null;
  posterUrl: string | null;
  warnings: string[];
}

// --- pure helpers (unit-tested; no provider-specific rules leak into RSS) ----

/** Loose, comparison-friendly title key. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STALE_MS = 183 * 24 * 60 * 60 * 1000; // ~6 months

function airedLongAgo(lastAirDate: string | null | undefined, now: Date): boolean {
  if (!lastAirDate) return false;
  const d = new Date(lastAirDate);
  if (Number.isNaN(d.getTime())) return false;
  return now.getTime() - d.getTime() > STALE_MS;
}

/**
 * Map a provider's raw status (+ signals) onto a `NormalizedShowStatus`.
 * Textual status (TMDB) wins; otherwise fall back to IMDb-style `endYear`
 * (`assumeContinuing` marks a known running series with no end year).
 * Hiatus heuristic: a returning show with no scheduled next episode whose last
 * episode aired more than ~6 months ago is treated as `on_hiatus`.
 */
export function normalizeShowStatus(input: {
  providerStatus?: string | null;
  endYear?: number | null;
  hasFutureEpisode?: boolean;
  lastAirDate?: string | null;
  assumeContinuing?: boolean;
  now?: Date;
}): NormalizedShowStatus {
  const now = input.now ?? new Date();
  const raw = (input.providerStatus ?? '').trim().toLowerCase();
  if (raw) {
    if (raw === 'returning series' || raw === 'returning' || raw === 'continuing') {
      if (!input.hasFutureEpisode && airedLongAgo(input.lastAirDate, now)) return 'on_hiatus';
      return 'returning';
    }
    if (raw === 'ended') return 'ended';
    if (raw === 'canceled' || raw === 'cancelled') return 'canceled';
    if (raw === 'in production' || raw === 'planned' || raw === 'pilot') return 'planned';
  }
  if (input.endYear != null) return 'ended';
  if (input.assumeContinuing) return 'continuing';
  return 'unknown';
}

/** Derive the RSS monitoring recommendation from a normalized status. */
export function recommendationFor(status: NormalizedShowStatus): Recommendation {
  switch (status) {
    case 'continuing':
    case 'returning':
    case 'planned':
      return 'recommended';
    case 'on_hiatus':
      return 'caution';
    case 'ended':
    case 'canceled':
      return 'not_recommended';
    default:
      return 'unknown';
  }
}

/** True when a normalized status means the show is no longer producing episodes. */
export function isInactiveStatus(status: NormalizedShowStatus): boolean {
  return status === 'ended' || status === 'canceled';
}

/** Media types that are TV-shaped and therefore get an airing-status check. */
export const TV_MEDIA_TYPES = new Set(['tv', 'anime', 'episode', 'series']);
