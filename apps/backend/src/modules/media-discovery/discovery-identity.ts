import { normalizeTitle } from '../media/imdb/imdb-match';
import type { RawDiscovery, RawReleaseDate } from './discovery-provider';

/**
 * Turning several providers' views of the world into one list of titles.
 *
 * The failure this exists to prevent is the same one the movie matcher was
 * hardened against: two different works collapsing into one record because they
 * share a name. TMDB carries three separate 2026 films called *The Odyssey*. A
 * merge that keyed on title and year would fuse them, and every downstream
 * decision — the watchlist entry, the generated rule, the folder — would then be
 * about a film nobody chose.
 *
 * So merging is evidence-ordered, and it refuses rather than guesses:
 *
 *  1. **A shared external id is proof.** Two records naming the same `imdb`,
 *     `tmdb`, `tvdb`, `tvmaze` or `trakt` id are the same work, full stop.
 *  2. **A contradicted id is proof of the opposite.** Two records that both name
 *     a `tmdb` id and disagree about it are DIFFERENT works, however identical
 *     their titles — and if something else has already joined them, the group is
 *     `conflicted` and never auto-monitored.
 *  3. **Title and year are a hint, never proof.** They join records only when no
 *     id contradicts, and only when the providers themselves are not already
 *     distinguishing more than one work by that name.
 */

/** Id namespaces, strongest first. Order decides the canonical key. */
export const ID_PRIORITY = ['imdb', 'tmdb', 'tvdb', 'tvmaze', 'trakt'] as const;
export type IdNamespace = (typeof ID_PRIORITY)[number];

/** resolved — safe to act on. ambiguous/conflicted — surfaced, never auto-monitored. */
export type IdentityStatus = 'resolved' | 'ambiguous' | 'conflicted';

export interface MergedDiscovery {
  mediaType: 'movie' | 'tv';
  title: string;
  originalTitle: string | null;
  normalizedTitle: string;
  year: number | null;
  externalIds: Partial<Record<IdNamespace, string>>;
  /**
   * The canonical key, from the strongest id present.
   *
   * **This can change as ids accumulate** — a TVmaze-only show keyed
   * `tvmaze:1234` becomes `imdb:tt…` the moment TMDB contributes an IMDb id, and
   * persisting on the key alone would then create a second row for one show.
   * {@link alternateKeys} exists so the store can look a record up by ANY id it
   * has ever been known by, which is what makes the change survivable.
   */
  dedupeKey: string;
  /** Every key this record answers to, canonical one included. */
  alternateKeys: string[];

  genres: string[];
  originalLanguage: string | null;
  countries: string[];
  network: string | null;
  studio: string | null;
  streamingService: string | null;
  overview: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  popularity: number | null;
  rating: number | null;
  voteCount: number | null;

  seriesStatus: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  premiereDate: string | null;
  seasonPremiereDate: string | null;

  /** Every provider that reported this title. */
  sourceProviders: string[];
  /** Every date every provider gave, tagged with who said it. Never collapsed. */
  releaseDates: Array<RawReleaseDate & { source: string }>;
  identityStatus: IdentityStatus;
  /** 0–1. Below a template's floor, or not `resolved`, means no auto-monitoring. */
  confidence: number;
  /** Human-readable note when the status is not `resolved`. */
  identityNote?: string;
}

/** One provider's record, tagged with who produced it. */
export interface SourcedDiscovery {
  provider: string;
  raw: RawDiscovery;
}

/** `imdb:tt0111161`, `tmdb:movie:1698863` — media type included where ids are per-type. */
export function identityKey(namespace: IdNamespace, id: string, mediaType: string): string {
  // TMDB numbers movies and shows in separate spaces, so `tmdb:123` is ambiguous
  // between them; IMDb/TVDB/TVmaze/Trakt ids are globally unique and are not
  // qualified, which keeps a key stable if a record's media type is ever corrected.
  return namespace === 'tmdb' ? `tmdb:${mediaType}:${id}` : `${namespace}:${id}`;
}

/** Every key a record answers to, strongest first. */
export function identityKeys(ids: Partial<Record<IdNamespace, string>>, mediaType: string): string[] {
  return ID_PRIORITY.filter((ns) => ids[ns]).map((ns) => identityKey(ns, String(ids[ns]), mediaType));
}

/**
 * Merge every provider's records into one list of distinct works.
 *
 * Records are grouped by shared id first, then — only where nothing contradicts —
 * by normalized title + year within a media type.
 */
export function mergeDiscoveries(input: SourcedDiscovery[]): MergedDiscovery[] {
  const nodes = input.filter((s) => s.raw?.title?.trim());

  // --- 1. union by shared id ----------------------------------------------
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[rb] = ra;
  };

  const byKey = new Map<string, number>();
  nodes.forEach((n, i) => {
    for (const key of identityKeys(n.raw.externalIds ?? {}, n.raw.mediaType)) {
      const seen = byKey.get(key);
      if (seen === undefined) byKey.set(key, i);
      else union(seen, i);
    }
  });

  // --- 2. join on title+year, only where no id contradicts -----------------
  /*
   * A title+year group where ONE PROVIDER already reports two works is the
   * *Odyssey* case: the provider is distinguishing them, so we have no basis to
   * fuse them and every basis not to. The whole group is marked ambiguous and
   * left un-joined, so the operator sees the candidates rather than a guess.
   */
  const titleGroups = new Map<string, number[]>();
  nodes.forEach((n, i) => {
    const key = `${n.raw.mediaType}|${normalizeTitle(n.raw.title)}|${n.raw.year ?? ''}`;
    titleGroups.set(key, [...(titleGroups.get(key) ?? []), i]);
  });

  const ambiguous = new Set<number>();
  for (const members of titleGroups.values()) {
    if (members.length < 2) continue;
    const providers = members.map((i) => nodes[i].provider);
    const duplicatedWithinOneProvider = new Set(providers).size !== providers.length;
    if (duplicatedWithinOneProvider) {
      members.forEach((i) => ambiguous.add(i));
      continue;
    }
    // Different providers, same title+year, and no id says otherwise → join.
    for (let k = 1; k < members.length; k++) {
      if (!idsContradict(nodes[members[0]].raw, nodes[members[k]].raw)) {
        union(members[0], members[k]);
      }
    }
  }

  // --- 3. build one merged record per group --------------------------------
  const groups = new Map<number, number[]>();
  nodes.forEach((_, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  });

  return [...groups.values()].map((members) =>
    build(members.map((i) => nodes[i]), members.some((i) => ambiguous.has(i))),
  );
}

/** Do two records name the same id namespace with different values? */
function idsContradict(a: RawDiscovery, b: RawDiscovery): boolean {
  for (const ns of ID_PRIORITY) {
    const av = a.externalIds?.[ns];
    const bv = b.externalIds?.[ns];
    if (av && bv && String(av) !== String(bv)) return true;
  }
  return false;
}

function build(members: SourcedDiscovery[], wasAmbiguous: boolean): MergedDiscovery {
  // Provider order is the order they were supplied; the first non-null wins for
  // every scalar, so the caller controls precedence by the order it asks.
  const first = <T>(pick: (r: RawDiscovery) => T | null | undefined): T | null => {
    for (const m of members) {
      const v = pick(m.raw);
      if (v !== null && v !== undefined && v !== '') return v;
    }
    return null;
  };

  const externalIds: Partial<Record<IdNamespace, string>> = {};
  let conflicted = false;
  for (const ns of ID_PRIORITY) {
    for (const m of members) {
      const v = m.raw.externalIds?.[ns];
      if (!v) continue;
      if (externalIds[ns] && externalIds[ns] !== String(v)) conflicted = true;
      externalIds[ns] ??= String(v);
    }
  }

  const mediaType = members[0].raw.mediaType;
  const title = String(first((r) => r.title) ?? '');
  const keys = identityKeys(externalIds, mediaType);

  const releaseDates = members.flatMap((m) =>
    (m.raw.releaseDates ?? []).map((d) => ({ ...d, source: m.provider })),
  );

  const identityStatus: IdentityStatus = conflicted
    ? 'conflicted'
    : wasAmbiguous
      ? 'ambiguous'
      : 'resolved';

  return {
    mediaType,
    title,
    originalTitle: first((r) => r.originalTitle),
    normalizedTitle: normalizeTitle(title),
    year: first((r) => r.year),
    externalIds,
    /*
     * A record with no external id at all still gets a key, from its normalized
     * title and year. It is the weakest possible identity and is scored as such —
     * it exists so the record can be stored and shown, never so it can be acted
     * on automatically.
     */
    dedupeKey: keys[0] ?? `title:${mediaType}:${normalizeTitle(title)}:${first((r) => r.year) ?? ''}`,
    alternateKeys: keys,
    genres: [...new Set(members.flatMap((m) => m.raw.genres ?? []))],
    originalLanguage: first((r) => r.originalLanguage),
    countries: [...new Set(members.flatMap((m) => m.raw.countries ?? []))],
    network: first((r) => r.network),
    studio: first((r) => r.studio),
    streamingService: first((r) => r.streamingService),
    overview: first((r) => r.overview),
    posterUrl: first((r) => r.posterUrl),
    backdropUrl: first((r) => r.backdropUrl),
    popularity: first((r) => r.popularity),
    rating: first((r) => r.rating),
    voteCount: first((r) => r.voteCount),
    seriesStatus: first((r) => r.seriesStatus),
    seasonNumber: first((r) => r.seasonNumber),
    episodeNumber: first((r) => r.episodeNumber),
    premiereDate: first((r) => r.premiereDate),
    seasonPremiereDate: first((r) => r.seasonPremiereDate),
    sourceProviders: [...new Set(members.map((m) => m.provider))],
    releaseDates,
    identityStatus,
    confidence: score(externalIds, members, identityStatus),
    ...(identityStatus === 'conflicted'
      ? { identityNote: 'Providers disagree on this title’s external ids.' }
      : identityStatus === 'ambiguous'
        ? { identityNote: 'More than one distinct work shares this title and year.' }
        : {}),
  };
}

/**
 * How much the merged identity is trusted, 0–1.
 *
 * Driven by the STRENGTH of the identity rather than by how much metadata came
 * with it: a record with a full synopsis, a poster and no external id is still an
 * unidentified record. Corroboration by a second provider adds to it; an
 * unresolved status caps it below any sane auto-monitor floor, because the point
 * of the cap is that no template can configure its way past a bad identity.
 */
function score(
  ids: Partial<Record<IdNamespace, string>>,
  members: SourcedDiscovery[],
  status: IdentityStatus,
): number {
  if (status !== 'resolved') return 0.2;
  let s = 0;
  if (ids.imdb) s += 0.55;
  if (ids.tmdb) s += 0.3;
  if (ids.tvdb) s += 0.2;
  if (ids.tvmaze) s += 0.15;
  if (ids.trakt) s += 0.1;
  if (s === 0) return 0.1; // title-only: storable, never actionable
  if (new Set(members.map((m) => m.provider)).size > 1) s += 0.15;
  return Math.min(1, Math.round(s * 100) / 100);
}
