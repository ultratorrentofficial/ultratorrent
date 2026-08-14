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
 * **Movies only, deliberately.** A TV row's title is the episode
 * (`"FROM — A Rock and a Farway"`), while a library item stores the SHOW title
 * with season/episode numbers and no episode name. There is no honest way to get
 * from one to the other with the data on hand, so episode rows are counted as
 * unresolved rather than guessed at — attributing a show-level play to all of its
 * episodes would mark a whole series watched on the strength of one.
 */

/** Media-server media types that describe a film. */
const MOVIE_TYPES = new Set(['movie', 'movies', 'film']);

export function isMovieRow(mediaType: string | null | undefined): boolean {
  return MOVIE_TYPES.has((mediaType ?? '').trim().toLowerCase());
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
  /** Normalized title → every library item sharing it. */
  byTitle: Map<string, string[]>;
}

/**
 * Index the library's movies by normalized title.
 *
 * A title held by more than one item is kept as a LIST rather than collapsed.
 * Two files of the same film are two items, and a play of that film is evidence
 * about both — dropping one would leave a watched copy looking never watched, and
 * that copy is then a deletion candidate.
 */
export function buildTitleIndex(items: ResolvableItem[]): TitleIndex {
  const byTitle = new Map<string, string[]>();
  for (const item of items) {
    const key = normalizeTitle(item.title ?? '');
    if (!key) continue;
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(item.id);
    else byTitle.set(key, [item.id]);
  }
  return { byTitle };
}

export interface ResolutionOutcome<R> {
  /** Item id → the rows attributed to it. */
  byItem: Map<string, R[]>;
  /** Rows that named a film no library item matches. */
  unresolved: number;
  /** Rows skipped because they are not films (episodes, music, unknown). */
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
    if (!isMovieRow(row.mediaType)) {
      skippedNonMovie += 1;
      continue;
    }
    const ids = index.byTitle.get(normalizeTitle(row.title ?? ''));
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
