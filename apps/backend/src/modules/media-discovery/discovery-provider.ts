import type { DiscoveryCapability, ReleaseType } from '@ultratorrent/shared';

/**
 * A source of upcoming/new media.
 *
 * Modelled on {@link MediaMetadataProvider}: a provider declares what it can
 * answer, the registry routes each question to the providers that claim it, and
 * a provider that cannot answer simply is not asked. That is deliberately not
 * the same as returning an empty array — "I do not do this" and "I looked and
 * found nothing" are different facts, and only the first should be invisible.
 *
 * Providers return RAW, PER-PROVIDER records. Merging several providers' views
 * of one title is the registry's job, not a provider's, so that no provider ever
 * has to know another exists.
 *
 * Every method is best-effort over an untrusted network. A provider that throws
 * is marked unhealthy and skipped; it never fails a sync for the others.
 */
export interface ReleaseDiscoveryProvider {
  /** Stable identifier, e.g. `tmdb`. Used as the source key on merged records. */
  readonly name: string;

  /** What this provider actually supports. Only these methods will be called. */
  capabilities(): DiscoveryCapability[];

  /** Cheap liveness probe. Must not throw — report the failure instead. */
  healthCheck(): Promise<DiscoveryProviderHealth>;

  getUpcomingMovies?(query: DiscoveryQuery): Promise<RawDiscovery[]>;
  getUpcomingSeries?(query: DiscoveryQuery): Promise<RawDiscovery[]>;
  getReturningSeries?(query: DiscoveryQuery): Promise<RawDiscovery[]>;
  getUpcomingSeasons?(query: DiscoveryQuery): Promise<RawDiscovery[]>;
  getUpcomingEpisodes?(query: DiscoveryQuery): Promise<RawDiscovery[]>;
  getTrending?(query: DiscoveryQuery): Promise<RawDiscovery[]>;
  getPopular?(query: DiscoveryQuery): Promise<RawDiscovery[]>;
  /** Enrich one already-identified title. */
  getDetails?(externalId: string): Promise<RawDiscovery | null>;
}

/** What the caller is asking for. Providers apply what they can and ignore the rest. */
export interface DiscoveryQuery {
  /** How far ahead to look, in days. */
  windowDays: number;
  /** ISO-3166 alpha-2 regions, when the provider scopes releases regionally. */
  regions?: string[];
  /** ISO-639-1 languages. */
  languages?: string[];
  /**
   * Which release-date semantics the caller cares about, so a provider can push
   * the filter server-side instead of fetching everything and discarding most of
   * it. "Digital or streaming in the next 60 days" is the motivating case.
   */
  releaseTypes?: ReleaseType[];
  /**
   * A ceiling on rows, so one template with a wide window cannot pull thousands
   * of titles through a rate-limited API in a single tick.
   */
  limit?: number;
  /**
   * Opaque cursor/ETag from the last successful sync of this provider+capability,
   * for incremental refresh. Providers that cannot resume ignore it.
   */
  cursor?: string | null;
}

/**
 * One provider's view of one title, before any merging.
 *
 * Everything is optional except the identity minimum, because providers differ
 * wildly in what they publish and a missing field must stay missing rather than
 * being defaulted into a claim nobody made.
 */
export interface RawDiscovery {
  /** movie | tv */
  mediaType: 'movie' | 'tv';
  title: string;
  originalTitle?: string | null;
  year?: number | null;

  /** At least one is required for a title to be trusted. See the identity gate. */
  externalIds: Partial<Record<'tmdb' | 'imdb' | 'tvdb' | 'tvmaze' | 'trakt', string>>;

  genres?: string[];
  originalLanguage?: string | null;
  countries?: string[];
  network?: string | null;
  studio?: string | null;
  streamingService?: string | null;
  overview?: string | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  popularity?: number | null;
  rating?: number | null;
  voteCount?: number | null;

  /** continuing | returning | planned | in_production | ended | canceled | unknown */
  seriesStatus?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  premiereDate?: string | null;
  seasonPremiereDate?: string | null;

  /**
   * Every date this provider knows, typed. A provider that publishes only a year
   * reports `{ date: null }` with the year on the record — it must NOT synthesise
   * a January 1st, which downstream would read as a confirmed day.
   */
  releaseDates?: RawReleaseDate[];
}

export interface RawReleaseDate {
  releaseType: ReleaseType;
  /** ISO-8601 date, or null when the provider knows the type but not the day. */
  date: string | null;
  /**
   * The exact instant the release happens, when the provider states one.
   *
   * Kept apart from `date` because they answer different questions and only one
   * of them can be safely converted to a viewer's timezone. `date` is a calendar
   * date as the provider publishes it; shifting it into another zone moves it a
   * day. `airsAt` is a real point in time and localises correctly.
   */
  airsAt?: string | null;
  region?: string | null;
  /** 0–1, the provider's own certainty. Absent means "stated, not estimated". */
  confidence?: number;
}

export interface DiscoveryProviderHealth {
  healthy: boolean;
  /** Safe to show an operator: never a key, a token or a full request URL. */
  message?: string;
  responseMs?: number;
}
