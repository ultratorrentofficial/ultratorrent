/**
 * Pluggable metadata providers for title/episode enrichment.
 *
 * The renamer works fully offline with LocalProvider (uses parsed names). When
 * a TMDB API key is configured, TmdbProvider enriches movie/series/episode
 * titles. Other sources (TVDB/IMDb/AniDB/MusicBrainz) can be added by
 * implementing this interface — same provider pattern as the torrent engines.
 */
import { scoreTitleMatch, titleSimilarity, titlesAreSequelVariants } from './imdb/imdb-match';

/**
 * Minimum title+year confidence to accept a TMDB movie search result as a match.
 *
 * TMDB `/search/movie` ranks by popularity, so a short query title like "Maze"
 * returns the popular "The Maze Runner" first. Taking `results[0]` blindly wrote
 * one film's `imdb`/`tmdb` id onto three different movies ("The Maze Runner" 2014,
 * "Maze" 2017, "The Runner" 2015 all got tt1790864). Every result is now scored on
 * title similarity AND year — the same verification the TV path already does via
 * `ImdbSeriesResolver` — and a weak best is rejected rather than written as a match.
 *
 * Paired with a hard year gate (±1) in `pickBestMovie`, so this only has to
 * separate a same-year near-miss ("The Runner" vs "The Maze Runner" ≈ 0.63, "The
 * King" vs "The Lion King" ≈ 0.69) from a real match ("Maze Runner" vs "The Maze
 * Runner" ≈ 0.79, an exact title = 1.0). 0.7 sits in that gap.
 */
const MOVIE_MATCH_MIN_SCORE = 0.7;

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
  /** Sorting name when it differs from the title ("Matrix, The"). */
  sortTitle?: string;
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
  /**
   * field -> the provider that supplied it. Set only by the Universal scraper,
   * which composes one record from several sources; purely diagnostic, but
   * without it "where did this year come from?" has no answer.
   */
  fieldSources?: Record<string, string>;
}

export interface MediaMetadataProvider {
  readonly name: string;
  lookup(query: MediaLookup): Promise<MediaMetadata>;
  /** Rich enrichment used by MediaMetadataService. Null when nothing found. */
  fetchDetails(query: MediaLookup): Promise<MediaMetadataDetails | null>;
  /**
   * Provider ids that tied for best on a movie query — the films it cannot choose
   * between — or `[]` when the answer was not ambiguous.
   *
   * Optional: a provider that cannot report its ambiguity simply never lets a
   * caller resolve one, which degrades to the safe behaviour (clear the id)
   * rather than to a wrong one.
   */
  ambiguousMovieIds?(query: MediaLookup): Promise<string[]>;
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
        /*
         * Verified, exactly as `fetchDetails` verifies — this half was missed when
         * the Maze Runner fix landed, and `lookup` kept taking `results[0]`.
         *
         * It matters more here than it looks: `lookup`'s answer feeds the RENAMER,
         * where `buildTokens` prefers `meta.year` over the parsed one, so an
         * unverified hit does not merely mislabel a record — it renames a folder.
         * `year` is a hint to TMDB, not a filter (it answers `year=2011` with a 1984
         * film), so the search alone rules nothing out.
         */
        const hit = this.pickBestMovie(search?.results ?? [], q);
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
        // Verify the candidate instead of trusting TMDB's popularity ranking. A
        // wrong-but-popular film scores low on title+year and is rejected here,
        // rather than being written as this movie's id downstream.
        const hit = this.pickBestMovie(search?.results ?? [], q);
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

  /**
   * Choose the TMDB movie result that actually matches the query, or none.
   *
   * Scores every result on title similarity + year agreement (reusing the same
   * `scoreTitleMatch` the manual/IMDb path uses) and returns the best only if it
   * clears {@link MOVIE_MATCH_MIN_SCORE} AND nothing else ties with it. Returning
   * null — no match — is the safe outcome: a movie with no external id is
   * correct-but-incomplete, while a movie with the WRONG id corrupts detection,
   * dedup and every downstream lookup.
   */
  private pickBestMovie(results: any[], q: MediaLookup): any | null {
    const ranked = this.rankMovies(results, q);
    if (!ranked) return null;
    return ranked.tied.length > 1 ? null : ranked.tied[0];
  }

  /**
   * The TMDB ids that tied for best — the films this query cannot choose between.
   *
   * Empty unless the answer was genuinely ambiguous: no candidates, a weak best,
   * and a clean win all return `[]`, because none of them leaves a question open.
   * Exposed so a caller holding an EXISTING id can ask whether that id is one of
   * the candidates, which is evidence `pickBestMovie` does not have — it sees only
   * the query. Repairing a contaminated library needs exactly that: when the
   * stored id is among the tied films, keeping it beats clearing it, and neither
   * is a guess.
   *
   * Deliberately a second search rather than a widened `fetchDetails` return: null
   * means "no usable answer" to every existing caller, and this is the rare path
   * (live, 15 folders of 60), so the repeat costs little and the contract nothing.
   */
  async ambiguousMovieIds(q: MediaLookup): Promise<string[]> {
    try {
      const search = await this.get('/search/movie', {
        query: q.title,
        ...(q.year ? { year: String(q.year) } : {}),
      });
      const ranked = this.rankMovies(search?.results ?? [], q);
      if (!ranked || ranked.tied.length < 2) return [];
      return ranked.tied.map((r) => String(r.id));
    } catch {
      return [];
    }
  }

  /**
   * Score every result and return the best together with everything tied to it.
   *
   * Null when nothing clears {@link MOVIE_MATCH_MIN_SCORE}; otherwise `tied` holds
   * one entry for a clean win and several for an ambiguous one.
   */
  private rankMovies(results: any[], q: MediaLookup): { score: number; tied: any[] } | null {
    let best: { hit: any; score: number; primary: number } | null = null;
    /*
     * The candidates sharing the current best score.
     *
     * Without this the threshold is not actually the last word: `score > best.score`
     * keeps the FIRST of several equal scorers, and TMDB's order is popularity — so
     * a tie is silently broken by the very ranking `pickBestMovie` exists to distrust.
     * Live: `/search/movie?query=Tom&year=2022` returns "Little Man Tom" (whose
     * `original_title` is literally "Tom") ahead of the 2022 film "Tom". Both score
     * 1.00 — one on its original title, one on its primary — and the popular one won.
     *
     * Two films that a title and a year cannot tell apart are not a match, they are a
     * question, so an ambiguous best is rejected like a weak one. It can cost a real
     * match when TMDB holds the same film twice, which is the correct trade: a missing
     * id is repairable by hand, a confidently wrong one is what put three different
     * films under `tt1790864`.
     */
    let tied: any[] = [];
    for (const r of results) {
      const yr = r?.release_date ? Number(String(r.release_date).slice(0, 4)) : null;
      // Hard year gate — the two independent gates the TV path uses: a movie's year
      // is a strong identity signal, so a candidate more than a year off is a
      // DIFFERENT film (Aladdin 1992 vs 2019; "Men" 2022 vs "Men in Black" 1997) and
      // is dropped before scoring, no matter how similar the title. ±1 absorbs a
      // festival-vs-wide-release drift.
      if (q.year != null && yr != null && Math.abs(q.year - yr) > 1) continue;
      // Sequel gate — the year gate cannot separate a film from its same-year
      // sequel ("Ultimate Avengers" vs "Ultimate Avengers 2", both 2006), whose
      // titles differ by only "2" and score ~0.92. If the candidate is the same
      // base title with a different number, it is a different film — drop it.
      const candTitle = r?.title ?? r?.original_title ?? '';
      if (titlesAreSequelVariants(q.title, candTitle)) continue;
      const score = scoreTitleMatch(
        { title: q.title, year: q.year ?? null, type: 'movie' },
        {
          tconst: String(r?.id ?? ''),
          titleType: 'movie',
          primaryTitle: r?.title ?? '',
          originalTitle: r?.original_title ?? '',
          startYear: Number.isFinite(yr) ? (yr as number) : null,
        },
      );
      /*
       * The tiebreak, applied before a tie is declared: how well the candidate's
       * OWN title matches, ignoring the original/AKA titles `scoreTitleMatch`
       * also considers. Those alternates are what recall needs — a folder named
       * for a foreign film's English title has nothing else to match on — but
       * they are weaker evidence, and a film that IS called what you asked for
       * beats one merely known by that name somewhere. It settles "Tom" (2022)
       * in favour of the film titled "Tom" over "Little Man Tom" (original title
       * "Tom"), and the same for "The Wall" over Стена and "Memory" over Memoria.
       */
      const primary = titleSimilarity(q.title, candTitle);
      if (!best || score > best.score || (score === best.score && primary > best.primary)) {
        best = { hit: r, score, primary };
        tied = [r];
      } else if (score === best.score && primary === best.primary) {
        tied.push(r);
      }
    }
    if (!best || best.score < MOVIE_MATCH_MIN_SCORE) return null;
    return { score: best.score, tied };
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
