/**
 * Attributing playback history to library items — the pure core.
 *
 * `MediaServerWatchHistory` is the only per-play store, and it identifies what was
 * played by TITLE alone: no item id, no external id. So the join back to the
 * library is a name match, and the whole risk of this module is a name matching
 * the wrong thing. Every rule below exists to make a wrong attribution less likely
 * than no attribution, because an unresolved row is reported as unresolved while a
 * misattributed one silently marks the wrong film as watched — or worse, leaves
 * the one you did watch looking untouched.
 *
 * **Films resolve to one item; episodes resolve to their SHOW.** A TV row's title
 * is the episode (`"FROM — A Rock and a Farway"`), while a library item stores the
 * SHOW title with season/episode numbers and no episode name — so an individual
 * episode cannot be identified from history. What can be identified is the series,
 * by longest-prefix match, and a show's watch count is then the total across all
 * its episodes, applied to each of them.
 *
 * That is deliberately conservative in the direction that matters. A series you
 * have partly watched never looks never-watched, so a purge policy cannot take
 * episodes of a show you are midway through. The cost is the opposite error —
 * episodes you skipped inside a show you watched are not identifiable as skipped
 * — and that error only ever keeps files.
 *
 * Longest prefix, not first: the library holds both `24` and `24 Legacy`, and the
 * shorter title prefixes the longer one.
 */

/** Media-server media types that describe a film. */
const MOVIE_TYPES = new Set(['movie', 'movies', 'film']);

export function isMovieRow(mediaType: string | null | undefined): boolean {
  return MOVIE_TYPES.has((mediaType ?? '').trim().toLowerCase());
}

/** Media-server media types that describe one episode of a series. */
const EPISODE_TYPES = new Set(['episode', 'episodes', 'show', 'season']);

export function isEpisodeRow(mediaType: string | null | undefined): boolean {
  return EPISODE_TYPES.has((mediaType ?? '').trim().toLowerCase());
}

/**
 * A title reduced to what two spellings of the same film share.
 *
 * Diacritics folded, punctuation dropped, `&`/`and` unified, a leading article
 * removed, and whitespace collapsed. Deliberately NOT stripping years or
 * bracketed tags: those distinguish a remake from its original, and losing them
 * would merge two different films under one name.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an) /, '')
    .trim()
    .replace(/\s+/g, ' ');
}

export interface ResolvableItem {
  id: string;
  title: string;
  year?: number | null;
}

export interface ResolvableRow {
  title: string;
  mediaType?: string | null;
}

export interface TitleIndex {
  /** Normalized film title → every library item sharing it. */
  byTitle: Map<string, string[]>;
  /** Normalized SHOW title → every episode item of that show. */
  byShow: Map<string, string[]>;
}

/**
 * Index the library's movies by normalized title.
 *
 * A title held by more than one item is kept as a LIST rather than collapsed.
 * Two files of the same film are two items, and a play of that film is evidence
 * about both — dropping one would leave a watched copy looking never watched, and
 * that copy is then a deletion candidate.
 */
export function buildTitleIndex(
  items: ResolvableItem[],
  shows: ResolvableItem[] = [],
): TitleIndex {
  const add = (map: Map<string, string[]>, title: string, id: string) => {
    const key = normalizeTitle(title ?? '');
    if (!key) return;
    const bucket = map.get(key);
    if (bucket) bucket.push(id);
    else map.set(key, [id]);
  };

  const byTitle = new Map<string, string[]>();
  for (const item of items) add(byTitle, item.title, item.id);

  // A TV item's `title` IS the show title — every episode of a series carries it,
  // so the bucket for one key is that series' whole episode list.
  const byShow = new Map<string, string[]>();
  for (const ep of shows) add(byShow, ep.title, ep.id);

  return { byTitle, byShow };
}

/**
 * The series an episode row belongs to, by longest-prefix match.
 *
 * Matching on words rather than on a separator character, because separators are
 * not consistent (`—` and `-` both appear) and show titles contain hyphens of
 * their own. Normalization has already collapsed both to spaces, so the question
 * is simply which known series title the row begins with — and the longest wins,
 * or `24` would swallow every episode of `24 Legacy`.
 */
export function matchShow(rowTitle: string, byShow: Map<string, string[]>): string[] | undefined {
  const words = normalizeTitle(rowTitle ?? '').split(' ').filter(Boolean);
  for (let take = words.length; take > 0; take -= 1) {
    const hit = byShow.get(words.slice(0, take).join(' '));
    if (hit) return hit;
  }
  return undefined;
}

export interface ResolutionOutcome<R> {
  /** Item id → the rows attributed to it. */
  byItem: Map<string, R[]>;
  /** Rows that named a film no library item matches. */
  unresolved: number;
  /** Rows skipped because they are neither a film nor a known series. */
  skippedNonMovie: number;
}

/**
 * Attribute history rows to library items.
 *
 * Counts are returned alongside the attribution so the caller can record how much
 * of the history it actually understood — an aggregate built from rows where most
 * went unresolved is not one to delete on, and `MediaPlaybackAggregate` keeps
 * both numbers for exactly that judgement.
 */
export function resolvePlaybackRows<R extends ResolvableRow>(
  rows: R[],
  index: TitleIndex,
): ResolutionOutcome<R> {
  const byItem = new Map<string, R[]>();
  let unresolved = 0;
  let skippedNonMovie = 0;

  for (const row of rows) {
    let ids: string[] | undefined;

    if (isMovieRow(row.mediaType)) {
      ids = index.byTitle.get(normalizeTitle(row.title ?? ''));
    } else if (isEpisodeRow(row.mediaType)) {
      // Every episode of the series shares the count — see the module note.
      ids = matchShow(row.title ?? '', index.byShow);
    } else {
      skippedNonMovie += 1;
      continue;
    }

    if (!ids?.length) {
      unresolved += 1;
      continue;
    }
    for (const id of ids) {
      const bucket = byItem.get(id);
      if (bucket) bucket.push(row);
      else byItem.set(id, [row]);
    }
  }

  return { byItem, unresolved, skippedNonMovie };
}
