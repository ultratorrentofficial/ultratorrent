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

export interface MediaMetadataProvider {
  readonly name: string;
  lookup(query: MediaLookup): Promise<MediaMetadata>;
}

/** Offline provider — returns nothing, so the renamer uses the parsed name. */
export class LocalMetadataProvider implements MediaMetadataProvider {
  readonly name = 'local';
  async lookup(): Promise<MediaMetadata> {
    return {};
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
}
