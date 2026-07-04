import { ForbiddenException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { PERMISSIONS, ROLE_PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import {
  IMDB_DATASET_FILES,
  mapTitleRow,
  mapRatingRow,
  mapEpisodeRow,
  parseTsvLine,
  tsvBool,
  tsvInt,
  tsvList,
  validateHeader,
} from './imdb-tsv';
import {
  normalizeTitle,
  scoreTitleMatch,
  titleSimilarity,
  titleTypeMatchesKind,
} from './imdb-match';
import { ImdbMetadataProvider } from './imdb-metadata.provider';
import { ImdbDatasetImporterService } from './imdb-dataset-importer.service';
import { ImdbService } from './imdb.service';
import {
  ImdbSettingsService,
  REDACTED,
  type ImdbSettings,
} from './imdb-settings.service';
import { SecretCipher } from '../../../common/crypto/secret-cipher';

// --- test helpers ----------------------------------------------------------

function filePathStub(root: string) {
  return {
    assertWithinHardRoots: (requested: string) => {
      const abs = path.resolve(requested);
      if (abs === root || abs.startsWith(root + path.sep)) return abs;
      throw new ForbiddenException('Path is outside the allowed storage roots.');
    },
  } as any;
}

const noopRealtime = { broadcast: jest.fn() } as any;
const noopAudit = { record: jest.fn().mockResolvedValue(undefined) } as any;

const baseSettings: ImdbSettings = {
  mode: 'dataset',
  apiBaseUrl: null,
  apiKey: null,
  datasetPath: null,
  importSchedule: null,
  autoDownloadEnabled: false,
  datasetBaseUrl: 'https://datasets.imdbws.com/',
  autoUpdateIntervalHours: 168,
  preferredRegion: null,
  preferredLanguage: null,
  includeAdult: false,
  minVotes: 0,
  cacheTtl: 3600,
};

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'imdb-test-'));
}

function tsv(rows: string[][]): Buffer {
  return Buffer.from(rows.map((r) => r.join('\t')).join('\n') + '\n', 'utf8');
}

// --- TSV parsing -----------------------------------------------------------

describe('IMDb TSV parsing', () => {
  it('splits fields and maps the \\N sentinel to null-ish values', () => {
    const fields = parseTsvLine('tt1\tmovie\tThe Matrix\tThe Matrix\t0\t1999\t\\N\t136\tAction,Sci-Fi');
    expect(fields).toHaveLength(9);
    expect(tsvInt(fields[6])).toBeNull();
    expect(tsvInt(fields[5])).toBe(1999);
    expect(tsvBool(fields[4])).toBe(false);
    expect(tsvList(fields[8])).toEqual(['Action', 'Sci-Fi']);
  });

  it('maps a title.basics row', () => {
    const row = mapTitleRow(
      parseTsvLine('tt0133093\tmovie\tThe Matrix\tThe Matrix\t0\t1999\t\\N\t136\tAction,Sci-Fi'),
    );
    expect(row).toMatchObject({
      tconst: 'tt0133093',
      titleType: 'movie',
      primaryTitle: 'The Matrix',
      isAdult: false,
      startYear: 1999,
      runtimeMinutes: 136,
      genres: ['Action', 'Sci-Fi'],
    });
  });

  it('rejects a row missing a required field', () => {
    expect(mapTitleRow(parseTsvLine('\\N\tmovie\t\\N\t\\N\t0'))).toBeNull();
    expect(mapRatingRow(parseTsvLine('tt1\t\\N\t100'))).toBeNull();
  });

  it('validates a header as a prefix match', () => {
    const spec = IMDB_DATASET_FILES.find((f) => f.key === 'title.basics')!;
    expect(validateHeader(spec.header, spec.header)).toBe(true);
    expect(validateHeader(['tconst', 'wrong'], spec.header)).toBe(false);
    // extra trailing columns are tolerated
    expect(validateHeader([...spec.header, 'extra'], spec.header)).toBe(true);
  });
});

// --- gzip stream handling + streaming import -------------------------------

describe('ImdbDatasetImporterService streaming', () => {
  it('stream-parses a gzipped TSV fixture and batch-inserts mapped rows', async () => {
    const dir = await tmpDir();
    const abs = path.join(dir, 'title.basics.tsv.gz');
    const header = IMDB_DATASET_FILES.find((f) => f.key === 'title.basics')!.header;
    await fs.writeFile(
      abs,
      gzipSync(
        tsv([
          header,
          ['tt0133093', 'movie', 'The Matrix', 'The Matrix', '0', '1999', '\\N', '136', 'Action,Sci-Fi'],
          ['tt0234215', 'movie', 'The Matrix Reloaded', 'The Matrix Reloaded', '0', '2003', '\\N', '138', 'Action'],
        ]),
      ),
    );

    const created: any[] = [];
    const prisma = {
      iMDbTitle: { createMany: jest.fn(async ({ data }: any) => created.push(...data)) },
    } as any;
    const importer = new ImdbDatasetImporterService(
      prisma,
      filePathStub(dir),
      noopAudit,
      noopRealtime,
    );

    const spec = IMDB_DATASET_FILES.find((f) => f.key === 'title.basics')!;
    const count = await importer.importFile(spec, abs);

    expect(count).toBe(2);
    expect(prisma.iMDbTitle.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(created.map((r) => r.tconst)).toEqual(['tt0133093', 'tt0234215']);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects a dataset directory outside the allowed roots', async () => {
    const importer = new ImdbDatasetImporterService(
      {} as any,
      filePathStub('/media/allowed'),
      noopAudit,
      noopRealtime,
    );
    await expect(importer.validate('/etc/passwd')).rejects.toThrow(ForbiddenException);
  });

  it('produces a validation report for a dataset directory', async () => {
    const dir = await tmpDir();
    const header = IMDB_DATASET_FILES.find((f) => f.key === 'title.basics')!.header;
    await fs.writeFile(
      path.join(dir, 'title.basics.tsv.gz'),
      gzipSync(tsv([header, ['tt1', 'movie', 'A', 'A', '0', '2000', '\\N', '90', 'Drama']])),
    );
    const importer = new ImdbDatasetImporterService(
      {} as any,
      filePathStub(dir),
      noopAudit,
      noopRealtime,
    );
    const report = await importer.validate(dir);
    expect(report.hasMinimum).toBe(true);
    expect(report.valid).toBe(true);
    expect(report.filesFound).toBe(1);
    const basics = report.files.find((f) => f.key === 'title.basics')!;
    expect(basics.present).toBe(true);
    expect(basics.gzipOk).toBe(true);
    expect(basics.headerOk).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('skips files already recorded as imported (resumable re-run)', async () => {
    const dir = await tmpDir();
    const header = IMDB_DATASET_FILES.find((f) => f.key === 'title.basics')!.header;
    await fs.writeFile(
      path.join(dir, 'title.basics.tsv.gz'),
      gzipSync(tsv([header, ['tt1', 'movie', 'A', 'A', '0', '2000', '\\N', '90', 'Drama']])),
    );
    const updates: any[] = [];
    const prisma = {
      iMDbDatasetImport: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'imp1',
          filesImported: ['title.basics'],
          recordsImported: 1,
          startedAt: new Date(),
        }),
        update: jest.fn(async ({ data }: any) => updates.push(data)),
      },
      iMDbTitle: { createMany: jest.fn() },
    } as any;
    const importer = new ImdbDatasetImporterService(
      prisma,
      filePathStub(dir),
      noopAudit,
      noopRealtime,
    );
    await importer.runImport('imp1', dir);
    // title.basics was already done → no createMany
    expect(prisma.iMDbTitle.createMany).not.toHaveBeenCalled();
    expect(updates.some((u) => u.status === 'completed')).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// --- match scoring ---------------------------------------------------------

describe('IMDb match scoring', () => {
  it('normalizes titles', () => {
    expect(normalizeTitle('The Matrix: Reloaded!')).toBe('the matrix reloaded');
    expect(normalizeTitle('Fight & Club')).toBe('fight and club');
  });

  it('scores an exact title+year at maximum confidence', () => {
    const s = scoreTitleMatch(
      { title: 'The Matrix', year: 1999, type: 'movie' },
      { tconst: 'tt1', titleType: 'movie', primaryTitle: 'The Matrix', originalTitle: 'The Matrix', startYear: 1999 },
    );
    expect(s).toBeGreaterThanOrEqual(0.95);
  });

  it('penalizes a wrong year and ranks below an exact match', () => {
    const exact = scoreTitleMatch(
      { title: 'The Matrix', year: 1999 },
      { tconst: 'tt1', titleType: 'movie', primaryTitle: 'The Matrix', originalTitle: 'The Matrix', startYear: 1999 },
    );
    const wrongYear = scoreTitleMatch(
      { title: 'The Matrix', year: 1999 },
      { tconst: 'tt2', titleType: 'movie', primaryTitle: 'The Matrix', originalTitle: 'The Matrix', startYear: 2010 },
    );
    expect(exact).toBeGreaterThan(wrongYear);
  });

  it('matches via an AKA title', () => {
    const s = scoreTitleMatch(
      { title: 'Matrix' },
      {
        tconst: 'tt1',
        titleType: 'movie',
        primaryTitle: 'The Matrix',
        originalTitle: 'The Matrix',
        startYear: 1999,
        akas: ['Matrix'],
      },
    );
    expect(s).toBeGreaterThanOrEqual(0.8);
  });

  it('fuzzy-matches a near title above a weak one', () => {
    expect(titleSimilarity('The Matrix', 'The Matrx')).toBeGreaterThan(
      titleSimilarity('The Matrix', 'Gladiator'),
    );
  });

  it('maps coarse kinds to IMDb title types', () => {
    expect(titleTypeMatchesKind('movie', 'movie')).toBe(true);
    expect(titleTypeMatchesKind('tvSeries', 'tv')).toBe(true);
    expect(titleTypeMatchesKind('tvEpisode', 'episode')).toBe(true);
    expect(titleTypeMatchesKind('movie', 'tv')).toBe(false);
  });
});

// --- provider search + lookup ----------------------------------------------

describe('ImdbMetadataProvider (dataset mode)', () => {
  function providerWith(
    titles: any[],
    ratings: any[] = [],
    settings: Partial<ImdbSettings> = {},
  ) {
    const prisma = {
      iMDbTitle: {
        findMany: jest.fn().mockResolvedValue(titles),
        findUnique: jest.fn(async ({ where }: any) =>
          titles.find((t) => t.tconst === where.tconst) ?? null,
        ),
        count: jest.fn().mockResolvedValue(titles.length),
      },
      iMDbAka: { findMany: jest.fn().mockResolvedValue([]) },
      iMDbRating: {
        findMany: jest.fn().mockResolvedValue(ratings),
        findUnique: jest.fn(async ({ where }: any) =>
          ratings.find((r) => r.titleId === where.titleId) ?? null,
        ),
      },
      iMDbCrew: { findUnique: jest.fn().mockResolvedValue(null) },
      iMDbPerson: { findMany: jest.fn().mockResolvedValue([]) },
      iMDbEpisode: { findFirst: jest.fn(), findUnique: jest.fn() },
    } as any;
    return {
      prisma,
      provider: new ImdbMetadataProvider(prisma, { ...baseSettings, ...settings }),
    };
  }

  const matrix = {
    tconst: 'tt0133093',
    titleType: 'movie',
    primaryTitle: 'The Matrix',
    originalTitle: 'The Matrix',
    isAdult: false,
    startYear: 1999,
    endYear: null,
    runtimeMinutes: 136,
    genres: ['Action', 'Sci-Fi'],
  };
  const adult = {
    tconst: 'tt9',
    titleType: 'movie',
    primaryTitle: 'The Matrix XXX',
    originalTitle: 'The Matrix XXX',
    isAdult: true,
    startYear: 2000,
    endYear: null,
    runtimeMinutes: 60,
    genres: ['Adult'],
  };

  it('ranks the exact match first with a high confidence', async () => {
    const { provider } = providerWith([matrix]);
    const res = await provider.searchTitle({ title: 'The Matrix', year: 1999, type: 'movie' });
    expect(res[0].tconst).toBe('tt0133093');
    expect(res[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('excludes adult titles unless includeAdult is set', async () => {
    const excluded = await providerWith([matrix, adult]).provider.searchTitle({
      title: 'The Matrix',
    });
    expect(excluded.some((r) => r.tconst === 'tt9')).toBe(false);

    const included = await providerWith([matrix, adult], [], {
      includeAdult: true,
    }).provider.searchTitle({ title: 'The Matrix' });
    expect(included.some((r) => r.tconst === 'tt9')).toBe(true);
  });

  it('filters out titles below minVotes', async () => {
    const ratings = [{ titleId: 'tt0133093', averageRating: 8.7, numVotes: 100 }];
    const res = await providerWith([matrix], ratings, { minVotes: 500 }).provider.searchTitle({
      title: 'The Matrix',
    });
    expect(res).toHaveLength(0);
  });

  it('filters by title type', async () => {
    const res = await providerWith([matrix]).provider.searchTitle({
      title: 'The Matrix',
      type: 'tv',
    });
    expect(res).toHaveLength(0);
  });

  it('getTitleById returns rich details with the imdb external id', async () => {
    const ratings = [{ titleId: 'tt0133093', averageRating: 8.7, numVotes: 2_000_000 }];
    const details = await providerWith([matrix], ratings).provider.getTitleById('tt0133093');
    expect(details?.title).toBe('The Matrix');
    expect(details?.rating).toBe(8.7);
    expect(details?.externalIds?.imdb).toBe('tt0133093');
  });

  it('matches a tv episode by parent + season + episode', async () => {
    const { prisma, provider } = providerWith([
      { ...matrix, tconst: 'ttEp', titleType: 'tvEpisode', primaryTitle: 'Pilot' },
    ]);
    prisma.iMDbEpisode.findFirst.mockResolvedValue({ episodeTitleId: 'ttEp' });
    prisma.iMDbEpisode.findUnique.mockResolvedValue({
      episodeTitleId: 'ttEp',
      seasonNumber: 1,
      episodeNumber: 3,
    });
    const ep = await provider.getEpisodeMetadata({
      parentTitleId: 'ttParent',
      season: 1,
      episode: 3,
    });
    expect(ep?.title).toBe('Pilot');
    expect((ep as any).season).toBe(1);
    expect((ep as any).episode).toBe(3);
  });

  it('reports disabled capabilities when mode is disabled', () => {
    const { provider } = providerWith([], [], { mode: 'disabled' });
    const caps = provider.providerCapabilities();
    expect(caps.source).toBe('disabled');
    expect(caps.available).toBe(false);
  });
});

// --- settings (encryption + redaction, secrets not logged) -----------------

describe('ImdbSettingsService', () => {
  function make() {
    const store = new Map<string, unknown>();
    const settings = {
      get: jest.fn(async (k: string) => store.get(k)),
      set: jest.fn(async (k: string, v: unknown) => void store.set(k, v)),
    } as any;
    const cipher = new SecretCipher({ get: () => 'unit-test-secret' } as any);
    return { svc: new ImdbSettingsService(settings, cipher), store, cipher };
  }

  it('encrypts the API key at rest and never returns it in clear', async () => {
    const { svc, store } = make();
    const redacted = await svc.update({
      mode: 'official_api',
      apiBaseUrl: 'https://api.example.com',
      apiKey: 'super-secret-key',
    });
    // Redacted read never reveals the key.
    expect(redacted.apiKey).toBe(REDACTED);
    expect(redacted.hasApiKey).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain('super-secret-key');

    // Stored blob is ciphertext, not the plaintext.
    const stored = store.get('media.imdb') as any;
    expect(stored.apiKey).not.toContain('super-secret-key');
    expect(stored.__apiKeyEncrypted).toBe(true);

    // Internal read decrypts correctly.
    const full = await svc.read();
    expect(full.apiKey).toBe('super-secret-key');
  });

  it('keeps the existing key when a redacted placeholder is echoed back', async () => {
    const { svc } = make();
    await svc.update({ apiKey: 'keep-me', mode: 'official_api', apiBaseUrl: 'https://x' });
    await svc.update({ apiKey: REDACTED, minVotes: 10 });
    const full = await svc.read();
    expect(full.apiKey).toBe('keep-me');
    expect(full.minVotes).toBe(10);
  });

  it('does not leak the secret through logging surfaces', async () => {
    const { svc } = make();
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await svc.update({ apiKey: 'top-secret', mode: 'official_api', apiBaseUrl: 'https://x' });
    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('top-secret');
    spy.mockRestore();
  });

  it('defaults auto-download off with the official base URL and weekly interval', async () => {
    const { svc } = make();
    const s = await svc.read();
    expect(s.autoDownloadEnabled).toBe(false);
    expect(s.datasetBaseUrl).toBe('https://datasets.imdbws.com/');
    expect(s.autoUpdateIntervalHours).toBe(168);
  });

  it('persists auto-download config', async () => {
    const { svc } = make();
    await svc.update({
      autoDownloadEnabled: true,
      datasetBaseUrl: 'https://mirror.example.com/imdb/',
      autoUpdateIntervalHours: 24,
    });
    const s = await svc.read();
    expect(s.autoDownloadEnabled).toBe(true);
    expect(s.datasetBaseUrl).toBe('https://mirror.example.com/imdb/');
    expect(s.autoUpdateIntervalHours).toBe(24);
  });

  it('resets the base URL to the official default when cleared', async () => {
    const { svc } = make();
    await svc.update({ datasetBaseUrl: 'https://mirror.example.com/' });
    await svc.update({ datasetBaseUrl: null });
    const s = await svc.read();
    expect(s.datasetBaseUrl).toBe('https://datasets.imdbws.com/');
  });

  it('rejects a non-http base URL and a sub-hour interval', async () => {
    const { svc } = make();
    await expect(svc.update({ datasetBaseUrl: 'ftp://x/' })).rejects.toThrow();
    await expect(svc.update({ autoUpdateIntervalHours: 0 })).rejects.toThrow();
  });
});

// --- dataset update destination --------------------------------------------

describe('ImdbService.triggerDatasetUpdate — dataset destination', () => {
  function makeService(datasetPath: string | null) {
    const settingsSvc = {
      read: jest.fn().mockResolvedValue({ datasetPath, datasetBaseUrl: 'https://ds.example/' }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const importer = {
      downloadDataset: jest.fn().mockResolvedValue({}),
      startImport: jest.fn().mockResolvedValue({}),
    };
    const filePath = {
      hardRoots: ['/data'],
      assertWithinHardRoots: (p: string) => p,
    };
    const svc = new ImdbService(
      {} as any, // prisma
      settingsSvc as any,
      importer as any,
      filePath as any,
      noopAudit,
      noopRealtime,
      {} as any, // settings
      {} as any, // moduleRef
    );
    return { svc, settingsSvc, importer };
  }

  it('falls back to a managed default under the storage root when no path is set', async () => {
    const { svc, settingsSvc } = makeService(null);
    const res = await svc.triggerDatasetUpdate();
    const expected = '/data/.ultratorrent/imdb-datasets';
    expect(res).toEqual({ started: true, datasetPath: expected });
    // The default is persisted so the rest of the UI points at it.
    expect(settingsSvc.update).toHaveBeenCalledWith({ datasetPath: expected });
  });

  it('uses the configured dataset path as-is when one is set', async () => {
    const { svc, settingsSvc } = makeService('/data/imdb');
    const res = await svc.triggerDatasetUpdate();
    expect(res.datasetPath).toBe('/data/imdb');
    expect(settingsSvc.update).not.toHaveBeenCalled();
  });
});

// --- permissions -----------------------------------------------------------

describe('IMDb permissions', () => {
  it('defines the five IMDb permissions', () => {
    expect(PERMISSIONS.MEDIA_MANAGER_IMDB_VIEW).toBe('media_manager.imdb.view');
    expect(PERMISSIONS.MEDIA_MANAGER_IMDB_CONFIGURE).toBe('media_manager.imdb.configure');
    expect(PERMISSIONS.MEDIA_MANAGER_IMDB_IMPORT_DATASET).toBe('media_manager.imdb.import_dataset');
    expect(PERMISSIONS.MEDIA_MANAGER_IMDB_SEARCH).toBe('media_manager.imdb.search');
    expect(PERMISSIONS.MEDIA_MANAGER_IMDB_MATCH).toBe('media_manager.imdb.match');
  });

  it('grants view/search to USER and configure/import/match to POWER_USER', () => {
    const user = ROLE_PERMISSIONS[SystemRole.USER];
    expect(user).toContain(PERMISSIONS.MEDIA_MANAGER_IMDB_VIEW);
    expect(user).toContain(PERMISSIONS.MEDIA_MANAGER_IMDB_SEARCH);
    expect(user).not.toContain(PERMISSIONS.MEDIA_MANAGER_IMDB_CONFIGURE);

    const power = ROLE_PERMISSIONS[SystemRole.POWER_USER];
    expect(power).toContain(PERMISSIONS.MEDIA_MANAGER_IMDB_CONFIGURE);
    expect(power).toContain(PERMISSIONS.MEDIA_MANAGER_IMDB_IMPORT_DATASET);
    expect(power).toContain(PERMISSIONS.MEDIA_MANAGER_IMDB_MATCH);
  });
});
