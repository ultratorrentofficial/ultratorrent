/**
 * The Universal scraper.
 *
 * Not a new data source — a **per-field composition policy** over the providers
 * the registry already knows. The insight it encodes: no single source is best
 * at everything. TheTVDB carries the truest episode data and certifications;
 * TMDB carries better film overviews, artwork ids and cast; IMDb carries the
 * rating people actually mean. The ordinary chain has to pick ONE winner per
 * item and take everything from it, blanks included. Universal takes each field
 * from whoever actually has it.
 *
 * Two rules make it safe rather than merely clever:
 *
 * 1. **A preference never yields a worse result than no preference.** If you
 *    name TMDB for `overview` and TMDB has no overview, the field falls back to
 *    the chain order rather than coming back empty. A policy expresses "prefer",
 *    never "only".
 * 2. **Emptiness is a value-level question, not a null check.** `[]`, `''` and
 *    whitespace do not count as an answer — otherwise a provider that returns a
 *    hollow record would out-rank one holding real data.
 *
 * The cost is real and is why this is opt-in: it queries EVERY configured
 * provider for every item, where the plain chain usually stops at the first.
 */
import type {
  MediaLookup,
  MediaMetadata,
  MediaMetadataDetails,
  MediaMetadataProvider,
} from './metadata-provider';

/** Fields whose source can be chosen. `externalIds` is always merged, never picked. */
export const COMPOSABLE_FIELDS = [
  'title',
  'originalTitle',
  'overview',
  'releaseDate',
  'year',
  'runtime',
  'genres',
  'studios',
  'cast',
  'crew',
  'directors',
  'writers',
  'rating',
  'certification',
  'tags',
] as const;

export type ComposableField = (typeof COMPOSABLE_FIELDS)[number];

/** field → provider name, or `auto` (take the first provider that has it). */
export type FieldPolicy = Partial<Record<ComposableField, string>>;

export interface ProviderResult {
  provider: string;
  details: MediaMetadataDetails;
}

/**
 * True when a provider actually answered for this field. An empty array, an
 * empty/whitespace string, and null/undefined are all "no answer" — a provider
 * returning a hollow record must not out-rank one holding the real value.
 */
export function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Compose one details object from several, per field.
 *
 * `results` must already be in chain order — that order IS the `auto` policy,
 * and it is also the tie-break when a named provider has nothing to say.
 */
export function mergeDetails(
  results: ProviderResult[],
  policy: FieldPolicy = {},
): MediaMetadataDetails | null {
  if (!results.length) return null;

  const out: Record<string, unknown> = {};
  const sources: Record<string, string> = {};

  for (const field of COMPOSABLE_FIELDS) {
    const preferred = policy[field];
    // A named provider gets first refusal; if it has nothing, we fall through to
    // chain order rather than honour the preference into an empty field.
    const ordered = preferred
      ? [
          ...results.filter((r) => r.provider === preferred),
          ...results.filter((r) => r.provider !== preferred),
        ]
      : results;

    const hit = ordered.find((r) => hasValue((r.details as any)[field]));
    if (hit) {
      out[field] = (hit.details as any)[field];
      sources[field] = hit.provider;
    }
  }

  // External ids are UNIONED across every provider that answered — never picked.
  // This is the part Trakt and cross-provider matching depend on: one lookup can
  // leave us holding tvdb + tmdb + imdb ids for the same item, where the plain
  // chain would only ever have carried the winner's.
  const externalIds: Record<string, string> = {};
  for (const r of results) {
    for (const [provider, id] of Object.entries(r.details.externalIds ?? {})) {
      if (id && !externalIds[provider]) externalIds[provider] = String(id);
    }
  }

  return {
    ...(out as MediaMetadataDetails),
    providerName: 'universal',
    externalIds,
    // Which source won each field. Purely diagnostic — nothing depends on it —
    // but without it "why does this item say 2014?" is unanswerable.
    fieldSources: sources,
  } as MediaMetadataDetails;
}

/**
 * Queries every provider in the chain and composes their answers.
 *
 * A provider that throws is DROPPED, not fatal: the whole point is that the
 * others still contribute. If every provider fails or misses, the result is
 * null and the caller falls back to local NFO, exactly as with a plain chain.
 */
export class UniversalMetadataProvider implements MediaMetadataProvider {
  readonly name = 'universal';

  constructor(
    /** In chain order — that order is the `auto` policy. */
    private readonly providers: MediaMetadataProvider[],
    private readonly policy: FieldPolicy = {},
  ) {}

  private async gather(query: MediaLookup): Promise<ProviderResult[]> {
    const settled = await Promise.allSettled(
      this.providers.map((p) => p.fetchDetails(query)),
    );
    const results: ProviderResult[] = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled' && outcome.value) {
        results.push({ provider: this.providers[i].name, details: outcome.value });
      }
    });
    return results;
  }

  async fetchDetails(query: MediaLookup): Promise<MediaMetadataDetails | null> {
    return mergeDetails(await this.gather(query), this.policy);
  }

  async lookup(query: MediaLookup): Promise<MediaMetadata> {
    const details = await this.fetchDetails(query);
    if (!details) return {};
    if (query.kind === 'movie') return { movieTitle: details.title, year: details.year };
    const isEpisode = query.season != null && query.episode != null;
    return isEpisode
      ? { episodeTitle: details.title, seriesTitle: details.originalTitle, year: details.year }
      : { seriesTitle: details.title, year: details.year };
  }
}
