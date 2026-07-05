/**
 * Pure parsing helpers for the official IMDb non-commercial TSV datasets.
 *
 * These operate on the *licensed dataset files* only (title.basics.tsv.gz, …).
 * There is deliberately NO HTML/scraping logic here — the datasets are the sole
 * on-disk source of IMDb data. Everything in this file is side-effect free and
 * unit-testable.
 */

/**
 * The official IMDb non-commercial datasets are published at this host. It is
 * the sanctioned distribution channel for the `.tsv.gz` files (NOT imdb.com HTML
 * scraping), and is the default base for the optional auto-download job. The
 * base URL is operator-configurable so a private mirror can be used instead.
 */
export const DEFAULT_IMDB_DATASET_BASE_URL = 'https://datasets.imdbws.com/';

/** The seven IMDb dataset files, in a safe import order (titles first). */
export interface DatasetFileSpec {
  /** Gzipped filename as distributed by IMDb. */
  file: string;
  /** Short logical key used for bookkeeping (IMDbDatasetImport.filesImported). */
  key: string;
  /** Expected TSV header columns (tab-separated) for structural validation. */
  header: string[];
  /** Prisma model/table this file feeds (for reporting). */
  target: string;
}

export const IMDB_DATASET_FILES: DatasetFileSpec[] = [
  {
    file: 'title.basics.tsv.gz',
    key: 'title.basics',
    target: 'imdb_titles',
    header: [
      'tconst',
      'titleType',
      'primaryTitle',
      'originalTitle',
      'isAdult',
      'startYear',
      'endYear',
      'runtimeMinutes',
      'genres',
    ],
  },
  {
    file: 'name.basics.tsv.gz',
    key: 'name.basics',
    target: 'imdb_persons',
    header: [
      'nconst',
      'primaryName',
      'birthYear',
      'deathYear',
      'primaryProfession',
      'knownForTitles',
    ],
  },
  {
    file: 'title.akas.tsv.gz',
    key: 'title.akas',
    target: 'imdb_akas',
    header: [
      'titleId',
      'ordering',
      'title',
      'region',
      'language',
      'types',
      'attributes',
      'isOriginalTitle',
    ],
  },
  {
    file: 'title.crew.tsv.gz',
    key: 'title.crew',
    target: 'imdb_crew',
    header: ['tconst', 'directors', 'writers'],
  },
  {
    file: 'title.episode.tsv.gz',
    key: 'title.episode',
    target: 'imdb_episodes',
    header: ['tconst', 'parentTconst', 'seasonNumber', 'episodeNumber'],
  },
  {
    file: 'title.principals.tsv.gz',
    key: 'title.principals',
    target: 'imdb_principals',
    header: ['tconst', 'ordering', 'nconst', 'category', 'job', 'characters'],
  },
  {
    file: 'title.ratings.tsv.gz',
    key: 'title.ratings',
    target: 'imdb_ratings',
    header: ['tconst', 'averageRating', 'numVotes'],
  },
];

/** Split a raw TSV line into its fields (IMDb never quotes/escapes tabs). */
export function parseTsvLine(line: string): string[] {
  // Trim only a trailing CR (CRLF files); do NOT trim tabs which are data.
  return line.replace(/\r$/, '').split('\t');
}

/** Map an IMDb TSV cell to a value, treating the sentinel `\N` as null. */
export function tsvField(value: string | undefined): string | null {
  if (value === undefined || value === '' || value === '\\N') return null;
  return value;
}

/** Parse an IMDb TSV integer cell (`\N` → null). */
export function tsvInt(value: string | undefined): number | null {
  const v = tsvField(value);
  if (v === null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Parse an IMDb TSV float cell (`\N` → null). */
export function tsvFloat(value: string | undefined): number | null {
  const v = tsvField(value);
  if (v === null) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse an IMDb TSV boolean cell (`0`/`1`, `\N` → false). */
export function tsvBool(value: string | undefined): boolean {
  return tsvField(value) === '1';
}

/** Parse a comma-separated IMDb TSV list cell (`\N`/empty → []). */
export function tsvList(value: string | undefined): string[] {
  const v = tsvField(value);
  if (v === null) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Validate a parsed header against the expected columns. IMDb has, at times,
 * appended columns; we require the expected columns to be a prefix (present, in
 * order) rather than an exact match, so imports stay resilient.
 */
export function validateHeader(actual: string[], expected: string[]): boolean {
  if (actual.length < expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

// --- row mappers (pure) ----------------------------------------------------
// Each maps a parsed TSV field array to a Prisma create input for its table.

export interface TitleRow {
  tconst: string;
  titleType: string;
  primaryTitle: string;
  originalTitle: string;
  isAdult: boolean;
  startYear: number | null;
  endYear: number | null;
  runtimeMinutes: number | null;
  genres: string[];
}

export function mapTitleRow(f: string[]): TitleRow | null {
  const tconst = tsvField(f[0]);
  const primaryTitle = tsvField(f[2]);
  if (!tconst || !primaryTitle) return null;
  return {
    tconst,
    titleType: tsvField(f[1]) ?? 'unknown',
    primaryTitle,
    originalTitle: tsvField(f[3]) ?? primaryTitle,
    isAdult: tsvBool(f[4]),
    startYear: tsvInt(f[5]),
    endYear: tsvInt(f[6]),
    runtimeMinutes: tsvInt(f[7]),
    genres: tsvList(f[8]),
  };
}

export function mapPersonRow(f: string[]) {
  const nconst = tsvField(f[0]);
  const primaryName = tsvField(f[1]);
  if (!nconst || !primaryName) return null;
  return {
    nconst,
    primaryName,
    birthYear: tsvInt(f[2]),
    deathYear: tsvInt(f[3]),
    primaryProfession: tsvList(f[4]),
    knownForTitles: tsvList(f[5]),
  };
}

export function mapAkaRow(f: string[]) {
  const titleId = tsvField(f[0]);
  const title = tsvField(f[2]);
  if (!titleId || !title) return null;
  return {
    titleId,
    ordering: tsvInt(f[1]),
    title,
    region: tsvField(f[3]),
    language: tsvField(f[4]),
    types: tsvField(f[5]),
    attributes: tsvField(f[6]),
    isOriginalTitle: tsvBool(f[7]),
  };
}

export function mapCrewRow(f: string[]) {
  const titleId = tsvField(f[0]);
  if (!titleId) return null;
  return {
    titleId,
    directors: tsvList(f[1]),
    writers: tsvList(f[2]),
  };
}

export function mapEpisodeRow(f: string[]) {
  const episodeTitleId = tsvField(f[0]);
  const parentTitleId = tsvField(f[1]);
  if (!episodeTitleId || !parentTitleId) return null;
  return {
    episodeTitleId,
    parentTitleId,
    seasonNumber: tsvInt(f[2]),
    episodeNumber: tsvInt(f[3]),
  };
}

export function mapPrincipalRow(f: string[]) {
  const titleId = tsvField(f[0]);
  const personId = tsvField(f[2]);
  const ordering = tsvInt(f[1]);
  if (!titleId || !personId || ordering === null) return null;
  return {
    titleId,
    ordering,
    personId,
    category: tsvField(f[3]),
    job: tsvField(f[4]),
    characters: tsvField(f[5]),
  };
}

export function mapRatingRow(f: string[]) {
  const titleId = tsvField(f[0]);
  const averageRating = tsvFloat(f[1]);
  const numVotes = tsvInt(f[2]);
  if (!titleId || averageRating === null || numVotes === null) return null;
  return { titleId, averageRating, numVotes };
}

// --- optimized "movie import" filter (pure) --------------------------------

/**
 * The movie-like title types the optimized import always keeps —
 * theatrical/TV movies and direct-to-video releases. UltraTorrent's core job is
 * movie acquisition, so these are the default subset.
 */
export const OPTIMIZED_TITLE_TYPES = ['movie', 'tvMovie', 'video'] as const;
const OPTIMIZED_MOVIE_TYPE_SET = new Set<string>(OPTIMIZED_TITLE_TYPES);

/**
 * The TV title types imported additionally when the "include TV" toggle is on:
 * series, mini-series, and individual episodes. Everything else (shorts, games,
 * tvSpecial, …) is still skipped.
 */
export const OPTIMIZED_TV_TYPES = ['tvSeries', 'tvMiniSeries', 'tvEpisode'] as const;
const OPTIMIZED_TV_TYPE_SET = new Set<string>(OPTIMIZED_TV_TYPES);

/** Why a title row was skipped by the optimized filter (null = keep it). */
export type TitleSkipReason = 'titleType' | 'adult' | 'minYear';

/**
 * Decide whether an optimized import should keep a parsed title row. Returns
 * `null` to keep, or the reason it was skipped so the importer can count it.
 * Order matters for the stats: type → adult → year. When `includeTv` is true,
 * TV series/mini-series/episodes are accepted alongside the movie types.
 */
export function optimizedTitleSkipReason(
  row: TitleRow,
  minYear: number,
  includeTv = false,
): TitleSkipReason | null {
  const allowed =
    OPTIMIZED_MOVIE_TYPE_SET.has(row.titleType) ||
    (includeTv && OPTIMIZED_TV_TYPE_SET.has(row.titleType));
  if (!allowed) return 'titleType';
  if (row.isAdult) return 'adult';
  if (row.startYear == null || row.startYear < minYear) return 'minYear';
  return null;
}
