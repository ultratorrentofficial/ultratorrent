/**
 * Pluggable metadata providers for title/episode enrichment.
 *
 * The renamer works fully offline with LocalProvider (uses parsed names). When
 * a TMDB API key is configured, TmdbProvider enriches movie/series/episode
 * titles. Other sources (TVDB/IMDb/AniDB/MusicBrainz) can be added by
 * implementing this interface — same provider pattern as the torrent engines.
 */
export interface MediaLookup {
  kind: 'tv' | 'anime' | 'movie' | 'music' | 'audiobook' | 'general';
  title: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
}

export interface MediaMetadata {
  seriesTitle?: string;
  movieTitle?: string;
  episodeTitle?: string;
  year?: number;
}

/** A rich, provider-agnostic metadata payload used to enrich a MediaItem. */
export interface MediaMetadataDetails {
  title?: string;
  originalTitle?: string;
  overview?: string;
  releaseDate?: string | null; // ISO date (YYYY-MM-DD)
  year?: number;
  runtime?: number;
  genres?: string[];
  studios?: string[];
  cast?: Array<{ name: string; role?: string }>;
  crew?: Array<{ name: string; job?: string }>;
  directors?: string[];
  writers?: string[];
  rating?: number;
  certification?: string;
  tags?: string[];
  providerName?: string;
  /** provider -> external id (e.g. { tmdb: '603', imdb: 'tt0133093' }). */
  externalIds?: Record<string, string>;
}

export interface MediaMetadataProvider {
  readonly name: string;
  lookup(query: MediaLookup): Promise<MediaMetadata>;
  /** Rich enrichment used by MediaMetadataService. Null when nothing found. */
  fetchDetails(query: MediaLookup): Promise<MediaMetadataDetails | null>;
}

/** Offline provider — returns nothing, so the renamer uses the parsed name. */
export class LocalMetadataProvider implements MediaMetadataProvider {
  readonly name = 'local';
  async lookup(): Promise<MediaMetadata> {
    return {};
  }
  async fetchDetails(): Promise<MediaMetadataDetails | null> {
    return null;
  }
}

/** TMDB (themoviedb.org) v3. Activated only when an API key is present. */
export class TmdbMetadataProvider implements MediaMetadataProvider {
  readonly name = 'tmdb';
  private readonly base = 'https://api.themoviedb.org/3';

  constructor(private readonly apiKey: string) {}

  private async get(path: string, params: Record<string, string>): Promise<any> {
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

  /**
   * Validate the API key with a single lightweight call to TMDB's
   * `/authentication` endpoint. Distinguishes a bad key (401) from an
   * unreachable service (network/timeout) so the UI can say which.
   */
  async verify(): Promise<{ ok: boolean; message: string }> {
    const url = new URL(this.base + '/authentication');
    url.searchParams.set('api_key', this.apiKey);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.ok) return { ok: true, message: 'TMDB API key is valid.' };
      if (res.status === 401)
        return { ok: false, message: 'TMDB rejected the API key (401 Unauthorized).' };
      return { ok: false, message: `TMDB returned an unexpected response (HTTP ${res.status}).` };
    } catch (err) {
      const reason = (err as Error).name === 'AbortError' ? 'request timed out' : (err as Error).message;
      return { ok: false, message: `Could not reach TMDB: ${reason}.` };
    } finally {
      clearTimeout(timer);
    }
  }

  async lookup(q: MediaLookup): Promise<MediaMetadata> {
    try {
      if (q.kind === 'movie') {
        const search = await this.get('/search/movie', {
          query: q.title,
          ...(q.year ? { year: String(q.year) } : {}),
        });
        const hit = search?.results?.[0];
        if (!hit) return {};
        return {
          movieTitle: hit.title,
          year: hit.release_date ? Number(hit.release_date.slice(0, 4)) : q.year ?? undefined,
        };
      }
      // tv / anime
      const search = await this.get('/search/tv', { query: q.title });
      const hit = search?.results?.[0];
      if (!hit) return {};
      const meta: MediaMetadata = {
        seriesTitle: hit.name,
        year: hit.first_air_date ? Number(hit.first_air_date.slice(0, 4)) : undefined,
      };
      if (q.season != null && q.episode != null) {
        const ep = await this.get(`/tv/${hit.id}/season/${q.season}/episode/${q.episode}`, {});
        if (ep?.name) meta.episodeTitle = ep.name;
      }
      return meta;
    } catch {
      return {};
    }
  }

  /** Rich enrichment: overview, genres, cast/crew, ratings, external ids. */
  async fetchDetails(q: MediaLookup): Promise<MediaMetadataDetails | null> {
    try {
      if (q.kind === 'movie') {
        const search = await this.get('/search/movie', {
          query: q.title,
          ...(q.year ? { year: String(q.year) } : {}),
        });
        const hit = search?.results?.[0];
        if (!hit) return null;
        const full = await this.get(`/movie/${hit.id}`, {
          append_to_response: 'credits,release_dates',
        });
        return this.mapMovie(hit, full);
      }
      // tv / anime
      const search = await this.get('/search/tv', { query: q.title });
      const hit = search?.results?.[0];
      if (!hit) return null;
      const full = await this.get(`/tv/${hit.id}`, {
        append_to_response: 'credits,external_ids',
      });
      return this.mapTv(hit, full, q);
    } catch {
      return null;
    }
  }

  private mapMovie(hit: any, full: any): MediaMetadataDetails {
    const credits = full?.credits ?? {};
    const cast = (credits.cast ?? [])
      .slice(0, 20)
      .map((c: any) => ({ name: c.name, role: c.character || undefined }));
    const crew = (credits.crew ?? []).map((c: any) => ({
      name: c.name,
      job: c.job || undefined,
    }));
    const directors = crew.filter((c: any) => c.job === 'Director').map((c: any) => c.name);
    const writers = crew
      .filter((c: any) => c.job === 'Writer' || c.job === 'Screenplay')
      .map((c: any) => c.name);
    const externalIds: Record<string, string> = { tmdb: String(hit.id) };
    if (full?.imdb_id) externalIds.imdb = full.imdb_id;
    return {
      title: full?.title ?? hit.title,
      originalTitle: full?.original_title ?? hit.original_title,
      overview: full?.overview ?? hit.overview,
      releaseDate: full?.release_date || hit.release_date || null,
      year: (full?.release_date || hit.release_date)
        ? Number((full?.release_date || hit.release_date).slice(0, 4))
        : undefined,
      runtime: full?.runtime ?? undefined,
      genres: (full?.genres ?? []).map((g: any) => g.name),
      studios: (full?.production_companies ?? []).map((s: any) => s.name),
      cast,
      crew,
      directors,
      writers,
      rating: hit.vote_average ?? undefined,
      tags: (full?.keywords?.keywords ?? []).map((k: any) => k.name),
      providerName: this.name,
      externalIds,
    };
  }

  private mapTv(hit: any, full: any, q: MediaLookup): MediaMetadataDetails {
    const credits = full?.credits ?? {};
    const cast = (credits.cast ?? [])
      .slice(0, 20)
      .map((c: any) => ({ name: c.name, role: c.character || undefined }));
    const crew = (credits.crew ?? []).map((c: any) => ({
      name: c.name,
      job: c.job || undefined,
    }));
    const externalIds: Record<string, string> = { tmdb: String(hit.id) };
    const ext = full?.external_ids ?? {};
    if (ext.imdb_id) externalIds.imdb = ext.imdb_id;
    if (ext.tvdb_id) externalIds.tvdb = String(ext.tvdb_id);
    const first = full?.first_air_date || hit.first_air_date;
    return {
      title: full?.name ?? hit.name,
      originalTitle: full?.original_name ?? hit.original_name,
      overview: full?.overview ?? hit.overview,
      releaseDate: first || null,
      year: first ? Number(first.slice(0, 4)) : undefined,
      runtime: Array.isArray(full?.episode_run_time)
        ? full.episode_run_time[0]
        : undefined,
      genres: (full?.genres ?? []).map((g: any) => g.name),
      studios: (full?.networks ?? []).map((s: any) => s.name),
      cast,
      crew,
      directors: [],
      writers: [],
      rating: hit.vote_average ?? undefined,
      tags: [],
      providerName: this.name,
      externalIds,
    };
  }
}
