/**
 * Pluggable artwork providers — resolve an item's external id into a list of
 * downloadable image candidates (URLs + dimensions), NOT bytes. Downloading,
 * validation, and storage stay in MediaArtworkService so every ingest path
 * (custom upload + provider import) shares the same magic-byte + size checks.
 *
 * TMDB is the first provider. Others (fanart.tv, TVDB) can be added by
 * implementing ArtworkProvider — same pattern as the metadata providers.
 */
import type { ArtworkType } from './media-artwork.service';

/** A single downloadable image the provider offers for an item. */
export interface ArtworkCandidate {
  type: ArtworkType;
  url: string; // absolute, on the provider's image CDN
  width?: number;
  height?: number;
  lang?: string | null; // iso-639-1, or null for textless art
  score?: number; // provider vote/preference, for ranking
  seasonNumber?: number | null;
}

export interface ArtworkProvider {
  readonly name: string;
  /** externalId is the provider's own id for the item (e.g. a TMDB movie id). */
  list(kind: 'movie' | 'tv', externalId: string): Promise<ArtworkCandidate[]>;
}

/**
 * Hosts we will fetch artwork bytes from. The candidate URLs originate from an
 * external API response, so we allowlist the CDN host to block SSRF via a
 * poisoned url before any download happens.
 */
export const ALLOWED_ARTWORK_HOSTS = new Set(['image.tmdb.org']);

/** True when `url` is well-formed and points at an allowed image host. Pure. */
export function isAllowedArtworkHost(url: string): boolean {
  try {
    return ALLOWED_ARTWORK_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
}

// --- TMDB ----------------------------------------------------------------

interface TmdbImage {
  file_path?: string;
  width?: number;
  height?: number;
  iso_639_1?: string | null;
  vote_average?: number;
}

export interface TmdbImagesResponse {
  posters?: TmdbImage[];
  backdrops?: TmdbImage[];
  logos?: TmdbImage[];
}

/**
 * Map a TMDB `/images` payload into artwork candidates. Pure — exported for
 * unit testing. `imgBase` is the CDN base (e.g. https://image.tmdb.org/t/p/original).
 */
export function mapTmdbImages(
  data: TmdbImagesResponse | null,
  imgBase: string,
): ArtworkCandidate[] {
  if (!data) return [];
  const map = (arr: TmdbImage[] | undefined, type: ArtworkType): ArtworkCandidate[] =>
    (arr ?? [])
      .filter((i): i is TmdbImage & { file_path: string } => Boolean(i.file_path))
      .map((i) => ({
        type,
        url: imgBase + i.file_path,
        width: i.width,
        height: i.height,
        lang: i.iso_639_1 ?? null,
        score: i.vote_average ?? 0,
      }));
  // TMDB image buckets → our ARTWORK_TYPES.
  return [
    ...map(data.posters, 'poster'),
    ...map(data.backdrops, 'fanart'),
    ...map(data.logos, 'logo'),
  ];
}

/** Artwork languages preferred when several candidates exist. */
export const DEFAULT_ARTWORK_LANGUAGES = ['en'] as const;

/**
 * How much we want this candidate's language, lower being better.
 *
 * Fanart is the one type where TEXTLESS wins: a backdrop carrying a localised
 * title is worse than a clean one whatever language it is in. Posters are the
 * opposite — a poster is supposed to carry its title, so a language we can read
 * comes first and textless is the fallback.
 *
 * Nothing is ever excluded. The worst score still sorts, which is the whole
 * point: see {@link pickBestArtwork}.
 */
function languageRank(
  lang: string | null | undefined,
  type: ArtworkType,
  preferred: readonly string[],
): number {
  const textless = lang == null;
  const preferredIndex = lang ? preferred.indexOf(lang) : -1;

  if (type === 'fanart') {
    if (textless) return 0;
    return preferredIndex >= 0 ? 1 + preferredIndex : 1 + preferred.length;
  }
  if (preferredIndex >= 0) return preferredIndex;
  return textless ? preferred.length : preferred.length + 1;
}

/**
 * Best candidate for a type: preferred language first, then provider score,
 * tie-broken by resolution. Pure. Returns undefined only when no candidate of
 * that type exists at all.
 *
 * **Language ranks candidates; it never removes them.** The TMDB provider used
 * to ask for `include_image_language=en,null`, which made the restriction a
 * filter applied before we ever saw the list — so a film whose posters happen
 * to be in other languages came back with no poster, and the call site could
 * not tell "TMDB has none" from "we asked for the wrong ones". Live: Evolution
 * (2026) has eight posters — es, uk, el, ru, pl — and imported zero, while its
 * 35 language-neutral backdrops came through fine. A poster in a language you
 * did not ask for beats an empty poster slot.
 */
export function pickBestArtwork(
  candidates: ArtworkCandidate[],
  type: ArtworkType,
  preferred: readonly string[] = DEFAULT_ARTWORK_LANGUAGES,
): ArtworkCandidate | undefined {
  return candidates
    .filter((c) => c.type === type)
    .sort(
      (a, b) =>
        languageRank(a.lang, type, preferred) - languageRank(b.lang, type, preferred) ||
        (b.score ?? 0) - (a.score ?? 0) ||
        (b.width ?? 0) - (a.width ?? 0),
    )[0];
}

/** TMDB (themoviedb.org) v3 image lists. Activated only when a key is present. */
export class TmdbArtworkProvider implements ArtworkProvider {
  readonly name = 'tmdb';
  private readonly api = 'https://api.themoviedb.org/3';
  // Full-resolution CDN base; the download size cap guards against huge files.
  private readonly imgBase = 'https://image.tmdb.org/t/p/original';

  constructor(private readonly apiKey: string) {}

  async list(kind: 'movie' | 'tv', externalId: string): Promise<ArtworkCandidate[]> {
    const data = await this.get(`/${kind}/${externalId}/images`);
    return mapTmdbImages(data, this.imgBase);
  }

  /**
   * The posters for ONE season.
   *
   * `/tv/{id}/images` returns the SERIES' posters and knows nothing about
   * season 2 — so a season scope asking that endpoint got the show's art filed
   * as if it were the season's, and the season cover never arrived.
   */
  async listSeasonPosters(seriesId: string, season: number): Promise<ArtworkCandidate[]> {
    const data = await this.get(`/tv/${seriesId}/season/${season}/images`);
    return ((data as { posters?: TmdbImage[] } | null)?.posters ?? [])
      .filter((i): i is TmdbImage & { file_path: string } => Boolean(i.file_path))
      .map((i) => ({
        type: 'season_poster' as ArtworkType,
        url: this.imgBase + i.file_path,
        width: i.width,
        height: i.height,
        lang: i.iso_639_1 ?? null,
        score: i.vote_average ?? 0,
        seasonNumber: season,
      }));
  }

  /**
   * The stills for ONE episode.
   *
   * A separate call because TMDB keeps them there: `/tv/{id}/images` returns the
   * series' posters and backdrops and knows nothing about episode 4. Without it
   * an episode could only ever show art belonging to its show — which is what
   * every episode of an unstilled show currently displays.
   *
   * Mapped to `thumbnail`, the type this platform already uses for an episode
   * still, so it lands in the same picker as everything else.
   */
  async listEpisodeStills(
    seriesId: string,
    season: number,
    episode: number,
  ): Promise<ArtworkCandidate[]> {
    const data = await this.get(`/tv/${seriesId}/season/${season}/episode/${episode}/images`);
    const stills = (data as { stills?: TmdbImage[] } | null)?.stills ?? [];
    return stills
      .filter((i): i is TmdbImage & { file_path: string } => Boolean(i.file_path))
      .map((i) => ({
        type: 'thumbnail' as ArtworkType,
        url: this.imgBase + i.file_path,
        width: i.width,
        height: i.height,
        lang: i.iso_639_1 ?? null,
        score: i.vote_average ?? 0,
      }));
  }

  private async get(path: string): Promise<TmdbImagesResponse | null> {
    const url = new URL(this.api + path);
    url.searchParams.set('api_key', this.apiKey);
    /*
     * Every image, in every language.
     *
     * This used to send `include_image_language=en,null`, which reads like a
     * preference and behaves like a filter: TMDB drops everything else before
     * replying, so a film with no English or textless poster returned none at
     * all and we imported no poster without anything to log. Preference belongs
     * in `pickBestArtwork`, where a second choice is still a choice.
     */
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      return (await res.json()) as TmdbImagesResponse;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
