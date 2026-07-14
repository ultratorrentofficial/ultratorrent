/**
 * TheTVDB (v4) metadata provider.
 *
 * Why TVDB when TMDB already answers: TVDB is the de facto source for *television*
 * and, uniquely among the sources we speak to, it publishes the **episode-ordering
 * schemes** a library actually needs — aired order, DVD order, absolute order —
 * as first-class alternates rather than one canonical numbering. Anime and
 * long-running shows are numbered differently by different releasers, and a
 * provider that only knows aired order cannot reconcile them. (Consuming those
 * orders end-to-end is a later phase; this provider exposes the seam.)
 *
 * Auth: v4 issues a bearer token from an API key (plus a PIN for user-supported
 * subscriber keys), valid for weeks. The token is cached on the instance, so the
 * registry must hold provider instances rather than construct one per call —
 * otherwise every lookup pays for a fresh login.
 *
 * The JSON→details mappers are PURE and exported: they are the part that rots
 * when TVDB changes a field name, and they are tested against captured fixtures
 * with no key and no network.
 */
import type {
  MediaLookup,
  MediaMetadata,
  MediaMetadataDetails,
  MediaMetadataProvider,
} from './metadata-provider';

/** TVDB's episode-numbering schemes. `default` is aired order. */
export type TvdbSeasonType = 'default' | 'official' | 'dvd' | 'absolute' | 'alternate';

const BASE = 'https://api4.thetvdb.com/v4';
const TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Pure mapping. Exported for unit tests — no key, no network.
// ---------------------------------------------------------------------------

/**
 * TVDB reports external ids as `remoteIds: [{ id, type, sourceName }]`, keyed by
 * a human `sourceName` ("IMDB", "TheMovieDB.com", …) rather than a stable slug.
 * Map only the sources we can act on; ignore the social/website rows.
 */
export function mapRemoteIds(remoteIds: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(remoteIds)) return out;
  for (const r of remoteIds) {
    const source = String((r as any)?.sourceName ?? '').toLowerCase();
    const id = (r as any)?.id;
    if (!id) continue;
    if (source.includes('imdb')) out.imdb = String(id);
    else if (source.includes('themoviedb') || source === 'tmdb') out.tmdb = String(id);
  }
  return out;
}

function names(list: unknown, key: string): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => (typeof x === 'string' ? x : ((x as any)?.[key] as string | undefined)))
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

function yearOf(date: unknown): number | undefined {
  const s = typeof date === 'string' ? date : '';
  const y = Number(s.slice(0, 4));
  return Number.isFinite(y) && y > 1800 ? y : undefined;
}

/**
 * Map a TVDB `/series/{id}/extended` (or `/movies/{id}/extended`) payload.
 *
 * Deliberately does NOT map TVDB's `score` to `rating`: that field is a
 * popularity weight in the tens of thousands, not a 0–10 user rating, and
 * writing it into `rating` would poison a column TMDB/IMDb fill correctly.
 */
export function mapTvdbRecord(
  record: any,
  opts: { kind: 'tv' | 'movie'; episode?: any } = { kind: 'tv' },
): MediaMetadataDetails | null {
  if (!record?.id) return null;

  const first = record.firstAired ?? record.first_release?.date ?? null;
  const externalIds: Record<string, string> = {
    tvdb: String(record.id),
    ...mapRemoteIds(record.remoteIds),
  };

  // TVDB models cast as `characters` — one row per role, carrying the actor's
  // name and the character played.
  const characters = Array.isArray(record.characters) ? record.characters : [];
  const cast = characters
    .filter((c: any) => c?.peopleType === 'Actor' || c?.peopleType == null)
    .slice(0, 20)
    .map((c: any) => ({ name: String(c.personName ?? c.name ?? ''), role: c.name || undefined }))
    .filter((c: any) => c.name);
  const directors = characters
    .filter((c: any) => c?.peopleType === 'Director')
    .map((c: any) => String(c.personName ?? ''))
    .filter(Boolean);
  const writers = characters
    .filter((c: any) => c?.peopleType === 'Writer')
    .map((c: any) => String(c.personName ?? ''))
    .filter(Boolean);

  const details: MediaMetadataDetails = {
    title: record.name ?? undefined,
    originalTitle: record.originalName ?? undefined,
    overview: record.overview ?? undefined,
    releaseDate: typeof first === 'string' ? first : null,
    year: yearOf(first) ?? (record.year ? Number(record.year) : undefined),
    runtime: typeof record.averageRuntime === 'number' ? record.averageRuntime : (record.runtime ?? undefined),
    genres: names(record.genres, 'name'),
    studios: [...names(record.networks, 'name'), ...names(record.companies, 'name')].slice(0, 10),
    cast,
    crew: [
      ...directors.map((n: string) => ({ name: n, job: 'Director' })),
      ...writers.map((n: string) => ({ name: n, job: 'Writer' })),
    ],
    directors,
    writers,
    certification: Array.isArray(record.contentRatings)
      ? (record.contentRatings[0]?.name ?? undefined)
      : undefined,
    tags: names(record.tags, 'name'),
    providerName: 'tvdb',
    externalIds,
  };

  // An episode lookup overlays the episode's own title/overview/air date, but
  // keeps the SERIES ids — an episode id in the series' id slot is exactly the
  // poisoning we already had to undo once (see media-metadata.service).
  if (opts.episode?.id) {
    const ep = opts.episode;
    details.title = ep.name ?? details.title;
    details.overview = ep.overview ?? details.overview;
    if (typeof ep.aired === 'string') {
      details.releaseDate = ep.aired;
      details.year = yearOf(ep.aired) ?? details.year;
    }
    if (typeof ep.runtime === 'number') details.runtime = ep.runtime;
  }

  return details;
}

// ---------------------------------------------------------------------------

export class TvdbMetadataProvider implements MediaMetadataProvider {
  readonly name = 'tvdb';
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly apiKey: string,
    private readonly pin?: string,
    /** Which numbering scheme episode lookups use. Aired order by default. */
    private readonly seasonType: TvdbSeasonType = 'default',
  ) {}

  /** Bearer token, cached until it nears expiry (TVDB tokens last ~1 month). */
  private async authToken(): Promise<string | null> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const body: Record<string, string> = { apikey: this.apiKey };
    if (this.pin) body.pin = this.pin;
    const json = await this.request('/login', { method: 'POST', body: JSON.stringify(body) }, false);
    const token = json?.data?.token;
    if (typeof token !== 'string') return null;
    this.token = token;
    // Re-login a day early rather than discover expiry mid-scan.
    this.tokenExpiresAt = Date.now() + 29 * 24 * 60 * 60 * 1000;
    return token;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    authed = true,
  ): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authed) {
      const token = await this.authToken();
      if (!token) return null;
      headers.Authorization = `Bearer ${token}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(BASE + path, { ...init, headers, signal: ctrl.signal });
      if (res.status === 401 && authed) {
        // Token rejected (revoked/expired early) — drop it so the next call re-logs in.
        this.token = null;
        this.tokenExpiresAt = 0;
        return null;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Validate the key by performing a login. Distinguishes a rejected key from an
   * unreachable service so Settings can say which — mirroring the TMDB check.
   */
  async verify(): Promise<{ ok: boolean; message: string }> {
    const body: Record<string, string> = { apikey: this.apiKey };
    if (this.pin) body.pin = this.pin;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.ok) return { ok: true, message: 'TheTVDB API key is valid.' };
      if (res.status === 401)
        return {
          ok: false,
          message:
            'TheTVDB rejected the key (401). A user-supported subscriber key also needs its PIN.',
        };
      return { ok: false, message: `TheTVDB returned an unexpected response (HTTP ${res.status}).` };
    } catch (err) {
      const reason = (err as Error).name === 'AbortError' ? 'request timed out' : (err as Error).message;
      return { ok: false, message: `Could not reach TheTVDB: ${reason}.` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Best search hit for the query, or null. */
  private async search(q: MediaLookup): Promise<any | null> {
    const type = q.kind === 'movie' ? 'movie' : 'series';
    const params = new URLSearchParams({ query: q.title, type });
    if (q.year) params.set('year', String(q.year));
    const json = await this.request(`/search?${params.toString()}`);
    const hit = json?.data?.[0];
    if (!hit) return null;
    // TVDB search returns `tvdb_id` as a string; the record endpoints want the number.
    const id = hit.tvdb_id ?? hit.id;
    return id ? { ...hit, id: String(id).replace(/^(series|movie)-/, '') } : null;
  }

  private async episode(seriesId: string, season: number, episode: number): Promise<any | null> {
    const params = new URLSearchParams({
      season: String(season),
      episodeNumber: String(episode),
    });
    const json = await this.request(
      `/series/${seriesId}/episodes/${this.seasonType}?${params.toString()}`,
    );
    return json?.data?.episodes?.[0] ?? null;
  }

  async lookup(q: MediaLookup): Promise<MediaMetadata> {
    const details = await this.fetchDetails(q);
    if (!details) return {};
    if (q.kind === 'movie') return { movieTitle: details.title, year: details.year };
    // For an episode query fetchDetails() overlays the episode title, so the
    // series title has to come back from the record rather than from `title`.
    const meta: MediaMetadata = { year: details.year };
    if (q.season != null && q.episode != null) {
      meta.episodeTitle = details.title;
      meta.seriesTitle = details.originalTitle ?? undefined;
    } else {
      meta.seriesTitle = details.title;
    }
    return meta;
  }

  async fetchDetails(q: MediaLookup): Promise<MediaMetadataDetails | null> {
    try {
      const hit = await this.search(q);
      if (!hit) return null;

      if (q.kind === 'movie') {
        const full = await this.request(`/movies/${hit.id}/extended`);
        return mapTvdbRecord(full?.data ?? hit, { kind: 'movie' });
      }

      const full = await this.request(`/series/${hit.id}/extended`);
      const record = full?.data ?? hit;
      const ep =
        q.season != null && q.episode != null
          ? await this.episode(String(hit.id), q.season, q.episode)
          : undefined;
      const details = mapTvdbRecord(record, { kind: 'tv', episode: ep });
      // Preserve the series title for callers that need both (see lookup()).
      if (details && ep?.id) details.originalTitle = record?.name ?? details.originalTitle;
      return details;
    } catch {
      return null;
    }
  }
}
