import type { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import type { MediaMetadataDetails } from '../metadata-provider';
import type { ImdbSettings } from './imdb-settings.service';
import {
  CandidateTitle,
  ImdbTitleKind,
  isTvType,
  scoreTitleMatch,
  titleTypeMatchesKind,
} from './imdb-match';

/** A single scored search hit. */
export interface ImdbSearchResult {
  tconst: string;
  titleType: string;
  primaryTitle: string;
  originalTitle: string;
  year: number | null;
  isAdult: boolean;
  genres: string[];
  rating: number | null;
  numVotes: number | null;
  /** 0..1 confidence this hit matches the query. */
  confidence: number;
}

export interface ImdbSearchQuery {
  title: string;
  year?: number | null;
  type?: ImdbTitleKind;
  season?: number | null;
  episode?: number | null;
}

export interface ImdbRatingInfo {
  tconst: string;
  averageRating: number;
  numVotes: number;
}

export interface ImdbCredits {
  directors: string[];
  writers: string[];
  cast: Array<{ name: string; role?: string; category?: string }>;
}

export interface ProviderCapabilities {
  source: 'disabled' | 'dataset' | 'official_api' | 'hybrid';
  available: boolean;
  methods: {
    searchTitle: boolean;
    getTitleById: boolean;
    getMovieMetadata: boolean;
    getTvShowMetadata: boolean;
    getEpisodeMetadata: boolean;
    getCredits: boolean;
    getRatings: boolean;
    getExternalIds: boolean;
  };
}

export interface HealthResult {
  source: ProviderCapabilities['source'];
  available: boolean;
  datasetTitleCount?: number;
  apiConfigured?: boolean;
  detail?: string;
}

/** Minimum candidate pool pulled from the DB before scoring/ranking. */
const CANDIDATE_POOL = 60;
const DEFAULT_LIMIT = 20;

/**
 * The IMDb MediaMetadataProvider. Data comes ONLY from:
 *   (a) the imported IMDb TSV datasets (the IMDb* tables), and/or
 *   (b) an OPTIONAL configured official/licensed IMDb REST API (generic base URL
 *       + key) supplied entirely via settings.
 *
 * There is NO scraping of imdb.com pages, no browser automation, and no request
 * to any imdb.com URL. In `hybrid` mode the dataset is queried first and the
 * configured API only fills gaps. IMDb ids are used as external ids / links.
 */
export class ImdbMetadataProvider {
  readonly name = 'imdb';

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: ImdbSettings,
  ) {}

  private get datasetEnabled(): boolean {
    return this.settings.mode === 'dataset' || this.settings.mode === 'hybrid';
  }

  private get apiEnabled(): boolean {
    return (
      (this.settings.mode === 'official_api' || this.settings.mode === 'hybrid') &&
      Boolean(this.settings.apiBaseUrl && this.settings.apiKey)
    );
  }

  providerCapabilities(): ProviderCapabilities {
    const source = this.settings.mode;
    const available = this.datasetEnabled || this.apiEnabled;
    return {
      source,
      available,
      methods: {
        searchTitle: available,
        getTitleById: available,
        getMovieMetadata: available,
        getTvShowMetadata: available,
        getEpisodeMetadata: available,
        getCredits: available,
        getRatings: available,
        getExternalIds: available,
      },
    };
  }

  async healthCheck(): Promise<HealthResult> {
    const source = this.settings.mode;
    if (source === 'disabled') {
      return { source, available: false, detail: 'IMDb provider disabled.' };
    }
    let datasetTitleCount: number | undefined;
    if (this.datasetEnabled) {
      datasetTitleCount = await this.prisma.iMDbTitle.count();
    }
    const apiConfigured = Boolean(this.settings.apiBaseUrl && this.settings.apiKey);
    const available =
      (this.datasetEnabled && (datasetTitleCount ?? 0) > 0) || this.apiEnabled;
    return {
      source,
      available,
      datasetTitleCount,
      apiConfigured,
      detail: available
        ? 'IMDb provider ready.'
        : this.datasetEnabled
          ? 'No dataset imported yet.'
          : 'No API credentials configured.',
    };
  }

  // --- search --------------------------------------------------------------

  async searchTitle(
    query: ImdbSearchQuery,
    limit = DEFAULT_LIMIT,
  ): Promise<ImdbSearchResult[]> {
    if (this.datasetEnabled) {
      const fromDataset = await this.searchDataset(query, limit);
      if (fromDataset.length > 0 || !this.apiEnabled) return fromDataset;
    }
    if (this.apiEnabled) {
      return this.searchApi(query, limit);
    }
    return [];
  }

  private async searchDataset(
    query: ImdbSearchQuery,
    limit: number,
  ): Promise<ImdbSearchResult[]> {
    const kind = query.type ?? 'any';
    const q = query.title?.trim();
    if (!q) return [];

    const where: any = {
      OR: [
        { primaryTitle: { contains: q, mode: 'insensitive' } },
        { originalTitle: { contains: q, mode: 'insensitive' } },
      ],
    };
    if (!this.settings.includeAdult) where.isAdult = false;
    if (query.year != null) {
      where.startYear = { in: [query.year, query.year - 1, query.year + 1] };
    }

    const direct = await this.prisma.iMDbTitle.findMany({
      where,
      take: CANDIDATE_POOL,
    });

    // AKA recall: titles whose alternate names match the query.
    const akaHits = await this.prisma.iMDbAka.findMany({
      where: { title: { contains: q, mode: 'insensitive' } },
      take: CANDIDATE_POOL,
    });
    const akaByTitle = new Map<string, string[]>();
    const missingIds: string[] = [];
    const directIds = new Set(direct.map((t) => t.tconst));
    for (const aka of akaHits) {
      const list = akaByTitle.get(aka.titleId) ?? [];
      list.push(aka.title);
      akaByTitle.set(aka.titleId, list);
      if (!directIds.has(aka.titleId)) missingIds.push(aka.titleId);
    }
    const extra = missingIds.length
      ? await this.prisma.iMDbTitle.findMany({
          where: {
            tconst: { in: Array.from(new Set(missingIds)).slice(0, CANDIDATE_POOL) },
            ...(this.settings.includeAdult ? {} : { isAdult: false }),
          },
        })
      : [];

    const candidates = [...direct, ...extra];
    if (candidates.length === 0) return [];

    // Ratings for votes filtering + display.
    const ratings = await this.prisma.iMDbRating.findMany({
      where: { titleId: { in: candidates.map((c) => c.tconst) } },
    });
    const ratingByTconst = new Map(ratings.map((r) => [r.titleId, r]));

    const results: ImdbSearchResult[] = [];
    for (const c of candidates) {
      if (!this.settings.includeAdult && c.isAdult) continue;
      if (kind !== 'any' && !titleTypeMatchesKind(c.titleType, kind)) continue;
      const rating = ratingByTconst.get(c.tconst);
      const numVotes = rating?.numVotes ?? 0;
      if (this.settings.minVotes > 0 && numVotes < this.settings.minVotes) continue;

      const candidate: CandidateTitle = {
        tconst: c.tconst,
        titleType: c.titleType,
        primaryTitle: c.primaryTitle,
        originalTitle: c.originalTitle,
        startYear: c.startYear,
        akas: akaByTitle.get(c.tconst),
      };
      results.push({
        tconst: c.tconst,
        titleType: c.titleType,
        primaryTitle: c.primaryTitle,
        originalTitle: c.originalTitle,
        year: c.startYear,
        isAdult: c.isAdult,
        genres: c.genres,
        rating: rating?.averageRating ?? null,
        numVotes: rating?.numVotes ?? null,
        confidence: scoreTitleMatch(
          { title: query.title, year: query.year, type: kind },
          candidate,
        ),
      });
    }

    // Release-name ranking (see scoreTitleMatch for the title/year signal):
    //   1. title + year confidence — the primary/original/AKA match, with an
    //      exact-year match strongly preferred;
    //   2. vote count — popularity breaks ties between equally-confident titles;
    //   3. average rating — only once title/year confidence AND popularity agree,
    //      so a better-rated but less-relevant title never outranks the real one.
    results.sort(
      (a, b) =>
        b.confidence - a.confidence ||
        (b.numVotes ?? 0) - (a.numVotes ?? 0) ||
        (b.rating ?? 0) - (a.rating ?? 0),
    );
    return results.slice(0, limit);
  }

  // --- by-id lookups -------------------------------------------------------

  async getTitleById(tconst: string): Promise<MediaMetadataDetails | null> {
    if (this.datasetEnabled) {
      const details = await this.getTitleFromDataset(tconst);
      if (details) return details;
    }
    if (this.apiEnabled) {
      return this.getTitleFromApi(tconst);
    }
    return null;
  }

  private async getTitleFromDataset(
    tconst: string,
  ): Promise<MediaMetadataDetails | null> {
    const title = await this.prisma.iMDbTitle.findUnique({ where: { tconst } });
    if (!title) return null;
    const [rating, crew] = await Promise.all([
      this.prisma.iMDbRating.findUnique({ where: { titleId: tconst } }),
      this.prisma.iMDbCrew.findUnique({ where: { titleId: tconst } }),
    ]);
    const directorNames = await this.resolveNames(crew?.directors ?? []);
    const writerNames = await this.resolveNames(crew?.writers ?? []);
    return {
      title: title.primaryTitle,
      originalTitle: title.originalTitle,
      year: title.startYear ?? undefined,
      runtime: title.runtimeMinutes ?? undefined,
      genres: title.genres,
      directors: directorNames,
      writers: writerNames,
      rating: rating?.averageRating ?? undefined,
      providerName: this.name,
      externalIds: { imdb: tconst },
    };
  }

  async getMovieMetadata(tconst: string): Promise<MediaMetadataDetails | null> {
    return this.getTitleById(tconst);
  }

  async getTvShowMetadata(tconst: string): Promise<MediaMetadataDetails | null> {
    return this.getTitleById(tconst);
  }

  async getEpisodeMetadata(
    ref: string | { parentTitleId: string; season: number; episode: number },
  ): Promise<MediaMetadataDetails | null> {
    if (!this.datasetEnabled) {
      return typeof ref === 'string' && this.apiEnabled
        ? this.getTitleFromApi(ref)
        : null;
    }
    let episodeTconst: string | null = null;
    if (typeof ref === 'string') {
      episodeTconst = ref;
    } else {
      const ep = await this.prisma.iMDbEpisode.findFirst({
        where: {
          parentTitleId: ref.parentTitleId,
          seasonNumber: ref.season,
          episodeNumber: ref.episode,
        },
      });
      episodeTconst = ep?.episodeTitleId ?? null;
    }
    if (!episodeTconst) return null;
    const details = await this.getTitleFromDataset(episodeTconst);
    if (!details) return null;
    const ep = await this.prisma.iMDbEpisode.findUnique({
      where: { episodeTitleId: episodeTconst },
    });
    if (ep) {
      (details as any).season = ep.seasonNumber ?? undefined;
      (details as any).episode = ep.episodeNumber ?? undefined;
    }
    return details;
  }

  async getCredits(tconst: string): Promise<ImdbCredits> {
    if (!this.datasetEnabled) return { directors: [], writers: [], cast: [] };
    const [crew, principals] = await Promise.all([
      this.prisma.iMDbCrew.findUnique({ where: { titleId: tconst } }),
      this.prisma.iMDbPrincipal.findMany({
        where: { titleId: tconst },
        orderBy: { ordering: 'asc' },
        take: 30,
      }),
    ]);
    const [directors, writers] = await Promise.all([
      this.resolveNames(crew?.directors ?? []),
      this.resolveNames(crew?.writers ?? []),
    ]);
    const persons = await this.prisma.iMDbPerson.findMany({
      where: { nconst: { in: principals.map((p) => p.personId) } },
    });
    const nameById = new Map(persons.map((p) => [p.nconst, p.primaryName]));
    const cast = principals.map((p) => ({
      name: nameById.get(p.personId) ?? p.personId,
      role: parseCharacters(p.characters),
      category: p.category ?? undefined,
    }));
    return { directors, writers, cast };
  }

  async getRatings(tconst: string): Promise<ImdbRatingInfo | null> {
    if (this.datasetEnabled) {
      const r = await this.prisma.iMDbRating.findUnique({ where: { titleId: tconst } });
      if (r) return { tconst, averageRating: r.averageRating, numVotes: r.numVotes };
    }
    if (this.apiEnabled) return this.getRatingsFromApi(tconst);
    return null;
  }

  /** IMDb ids only — used for cross-provider lookup and "open on IMDb" links. */
  getExternalIds(tconst: string): Record<string, string> {
    return { imdb: tconst };
  }

  /** Public "open on IMDb" link (a string only — never fetched). */
  static imdbUrl(tconst: string): string {
    return `https://www.imdb.com/title/${tconst}/`;
  }

  private async resolveNames(nconsts: string[]): Promise<string[]> {
    if (!nconsts.length) return [];
    const persons = await this.prisma.iMDbPerson.findMany({
      where: { nconst: { in: nconsts } },
    });
    const byId = new Map(persons.map((p) => [p.nconst, p.primaryName]));
    return nconsts.map((id) => byId.get(id) ?? id);
  }

  // --- optional official/licensed API (generic REST, NEVER imdb.com) --------

  private async apiGet(path: string, params: Record<string, string>): Promise<any> {
    const base = this.settings.apiBaseUrl;
    const key = this.settings.apiKey;
    if (!base || !key) return null;
    const url = new URL(path.replace(/^\//, ''), base.endsWith('/') ? base : base + '/');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${key}`, 'x-api-key': key },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async searchApi(
    query: ImdbSearchQuery,
    limit: number,
  ): Promise<ImdbSearchResult[]> {
    const data = await this.apiGet('search/title', {
      query: query.title,
      ...(query.year ? { year: String(query.year) } : {}),
      ...(query.type && query.type !== 'any' ? { type: query.type } : {}),
    });
    const rows: any[] = Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data)
        ? data
        : [];
    return rows.slice(0, limit).map((r) => {
      const tconst = String(r.id ?? r.tconst ?? '');
      const candidate: CandidateTitle = {
        tconst,
        titleType: String(r.titleType ?? r.type ?? 'movie'),
        primaryTitle: String(r.primaryTitle ?? r.title ?? ''),
        originalTitle: String(r.originalTitle ?? r.primaryTitle ?? r.title ?? ''),
        startYear: toInt(r.year ?? r.startYear),
      };
      return {
        tconst,
        titleType: candidate.titleType,
        primaryTitle: candidate.primaryTitle,
        originalTitle: candidate.originalTitle,
        year: candidate.startYear,
        isAdult: Boolean(r.isAdult),
        genres: Array.isArray(r.genres) ? r.genres.map(String) : [],
        rating: toFloat(r.rating ?? r.averageRating),
        numVotes: toInt(r.numVotes),
        confidence: scoreTitleMatch(
          { title: query.title, year: query.year, type: query.type ?? 'any' },
          candidate,
        ),
      };
    });
  }

  private async getTitleFromApi(tconst: string): Promise<MediaMetadataDetails | null> {
    const r = await this.apiGet(`title/${encodeURIComponent(tconst)}`, {});
    if (!r) return null;
    return {
      title: String(r.primaryTitle ?? r.title ?? tconst),
      originalTitle: r.originalTitle ? String(r.originalTitle) : undefined,
      year: toInt(r.year ?? r.startYear) ?? undefined,
      runtime: toInt(r.runtimeMinutes ?? r.runtime) ?? undefined,
      genres: Array.isArray(r.genres) ? r.genres.map(String) : [],
      rating: toFloat(r.rating ?? r.averageRating) ?? undefined,
      providerName: this.name,
      externalIds: { imdb: tconst },
    };
  }

  private async getRatingsFromApi(tconst: string): Promise<ImdbRatingInfo | null> {
    const r = await this.apiGet(`title/${encodeURIComponent(tconst)}/ratings`, {});
    const avg = toFloat(r?.averageRating ?? r?.rating);
    const votes = toInt(r?.numVotes);
    if (avg === null) return null;
    return { tconst, averageRating: avg, numVotes: votes ?? 0 };
  }
}

/** IMDb characters are a JSON-ish array string like `["Neo"]`. */
function parseCharacters(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) return arr.map(String).join(', ');
  } catch {
    /* not JSON — fall through */
  }
  return raw.replace(/^\[|\]$/g, '').replace(/"/g, '') || undefined;
}

function toInt(v: unknown): number | null {
  if (v == null) return null;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}
function toFloat(v: unknown): number | null {
  if (v == null) return null;
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

export { isTvType };
