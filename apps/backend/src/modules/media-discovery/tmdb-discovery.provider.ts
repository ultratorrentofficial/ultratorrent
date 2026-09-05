import { Logger } from '@nestjs/common';
import type { DiscoveryCapability, ReleaseType } from '@ultratorrent/shared';
import type {
  DiscoveryProviderHealth,
  DiscoveryQuery,
  RawDiscovery,
  RawReleaseDate,
  ReleaseDiscoveryProvider,
} from './discovery-provider';

const BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const TIMEOUT_MS = 10_000;

/** Pages fetched per capability per sync. 20 rows a page — a bounded 100 rows. */
const MAX_PAGES = 5;

/**
 * How many kept films get their typed release dates fetched.
 *
 * One extra call each, so it is capped rather than run over everything a wide
 * window returns. Anything past the cap keeps the primary date it came with,
 * flagged low-confidence — see {@link fetchTypedDates}.
 */
const MAX_DATE_ENRICHMENTS = 40;

/**
 * TMDB's `with_release_type` codes → this codebase's vocabulary.
 *
 * TMDB: 1 Premiere · 2 Theatrical (limited) · 3 Theatrical · 4 Digital ·
 * 5 Physical · 6 TV.
 */
const TMDB_RELEASE_TYPE: Record<number, ReleaseType> = {
  1: 'festival',
  2: 'limited_theatrical',
  3: 'wide_theatrical',
  4: 'digital',
  5: 'physical',
  6: 'streaming',
};
const RELEASE_TYPE_TO_TMDB: Partial<Record<ReleaseType, number>> = Object.fromEntries(
  Object.entries(TMDB_RELEASE_TYPE).map(([code, name]) => [name, Number(code)]),
) as Partial<Record<ReleaseType, number>>;

/**
 * TMDB as a discovery source.
 *
 * Deliberately a SEPARATE class from `TmdbMetadataProvider`. That one answers
 * "what is this file", behind a hardened identity gate that refuses to guess
 * between same-title candidates; this one answers "what is coming out". Merging
 * them would put a bulk catalogue crawl behind a gate built for single-title
 * resolution, and put an identity decision inside a crawl.
 *
 * Two behaviours here exist because the live API was measured rather than
 * assumed:
 *
 *  - **`/movie/upcoming` is not used.** It is popularity-sorted over a loose
 *    window and returned *Avengers: Endgame* (2019-04-26) as the top "upcoming"
 *    film on 2026-09-05. `/discover/movie` with an explicit date window is the
 *    only endpoint that means what it says.
 *  - **The date a row displays is not the date that matched.** `/discover/movie`
 *    filters on TYPED release dates but returns the film's PRIMARY one: a digital
 *    window starting 2026-09-05 returned "Toy Story 5 — 2026-06-17", its
 *    theatrical date. Storing that would record a date the filter never matched,
 *    so typed dates are fetched separately for the rows that are kept.
 */
export class TmdbDiscoveryProvider implements ReleaseDiscoveryProvider {
  readonly name = 'tmdb';
  private readonly logger = new Logger(TmdbDiscoveryProvider.name);
  /** id → name, per media type. Fetched once per process; TMDB changes it rarely. */
  private genreCache: { movie?: Map<number, string>; tv?: Map<number, string> } = {};

  constructor(private readonly apiKey: string) {}

  capabilities(): DiscoveryCapability[] {
    return [
      'upcoming_movies',
      'upcoming_series',
      'returning_series',
      'trending',
      'popular',
      'details',
    ];
  }

  async healthCheck(): Promise<DiscoveryProviderHealth> {
    const started = Date.now();
    try {
      const res = await this.get('/authentication', {});
      return res
        ? { healthy: true, responseMs: Date.now() - started }
        : { healthy: false, message: 'TMDB did not accept the configured key.' };
    } catch {
      return { healthy: false, message: 'TMDB is unreachable.' };
    }
  }

  // --- capabilities --------------------------------------------------------
  async getUpcomingMovies(q: DiscoveryQuery): Promise<RawDiscovery[]> {
    const { from, to } = window(q);
    const params: Record<string, string> = {
      'release_date.gte': from,
      'release_date.lte': to,
      sort_by: 'popularity.desc',
      include_adult: 'false',
    };
    const types = tmdbReleaseTypes(q);
    if (types) params.with_release_type = types;
    if (q.regions?.length) params.region = q.regions[0];
    if (q.languages?.length) params.with_original_language = q.languages.join('|');

    const rows = await this.paged('/discover/movie', params, q.limit);
    const mapped = await Promise.all(rows.map((r) => this.mapMovie(r)));
    const enriched = await this.fetchTypedDates(mapped, rows);
    return this.confirmInWindow(enriched, q, from, to);
  }

  /*
   * Verify the window locally instead of trusting the server-side filter.
   *
   * TMDB evaluates `release_date.gte/lte` and `with_release_type` INDEPENDENTLY
   * unless a region pins them together: a film with any release in the window and
   * any digital release ever satisfies both. Measured live on 2026-09-05 — a
   * 60-day digital query returned *Spider-Man: No Way Home* (2021), whose digital
   * dates are in 2022.
   *
   * So the search narrows and this confirms, the same shape as the movie identity
   * gate: the provider's answer is evidence, not a verdict. A film is kept only
   * when a date we actually fetched, of a type that was actually asked for, falls
   * inside the window.
   *
   * A film past `MAX_DATE_ENRICHMENTS` has no typed dates to confirm, and is
   * DROPPED rather than assumed. That is the safe direction — an unconfirmed film
   * is not announced — and the truncation is logged rather than swallowed, since
   * a silent cap reads as "nothing else qualified".
   */
  private confirmInWindow(
    films: RawDiscovery[],
    q: DiscoveryQuery,
    from: string,
    to: string,
  ): RawDiscovery[] {
    const wanted = new Set(q.releaseTypes ?? []);
    if (wanted.size === 0) return films;

    /*
     * Region matters as much as type.
     *
     * Typed dates are per-country, so without scoping them a five-year-old film
     * qualifies on a single foreign airing: *Spider-Man: No Way Home* (2021) is a
     * legitimate hit for "streaming in the next 60 days" because French TV shows
     * it on 2026-09-06 — correct against the letter of the query, and not what
     * anyone means by discovering upcoming films.
     *
     * An empty region list still means "anywhere", because that is what a
     * template that named no region asked for.
     */
    const regions = new Set((q.regions ?? []).map((r) => r.toUpperCase()));
    const kept = films.filter((f) =>
      (f.releaseDates ?? []).some(
        (d) =>
          wanted.has(d.releaseType) &&
          d.date !== null &&
          d.date >= from &&
          d.date <= to &&
          (regions.size === 0 || (d.region != null && regions.has(d.region.toUpperCase()))),
      ),
    );
    if (films.length > MAX_DATE_ENRICHMENTS) {
      this.logger.warn(
        `TMDB discovery: ${films.length - MAX_DATE_ENRICHMENTS} film(s) past the date-enrichment cap were dropped unconfirmed`,
      );
    }
    return kept;
  }

  async getUpcomingSeries(q: DiscoveryQuery): Promise<RawDiscovery[]> {
    const { from, to } = window(q);
    const params: Record<string, string> = {
      'first_air_date.gte': from,
      'first_air_date.lte': to,
      sort_by: 'popularity.desc',
      include_adult: 'false',
    };
    if (q.languages?.length) params.with_original_language = q.languages.join('|');
    const rows = await this.paged('/discover/tv', params, q.limit);
    return Promise.all(rows.map((r) => this.mapTv(r, 'series_premiere')));
  }

  /**
   * Series already running — "returning", not "new".
   *
   * `/tv/on_the_air` is the endpoint that means this: it returned Reacher and
   * Watch What Happens Live, both long-running. A first-air-date window would
   * exclude exactly these.
   */
  async getReturningSeries(q: DiscoveryQuery): Promise<RawDiscovery[]> {
    const rows = await this.paged('/tv/on_the_air', {}, q.limit);
    return Promise.all(rows.map((r) => this.mapTv(r, 'episode_air')));
  }

  async getTrending(q: DiscoveryQuery): Promise<RawDiscovery[]> {
    const movies = await this.paged('/trending/movie/week', {}, q.limit);
    const tv = await this.paged('/trending/tv/week', {}, q.limit);
    return [
      ...(await Promise.all(movies.map((r) => this.mapMovie(r)))),
      ...(await Promise.all(tv.map((r) => this.mapTv(r, 'unknown')))),
    ];
  }

  async getPopular(q: DiscoveryQuery): Promise<RawDiscovery[]> {
    const movies = await this.paged('/movie/popular', {}, q.limit);
    const tv = await this.paged('/tv/popular', {}, q.limit);
    return [
      ...(await Promise.all(movies.map((r) => this.mapMovie(r)))),
      ...(await Promise.all(tv.map((r) => this.mapTv(r, 'unknown')))),
    ];
  }

  async getDetails(externalId: string): Promise<RawDiscovery | null> {
    const row = await this.get(`/movie/${externalId}`, {});
    return row?.id ? this.mapMovie(row) : null;
  }

  // --- mapping -------------------------------------------------------------
  private async mapMovie(r: any): Promise<RawDiscovery> {
    const date = isoDate(r?.release_date);
    return {
      mediaType: 'movie',
      title: String(r?.title ?? ''),
      originalTitle: r?.original_title ?? null,
      year: date ? Number(date.slice(0, 4)) : null,
      externalIds: { tmdb: String(r?.id) },
      genres: await this.genreNames('movie', r?.genre_ids, r?.genres),
      originalLanguage: r?.original_language ?? null,
      overview: r?.overview || null,
      posterUrl: image(r?.poster_path),
      backdropUrl: image(r?.backdrop_path),
      popularity: num(r?.popularity),
      rating: num(r?.vote_average),
      voteCount: num(r?.vote_count),
      /*
       * The primary date, marked as such and LOW confidence. `/discover` filtered
       * on a typed date this row does not carry, so this is the film's headline
       * date and not necessarily the one the query asked about. `fetchTypedDates`
       * replaces it where it can.
       */
      releaseDates: date ? [{ releaseType: 'unknown', date, confidence: 0.3 }] : [],
    };
  }

  private async mapTv(r: any, releaseType: ReleaseType): Promise<RawDiscovery> {
    const date = isoDate(r?.first_air_date);
    return {
      mediaType: 'tv',
      title: String(r?.name ?? ''),
      originalTitle: r?.original_name ?? null,
      year: date ? Number(date.slice(0, 4)) : null,
      externalIds: { tmdb: String(r?.id) },
      genres: await this.genreNames('tv', r?.genre_ids, r?.genres),
      originalLanguage: r?.original_language ?? null,
      countries: Array.isArray(r?.origin_country) ? r.origin_country.map(String) : [],
      overview: r?.overview || null,
      posterUrl: image(r?.poster_path),
      backdropUrl: image(r?.backdrop_path),
      popularity: num(r?.popularity),
      rating: num(r?.vote_average),
      voteCount: num(r?.vote_count),
      premiereDate: date,
      releaseDates: date ? [{ releaseType, date, confidence: 0.8 }] : [],
    };
  }

  /**
   * Replace the headline date with the film's TYPED dates.
   *
   * Bounded: one call per film, capped. A film past the cap keeps its
   * low-confidence primary date rather than gaining a fabricated typed one —
   * "we did not check" and "it has no digital date" must not look alike.
   */
  private async fetchTypedDates(mapped: RawDiscovery[], rows: any[]): Promise<RawDiscovery[]> {
    for (let i = 0; i < Math.min(mapped.length, MAX_DATE_ENRICHMENTS); i++) {
      const typed = await this.typedDatesFor(rows[i]?.id);
      if (typed.length) mapped[i].releaseDates = typed;
    }
    return mapped;
  }

  private async typedDatesFor(tmdbId: unknown): Promise<RawReleaseDate[]> {
    if (!tmdbId) return [];
    const res = await this.get(`/movie/${tmdbId}/release_dates`, {});
    const out: RawReleaseDate[] = [];
    for (const region of res?.results ?? []) {
      for (const d of region?.release_dates ?? []) {
        const releaseType = TMDB_RELEASE_TYPE[Number(d?.type)];
        const date = isoDate(d?.release_date);
        if (!releaseType || !date) continue;
        out.push({ releaseType, date, region: region.iso_3166_1 ?? null, confidence: 0.9 });
      }
    }
    return out;
  }

  /** Genre ids → names. `/discover` returns ids; `/movie/{id}` returns objects. */
  private async genreNames(kind: 'movie' | 'tv', ids?: unknown, objs?: unknown): Promise<string[]> {
    if (Array.isArray(objs) && objs.length) {
      return objs.map((g: any) => String(g?.name ?? '')).filter(Boolean);
    }
    if (!Array.isArray(ids) || !ids.length) return [];
    const map = await this.genres(kind);
    return ids.map((id: unknown) => map.get(Number(id))).filter((n): n is string => Boolean(n));
  }

  private async genres(kind: 'movie' | 'tv'): Promise<Map<number, string>> {
    const cached = this.genreCache[kind];
    if (cached) return cached;
    const res = await this.get(`/genre/${kind}/list`, {});
    const map = new Map<number, string>(
      (res?.genres ?? []).map((g: any) => [Number(g.id), String(g.name)] as [number, string]),
    );
    // Only cache a real answer — caching an empty map after one failed call would
    // silently strip every genre for the life of the process, and the category
    // policy would then see no categories and quietly ignore everything.
    if (map.size) this.genreCache[kind] = map;
    return map;
  }

  // --- http ----------------------------------------------------------------
  /** Fetch up to `MAX_PAGES` pages, stopping early at the last page or the limit. */
  private async paged(path: string, params: Record<string, string>, limit?: number): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.get(path, { ...params, page: String(page) });
      const rows = res?.results ?? [];
      out.push(...rows);
      if (limit && out.length >= limit) return out.slice(0, limit);
      if (!rows.length || page >= (res?.total_pages ?? 1)) break;
    }
    return limit ? out.slice(0, limit) : out;
  }

  private async get(path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(BASE + path);
    url.searchParams.set('api_key', this.apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        // The url carries the key — log the path and status, never the url.
        this.logger.warn(`TMDB discovery ${path} → ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      this.logger.warn(`TMDB discovery ${path} failed: ${(err as Error).message}`);
      return null;
    }
  }
}

// --- helpers ---------------------------------------------------------------
/** The query's date window as TMDB's `YYYY-MM-DD`, starting today. */
function window(q: DiscoveryQuery): { from: string; to: string } {
  const now = new Date();
  const end = new Date(now.getTime() + Math.max(1, q.windowDays) * 24 * 3600 * 1000);
  return { from: now.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

/** The template's release types as TMDB's `with_release_type` filter, or null. */
function tmdbReleaseTypes(q: DiscoveryQuery): string | null {
  const codes = (q.releaseTypes ?? [])
    .map((t) => RELEASE_TYPE_TO_TMDB[t])
    .filter((c): c is number => typeof c === 'number');
  return codes.length ? [...new Set(codes)].join('|') : null;
}

/** A `YYYY-MM-DD` prefix, or null. Never a fabricated day. */
function isoDate(v: unknown): string | null {
  if (typeof v !== 'string' || v.length < 10) return null;
  const d = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? d : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function image(path: unknown): string | null {
  return typeof path === 'string' && path.startsWith('/') ? `${IMAGE_BASE}/w500${path}` : null;
}
