import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { ImdbOptimizedImportService } from './imdb-optimized-import.service';
import {
  IMDB_DATASET_FILES,
  OPTIMIZED_TITLE_TYPES,
  OPTIMIZED_TV_TYPES,
  optimizedTitleSkipReason,
  mapTitleRow,
} from './imdb-tsv';
import { scoreTitleMatch } from './imdb-match';
import { OPTIMIZED_SKIPPED_DATASETS } from './imdb-optimized-import.service';

// --- helpers ---------------------------------------------------------------

const tsv = (rows: string[][]): Buffer =>
  Buffer.from(rows.map((r) => r.join('\t')).join('\n') + '\n', 'utf8');

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'imdb-opt-'));
}

const header = (key: string) => IMDB_DATASET_FILES.find((f) => f.key === key)!.header;

async function writeGz(dir: string, file: string, rows: string[][]): Promise<void> {
  await fs.writeFile(path.join(dir, file), gzipSync(tsv(rows)));
}

/**
 * Minimal stateful in-memory Prisma stub covering exactly the tables the
 * optimized importer touches. createMany honours skipDuplicates on each table's
 * natural key so idempotency can be asserted. Principals/episode createMany
 * throw — the optimized strategy must never call them.
 */
function makePrisma() {
  const titles: any[] = [];
  const ratings: any[] = [];
  const akas: any[] = [];
  const crew: any[] = [];
  const episodes: any[] = [];
  const persons: any[] = [];
  const importRow: any = { id: 'imp1' };

  const dedupInsert = (store: any[], rows: any[], key: (r: any) => string, skip: boolean) => {
    let count = 0;
    for (const row of rows) {
      if (skip && store.some((e) => key(e) === key(row))) continue;
      store.push(row);
      count += 1;
    }
    return { count };
  };

  return {
    _titles: titles,
    _ratings: ratings,
    _akas: akas,
    _crew: crew,
    _episodes: episodes,
    _persons: persons,
    _import: importRow,
    iMDbDatasetImport: {
      update: jest.fn(async ({ data }: any) => Object.assign(importRow, data)),
    },
    iMDbTitle: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) =>
        dedupInsert(titles, data, (r) => r.tconst, Boolean(skipDuplicates)),
      ),
      findMany: jest.fn(async ({ where }: any) => {
        const ids: string[] = where?.tconst?.in ?? [];
        const set = new Set(ids);
        return titles.filter((t) => set.has(t.tconst)).map((t) => ({ tconst: t.tconst }));
      }),
    },
    iMDbRating: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) =>
        dedupInsert(ratings, data, (r) => r.titleId, Boolean(skipDuplicates)),
      ),
    },
    iMDbAka: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) =>
        dedupInsert(akas, data, (r) => `${r.titleId}:${r.ordering}`, Boolean(skipDuplicates)),
      ),
    },
    iMDbCrew: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) =>
        dedupInsert(crew, data, (r) => r.titleId, Boolean(skipDuplicates)),
      ),
    },
    iMDbPerson: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) =>
        dedupInsert(persons, data, (r) => r.nconst, Boolean(skipDuplicates)),
      ),
    },
    iMDbPrincipal: {
      // Principals must NEVER be imported by the optimized strategy.
      createMany: jest.fn(async () => {
        throw new Error('optimized import must NOT write principals');
      }),
    },
    iMDbEpisode: {
      // Episodes are imported only when the TV toggle is on; keyed by episodeTitleId.
      createMany: jest.fn(async ({ data, skipDuplicates }: any) =>
        dedupInsert(episodes, data, (r) => r.episodeTitleId, Boolean(skipDuplicates)),
      ),
    },
  };
}

function makeService(prisma: any, batchSize = 2) {
  const filePath = { assertWithinHardRoots: (p: string) => p } as any;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;
  const realtime = { broadcast: jest.fn() } as any;
  const config = { get: (k: string) => (k === 'imdb.importBatchSize' ? batchSize : undefined) } as any;
  return new ImdbOptimizedImportService(prisma, filePath, audit, realtime, config);
}

const optimizedSettings = (over: Record<string, unknown> = {}) =>
  ({
    importStrategy: 'optimized_movies',
    minImportYear: 1970,
    importTvShows: false,
    importAkas: true,
    importCrew: false,
    importPeople: false,
    ...over,
  }) as any;

// title.basics rows: mix of types / adult / years to exercise every filter.
const BASICS = [
  header('title.basics'),
  ['tt1', 'movie', 'The Matrix', 'The Matrix', '0', '1999', '\\N', '136', 'Action'],
  ['tt2', 'tvMovie', 'A TV Movie', 'A TV Movie', '0', '1980', '\\N', '90', 'Drama'],
  ['tt3', 'video', 'Direct To Video', 'Directo a Video', '0', '1975', '\\N', '80', 'Horror'],
  ['tt4', 'tvSeries', 'A Series', 'A Series', '0', '2001', '\\N', '\\N', 'Drama'],
  ['tt5', 'movie', 'Old Film', 'Old Film', '0', '1950', '\\N', '100', 'Drama'],
  ['tt6', 'movie', 'Adult Film', 'Adult Film', '1', '2010', '\\N', '70', 'Adult'],
  ['tt7', 'tvEpisode', 'An Episode', 'An Episode', '0', '2005', '\\N', '\\N', '\\N'],
];

async function seedDir(): Promise<string> {
  const dir = await tmpDir();
  await writeGz(dir, 'title.basics.tsv.gz', BASICS);
  await writeGz(dir, 'title.ratings.tsv.gz', [
    header('title.ratings'),
    ['tt1', '8.7', '2000000'],
    ['tt3', '6.0', '500'],
    ['tt99', '9.0', '10'], // orphan — parent not imported
  ]);
  await writeGz(dir, 'title.akas.tsv.gz', [
    header('title.akas'),
    ['tt1', '1', 'The Matrix', 'US', '\\N', '\\N', '\\N', '0'],
    ['tt1', '2', 'La Matriz', 'ES', 'es', '\\N', '\\N', '0'],
    ['tt99', '1', 'Ghost', 'US', '\\N', '\\N', '\\N', '0'], // orphan
  ]);
  return dir;
}

// --- pure filter -----------------------------------------------------------

describe('optimizedTitleSkipReason', () => {
  const base = mapTitleRow(['ttX', 'movie', 'T', 'T', '0', '2000', '\\N', '90', 'Drama'])!;
  const row = (over: Record<string, unknown>) => ({ ...base, ...over }) as any;

  it('keeps the allowed movie-like title types', () => {
    for (const t of OPTIMIZED_TITLE_TYPES) {
      expect(optimizedTitleSkipReason(row({ titleType: t }), 1970)).toBeNull();
    }
  });

  it('skips TV/other title types by default (movies only)', () => {
    expect(optimizedTitleSkipReason(row({ titleType: 'tvSeries' }), 1970)).toBe('titleType');
    expect(optimizedTitleSkipReason(row({ titleType: 'tvEpisode' }), 1970)).toBe('titleType');
    expect(optimizedTitleSkipReason(row({ titleType: 'short' }), 1970)).toBe('titleType');
  });

  it('keeps TV series/mini-series/episodes when includeTv is on (but still not shorts)', () => {
    for (const t of OPTIMIZED_TV_TYPES) {
      expect(optimizedTitleSkipReason(row({ titleType: t }), 1970, true)).toBeNull();
    }
    // Movies are still kept, and non-movie/non-TV types are still skipped.
    expect(optimizedTitleSkipReason(row({ titleType: 'movie' }), 1970, true)).toBeNull();
    expect(optimizedTitleSkipReason(row({ titleType: 'short' }), 1970, true)).toBe('titleType');
  });

  it('skips adult titles', () => {
    expect(optimizedTitleSkipReason(row({ isAdult: true }), 1970)).toBe('adult');
  });

  it('skips titles older than the minimum year (and null years)', () => {
    expect(optimizedTitleSkipReason(row({ startYear: 1969 }), 1970)).toBe('minYear');
    expect(optimizedTitleSkipReason(row({ startYear: null }), 1970)).toBe('minYear');
    expect(optimizedTitleSkipReason(row({ startYear: 1970 }), 1970)).toBeNull();
  });
});

// --- integration: the optimized import -------------------------------------

describe('ImdbOptimizedImportService.execute', () => {
  it('imports only allowed, non-adult, in-year titles and counts every skip', async () => {
    const dir = await seedDir();
    const prisma = makePrisma();
    const stats = await makeService(prisma).execute('imp1', dir, optimizedSettings(), {});

    expect(prisma._titles.map((t) => t.tconst).sort()).toEqual(['tt1', 'tt2', 'tt3']);
    expect(stats.skippedTitleType).toBe(2); // tt4 series, tt7 episode
    expect(stats.skippedAdult).toBe(1); // tt6
    expect(stats.skippedMinYear).toBe(1); // tt5 (1950)
    expect(prisma._import.status).toBe('completed');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('imports ratings and akas only for imported titles (referential integrity)', async () => {
    const dir = await seedDir();
    const prisma = makePrisma();
    const stats = await makeService(prisma).execute('imp1', dir, optimizedSettings(), {});

    // tt1 + tt3 keep their ratings; tt99 is an orphan → skipped.
    expect(prisma._ratings.map((r) => r.titleId).sort()).toEqual(['tt1', 'tt3']);
    // tt1 keeps both akas; tt99 orphan aka skipped.
    expect(prisma._akas.map((a) => a.title).sort()).toEqual(['La Matriz', 'The Matrix']);
    expect(prisma._akas.every((a) => a.titleId === 'tt1')).toBe(true);
    expect(stats.skippedParentMissing).toBe(2); // 1 rating + 1 aka orphan
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('movies-only (default): NEVER imports principals, and skips episodes/TV titles', async () => {
    const dir = await seedDir();
    // Add principals/episode files too — they must still be ignored.
    await writeGz(dir, 'title.principals.tsv.gz', [
      header('title.principals'),
      ['tt1', '1', 'nm1', 'actor', '\\N', '["Neo"]'],
    ]);
    await writeGz(dir, 'title.episode.tsv.gz', [
      header('title.episode'),
      ['tt7', 'tt4', '1', '3'],
    ]);
    const prisma = makePrisma();
    await makeService(prisma).execute('imp1', dir, optimizedSettings(), {});
    expect(prisma.iMDbPrincipal.createMany).not.toHaveBeenCalled();
    expect(prisma.iMDbEpisode.createMany).not.toHaveBeenCalled();
    expect(prisma._episodes.length).toBe(0);
    // tt4 (tvSeries) and tt7 (tvEpisode) were NOT imported as titles.
    expect(prisma._titles.some((t) => t.tconst === 'tt4' || t.tconst === 'tt7')).toBe(false);
    expect(OPTIMIZED_SKIPPED_DATASETS).toEqual(['title.principals', 'title.episode']);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('with importTvShows on: imports TV series + episodes and title.episode, but still not principals', async () => {
    const dir = await seedDir();
    await writeGz(dir, 'title.principals.tsv.gz', [
      header('title.principals'),
      ['tt1', '1', 'nm1', 'actor', '\\N', '["Neo"]'],
    ]);
    await writeGz(dir, 'title.episode.tsv.gz', [
      header('title.episode'),
      ['tt7', 'tt4', '1', '3'], // episode tt7 (imported as tvEpisode) -> parent tt4
      ['tt404', 'tt4', '1', '4'], // orphan episode (tt404 not an imported title)
    ]);
    const prisma = makePrisma();
    await makeService(prisma).execute('imp1', dir, optimizedSettings({ importTvShows: true }), {});
    // TV titles now imported alongside the movies.
    expect(prisma._titles.map((t) => t.tconst).sort()).toEqual(['tt1', 'tt2', 'tt3', 'tt4', 'tt7']);
    // title.episode imported, referential on the episode's own tconst.
    expect(prisma._episodes.map((e) => e.episodeTitleId)).toEqual(['tt7']); // tt404 orphan dropped
    // Principals still never touched.
    expect(prisma.iMDbPrincipal.createMany).not.toHaveBeenCalled();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is idempotent — a second import adds no duplicate rows', async () => {
    const dir = await seedDir();
    const prisma = makePrisma();
    const svc = makeService(prisma);
    await svc.execute('imp1', dir, optimizedSettings(), {});
    const titlesAfterFirst = prisma._titles.length;
    const akasAfterFirst = prisma._akas.length;
    await svc.execute('imp1', dir, optimizedSettings(), {});
    expect(prisma._titles.length).toBe(titlesAfterFirst); // 3, unchanged
    expect(prisma._akas.length).toBe(akasAfterFirst); // 2, unchanged
    expect(prisma._ratings.length).toBe(2);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('skips akas/crew/people when their toggles are off', async () => {
    const dir = await seedDir();
    const prisma = makePrisma();
    await makeService(prisma).execute('imp1', dir, optimizedSettings({ importAkas: false }), {});
    expect(prisma._akas.length).toBe(0);
    expect(prisma.iMDbAka.createMany).not.toHaveBeenCalled();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// --- release-name matching -------------------------------------------------

describe('release matching (scoreTitleMatch)', () => {
  const matrix = {
    tconst: 'tt1',
    titleType: 'movie',
    primaryTitle: 'The Matrix',
    originalTitle: 'The Matrix',
    startYear: 1999,
    akas: ['La Matriz', 'Matrix'],
  };

  it('matches on the primary title', () => {
    expect(scoreTitleMatch({ title: 'The Matrix', year: 1999 }, matrix)).toBeGreaterThan(0.9);
  });

  it('matches on an alternate (AKA) title', () => {
    expect(scoreTitleMatch({ title: 'La Matriz', year: 1999 }, matrix)).toBeGreaterThan(0.9);
  });

  it('prefers the exact-year candidate over a wrong-year one', () => {
    const right = scoreTitleMatch({ title: 'The Matrix', year: 1999 }, matrix);
    const wrong = scoreTitleMatch({ title: 'The Matrix', year: 2010 }, matrix);
    expect(right).toBeGreaterThan(wrong);
  });
});
