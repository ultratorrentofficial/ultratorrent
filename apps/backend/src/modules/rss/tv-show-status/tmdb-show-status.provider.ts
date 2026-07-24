import type {
  EpisodeRef,
  ProviderCapabilities,
  ShowDetails,
  ShowSearchHit,
  TvShowStatusProvider,
} from './tv-show-status-provider';

/**
 * TMDB (themoviedb.org) v3 airing-status provider — the richest source: exposes
 * a textual `status`, `next_episode_to_air`, and `last_episode_to_air`. Activated
 * only when an API key is present. Mirrors the `get()` helper in
 * `media/metadata-provider.ts`.
 */
export class TmdbTvShowStatusProvider implements TvShowStatusProvider {
  readonly name = 'tmdb';
  private readonly base = 'https://api.themoviedb.org/3';
  private readonly imageBase = 'https://image.tmdb.org/t/p/w342';

  constructor(private readonly apiKey: string) {}

  getProviderCapabilities(): ProviderCapabilities {
    return {
      name: this.name,
      canSearch: true,
      canStatus: true,
      canNextEpisode: true,
      canLastEpisode: true,
      confidence: 0.95,
    };
  }

  private async get(path: string, params: Record<string, string> = {}): Promise<any> {
    const url = new URL(this.base + path);
    url.searchParams.set('api_key', this.apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async searchShow(query: string, year?: number | null): Promise<ShowSearchHit[]> {
    const data = await this.get('/search/tv', {
      query,
      ...(year ? { first_air_date_year: String(year) } : {}),
    });
    const results: any[] = data?.results ?? [];
    return results.map((r) => ({
      providerShowId: String(r.id),
      title: r.name ?? r.original_name ?? query,
      year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) || null : null,
    }));
  }

  async getShowStatus(externalId: string): Promise<string | null> {
    const d = await this.get(`/tv/${externalId}`);
    return d?.status ?? null;
  }

  async getShowDetails(externalId: string): Promise<ShowDetails | null> {
    const d = await this.get(`/tv/${externalId}`);
    if (!d) return null;
    const ep = (e: any): EpisodeRef | null =>
      e ? { airDate: e.air_date ?? null, title: e.name ?? null } : null;
    return {
      providerShowId: String(d.id),
      title: d.name ?? d.original_name ?? '',
      originalStatus: d.status ?? null,
      firstAirDate: d.first_air_date || null,
      lastAirDate: d.last_air_date || null,
      nextEpisode: ep(d.next_episode_to_air),
      lastEpisode: ep(d.last_episode_to_air),
      totalSeasons: d.number_of_seasons ?? null,
      totalEpisodes: d.number_of_episodes ?? null,
      overview: d.overview || null,
      posterUrl: d.poster_path ? `${this.imageBase}${d.poster_path}` : null,
    };
  }

  /**
   * The aired boundary for a series identified by its IMDb id: the (season, episode)
   * of the most recently aired episode across the whole show. Everything at or before
   * it (season-major, episode-minor) has aired; everything after has not.
   *
   * This is what lets the missing-episode diff tell an *announced-but-unreleased*
   * season from a genuinely missing one when the catalogue (IMDb) already lists the
   * future season but no per-episode air date exists yet. Observed on *Ahsoka*: IMDb
   * lists eight season-2 episodes stamped with the current year, TMDB has no season 2
   * at all, but `last_episode_to_air` is S1E8 — so season 2 is provably unaired.
   *
   * Resolves the IMDb id to a TMDB show via `/find` (exact, not a title guess), then
   * reads `last_episode_to_air`. Null when the key/id can't resolve or nothing has
   * aired yet (a brand-new show) — the caller then falls back to year granularity.
   */
  async getAiredBoundaryByImdb(
    imdbId: string,
  ): Promise<{ seasonNumber: number; episodeNumber: number } | null> {
    const found = await this.get(`/find/${imdbId}`, { external_source: 'imdb_id' });
    const tvId = found?.tv_results?.[0]?.id;
    if (tvId == null) return null;
    const d = await this.get(`/tv/${tvId}`);
    const e = d?.last_episode_to_air;
    if (!e || e.season_number == null || e.episode_number == null) return null;
    return { seasonNumber: Number(e.season_number), episodeNumber: Number(e.episode_number) };
  }

  async getNextEpisode(externalId: string): Promise<EpisodeRef | null> {
    return (await this.getShowDetails(externalId))?.nextEpisode ?? null;
  }

  async getLastEpisode(externalId: string): Promise<EpisodeRef | null> {
    return (await this.getShowDetails(externalId))?.lastEpisode ?? null;
  }
}
