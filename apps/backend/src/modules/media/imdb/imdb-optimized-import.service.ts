import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { WS_EVENTS, type ImdbEventPayload } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../../files/file-path.service';
import { AuditService } from '../../audit/audit.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import type { AuditContext } from '../media-metadata.service';
import type { ImdbSettings } from './imdb-settings.service';
import {
  DatasetFileSpec,
  IMDB_DATASET_FILES,
  mapAkaRow,
  mapCrewRow,
  mapEpisodeRow,
  mapPersonRow,
  mapRatingRow,
  mapTitleRow,
  optimizedTitleSkipReason,
} from './imdb-tsv';
import { streamTsvRecords } from './imdb-stream';
import { ImportCancelledError, type ShouldCancel } from './imdb-cancel';

/** Scan/skip/error counters + timing for one optimized import run. */
export interface ImportStats {
  /** Total data rows read across every processed dataset file. */
  rowsScanned: number;
  /** Rows actually written to the database (post-filter, post-dedup). */
  rowsImported: number;
  /** title.basics rows skipped because the titleType isn't movie-like. */
  skippedTitleType: number;
  /** title.basics rows skipped because isAdult=1. */
  skippedAdult: number;
  /** title.basics rows skipped because startYear < the minimum year. */
  skippedMinYear: number;
  /** ratings/akas/crew rows skipped because their parent title wasn't imported. */
  skippedParentMissing: number;
  /** Malformed / unparseable rows. */
  errors: number;
  /** Wall-clock duration of the run, milliseconds. */
  durationMs: number;
  /** Dataset keys that were processed, in order. */
  datasets: string[];
}

const DEFAULT_BATCH_SIZE = 5000;

/**
 * The dataset the optimized strategy NEVER imports, whatever the toggles.
 * `title.principals` is enormous (~90M cast/crew link rows) and isn't needed for
 * acquisition, matching, or ranking. `title.episode` is NOT here — it's imported
 * when the "include TV" toggle is on (episodes need it), and skipped otherwise.
 */
export const ALWAYS_SKIPPED_DATASETS = ['title.principals'] as const;

/**
 * The datasets skipped in the default movies-only configuration — principals
 * plus TV-episode structure. Kept for the test/logging of the default profile;
 * with `importTvShows` on, `title.episode` moves out of this set.
 */
export const OPTIMIZED_SKIPPED_DATASETS = ['title.principals', 'title.episode'] as const;

function zeroStats(): ImportStats {
  return {
    rowsScanned: 0,
    rowsImported: 0,
    skippedTitleType: 0,
    skippedAdult: 0,
    skippedMinYear: 0,
    skippedParentMissing: 0,
    errors: 0,
    durationMs: 0,
    datasets: [],
  };
}

/**
 * The "Optimized Movie Import" strategy. Instead of blindly importing every
 * IMDb dataset, it imports a lean, production-ready subset tuned for
 * UltraTorrent's movie acquisition / matching / ranking / metadata needs:
 *
 *   1. title.basics  — filtered to movie-like (`movie`/`tvMovie`/`video`),
 *                      non-adult titles from the configured minimum year on.
 *   2. title.ratings — only for titles imported in step 1.
 *   3. title.akas    — (optional) alternate titles for imported titles only.
 *   4. title.crew    — (optional) directors/writers for imported titles only.
 *   5. name.basics   — (optional) people; large, off by default.
 *
 * It NEVER imports title.principals or title.episode (see
 * {@link OPTIMIZED_SKIPPED_DATASETS}). Every file is streamed (never loaded
 * whole), written in bounded batches, and the run is idempotent + resumable.
 */
@Injectable()
export class ImdbOptimizedImportService {
  private readonly logger = new Logger(ImdbOptimizedImportService.name);
  /**
   * Stop predicate for the run currently executing, polled at each batch flush.
   * A field (not threaded through every phase) keeps the phase signatures small;
   * safe because the importer's choke point guarantees only one run at a time.
   * Overwritten at the start of every {@link execute}.
   */
  private cancelCheck: ShouldCancel = () => false;

  /** Throw the cancel sentinel if a stop has been requested (call after a flush). */
  private throwIfCancelled(): void {
    if (this.cancelCheck()) throw new ImportCancelledError();
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly filePath: FilePathService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly config: ConfigService,
  ) {}

  private batchSize(): number {
    return this.config.get<number>('imdb.importBatchSize') ?? DEFAULT_BATCH_SIZE;
  }

  private specByKey(key: string): DatasetFileSpec {
    const spec = IMDB_DATASET_FILES.find((s) => s.key === key);
    if (!spec) throw new Error(`Unknown IMDb dataset key: ${key}`);
    return spec;
  }

  private assertFile(dirAbs: string, file: string): string {
    return this.filePath.assertWithinHardRoots(path.join(dirAbs, file));
  }

  private emit(
    id: string,
    status: string,
    progress: number,
    message: string,
    stats: ImportStats,
    done: string[],
  ): void {
    const payload: Omit<ImdbEventPayload, 'at'> = {
      id,
      status,
      progress,
      message,
      recordsImported: stats.rowsImported,
      filesImported: done,
    };
    this.realtime.broadcast(WS_EVENTS.IMDB_DATASET_IMPORT_PROGRESS, {
      ...payload,
      at: new Date().toISOString(),
    });
  }

  /**
   * Run the optimized import against the dataset files in `dirAbs`, updating the
   * import record + streaming WS progress. Idempotent — safe to re-run; each
   * batch skips duplicates on the table's natural key. Returns the final stats.
   */
  async execute(
    importId: string,
    dirAbs: string,
    settings: ImdbSettings,
    ctx: AuditContext = {},
    shouldCancel: ShouldCancel = () => false,
  ): Promise<ImportStats> {
    this.cancelCheck = shouldCancel;
    const start = Date.now();
    const stats = zeroStats();
    const minYear = settings.minImportYear;
    const includeTv = Boolean(settings.importTvShows);
    const batchSize = this.batchSize();
    const done: string[] = [];

    await this.prisma.iMDbDatasetImport.update({
      where: { id: importId },
      data: { status: 'running', startedAt: new Date(), strategy: 'optimized_movies' },
    });
    // title.principals is always skipped; title.episode only when TV is off.
    const skipped = includeTv ? [...ALWAYS_SKIPPED_DATASETS] : [...OPTIMIZED_SKIPPED_DATASETS];
    this.logger.log(
      `IMDb optimized import ${importId}: strategy=optimized_movies minYear=${minYear} ` +
        `tv=${includeTv} akas=${settings.importAkas} crew=${settings.importCrew} ` +
        `people=${settings.importPeople} batch=${batchSize}. Intentionally skipping ${skipped.join(', ')}.`,
    );

    // Ordered plan: titles first (everything else references them), then the
    // referential + optional datasets. title.basics is the only required file.
    const plan: Array<{
      key: string;
      enabled: boolean;
      required: boolean;
      run: (abs: string, spec: DatasetFileSpec) => Promise<void>;
    }> = [
      { key: 'title.basics', enabled: true, required: true, run: (a, s) => this.importTitles(a, s, minYear, includeTv, batchSize, stats) },
      { key: 'title.ratings', enabled: true, required: false, run: (a, s) => this.importRatings(a, s, batchSize, stats) },
      { key: 'title.akas', enabled: settings.importAkas, required: false, run: (a, s) => this.importAkas(a, s, batchSize, stats) },
      { key: 'title.crew', enabled: settings.importCrew, required: false, run: (a, s) => this.importCrew(a, s, batchSize, stats) },
      // Episode structure (season/episode → parent) — only useful with TV titles.
      { key: 'title.episode', enabled: includeTv, required: false, run: (a, s) => this.importEpisodes(a, s, batchSize, stats) },
      { key: 'name.basics', enabled: settings.importPeople, required: false, run: (a, s) => this.importPeople(a, s, batchSize, stats) },
    ];
    const steps = plan.filter((p) => p.enabled);

    let failure: string | null = null;
    let cancelled = false;
    let index = 0;
    for (const step of steps) {
      if (this.cancelCheck()) {
        cancelled = true;
        break;
      }
      index += 1;
      const spec = this.specByKey(step.key);
      const abs = this.assertFile(dirAbs, spec.file);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) {
        if (step.required) {
          failure = `${spec.file} is required for the optimized import but was not found.`;
          break;
        }
        this.logger.warn(`IMDb optimized import ${importId}: ${spec.file} absent — skipping ${step.key}.`);
        continue;
      }
      try {
        this.logger.log(`IMDb optimized import ${importId}: processing dataset "${step.key}" (${spec.file}).`);
        await step.run(abs, spec);
        done.push(step.key);
        stats.datasets = [...done];
        await this.prisma.iMDbDatasetImport.update({
          where: { id: importId },
          data: {
            filesImported: done,
            recordsImported: stats.rowsImported,
            stats: this.statsJson(stats),
            datasetDate: stat.mtime,
          },
        });
        this.emit(importId, 'running', Math.round((index / steps.length) * 100), step.key, stats, done);
        this.logger.log(
          `IMDb optimized import ${importId}: finished "${step.key}" — ` +
            `scanned=${stats.rowsScanned} imported=${stats.rowsImported} ` +
            `skipType=${stats.skippedTitleType} skipAdult=${stats.skippedAdult} ` +
            `skipYear=${stats.skippedMinYear} skipOrphan=${stats.skippedParentMissing}.`,
        );
      } catch (err) {
        if (err instanceof ImportCancelledError) {
          cancelled = true;
          break;
        }
        failure = `${step.key}: ${(err as Error).message}`;
        stats.errors += 1;
        this.logger.warn(`IMDb optimized import ${importId} — ${failure}`);
        if (step.required) break; // titles are the base — abort if they fail.
      }
    }

    stats.durationMs = Date.now() - start;
    stats.datasets = [...done];

    if (cancelled) {
      await this.prisma.iMDbDatasetImport.update({
        where: { id: importId },
        data: {
          status: 'cancelled',
          completedAt: new Date(),
          recordsImported: stats.rowsImported,
          stats: this.statsJson(stats),
        },
      });
      this.realtime.broadcast(WS_EVENTS.IMDB_DATASET_IMPORT_CANCELLED, {
        id: importId,
        status: 'cancelled',
        recordsImported: stats.rowsImported,
        filesImported: done,
        at: new Date().toISOString(),
      });
      await this.audit.record({
        userId: ctx.userId,
        action: 'media.imdb.dataset.import.cancelled',
        objectType: 'imdb_dataset_import',
        objectId: importId,
        metadata: { strategy: 'optimized_movies', stats: this.statsJson(stats) },
      });
      this.logger.log(
        `IMDb optimized import ${importId} stopped by user — kept ${stats.rowsImported} row(s) across [${done.join(', ')}].`,
      );
      return stats;
    }

    if (failure) {
      await this.prisma.iMDbDatasetImport.update({
        where: { id: importId },
        data: {
          status: 'failed',
          failedAt: new Date(),
          errorMessage: failure,
          recordsImported: stats.rowsImported,
          stats: this.statsJson(stats),
        },
      });
      this.realtime.broadcast(WS_EVENTS.IMDB_DATASET_IMPORT_FAILED, {
        id: importId,
        status: 'failed',
        error: failure,
        recordsImported: stats.rowsImported,
        at: new Date().toISOString(),
      });
      await this.audit.record({
        userId: ctx.userId,
        action: 'media.imdb.dataset.import.failed',
        objectType: 'imdb_dataset_import',
        objectId: importId,
        result: 'failure',
        metadata: { strategy: 'optimized_movies', error: failure, stats: this.statsJson(stats) },
      });
      return stats;
    }

    await this.prisma.iMDbDatasetImport.update({
      where: { id: importId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        recordsImported: stats.rowsImported,
        stats: this.statsJson(stats),
      },
    });
    this.realtime.broadcast(WS_EVENTS.IMDB_DATASET_IMPORT_COMPLETED, {
      id: importId,
      status: 'completed',
      progress: 100,
      recordsImported: stats.rowsImported,
      filesImported: done,
      at: new Date().toISOString(),
    });
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.imdb.dataset.import.completed',
      objectType: 'imdb_dataset_import',
      objectId: importId,
      metadata: { strategy: 'optimized_movies', stats: this.statsJson(stats) },
    });
    this.logger.log(
      `IMDb optimized import ${importId} completed in ${stats.durationMs}ms — ` +
        `imported ${stats.rowsImported} of ${stats.rowsScanned} scanned across [${done.join(', ')}].`,
    );
    return stats;
  }

  /** Plain JSON snapshot of the stats for persistence on the import row. */
  private statsJson(stats: ImportStats): Prisma.InputJsonValue {
    return { ...stats } as Prisma.InputJsonValue;
  }

  // --- per-dataset phases --------------------------------------------------

  /** Stream + filter title.basics into imdb_titles (the optimized subset). */
  private async importTitles(
    abs: string,
    spec: DatasetFileSpec,
    minYear: number,
    includeTv: boolean,
    batchSize: number,
    stats: ImportStats,
  ): Promise<void> {
    let batch: any[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const res = await this.prisma.iMDbTitle.createMany({ data: batch, skipDuplicates: true });
      stats.rowsImported += res.count;
      batch = [];
    };
    for await (const fields of streamTsvRecords(abs, spec)) {
      stats.rowsScanned += 1;
      const row = mapTitleRow(fields);
      if (!row) {
        stats.errors += 1;
        continue;
      }
      const reason = optimizedTitleSkipReason(row, minYear, includeTv);
      if (reason === 'titleType') {
        stats.skippedTitleType += 1;
        continue;
      }
      if (reason === 'adult') {
        stats.skippedAdult += 1;
        continue;
      }
      if (reason === 'minYear') {
        stats.skippedMinYear += 1;
        continue;
      }
      batch.push(row);
      if (batch.length >= batchSize) {
        await flush();
        this.throwIfCancelled(); // cooperative stop point (after committing the batch)
      }
    }
    await flush();
  }

  private importRatings(abs: string, spec: DatasetFileSpec, batchSize: number, stats: ImportStats) {
    return this.importReferential(abs, spec, batchSize, stats, mapRatingRow, (r) => r.titleId, (rows) =>
      this.prisma.iMDbRating.createMany({ data: rows, skipDuplicates: true }),
    );
  }

  private importAkas(abs: string, spec: DatasetFileSpec, batchSize: number, stats: ImportStats) {
    return this.importReferential(abs, spec, batchSize, stats, mapAkaRow, (r) => r.titleId, (rows) =>
      this.prisma.iMDbAka.createMany({ data: rows, skipDuplicates: true }),
    );
  }

  private importCrew(abs: string, spec: DatasetFileSpec, batchSize: number, stats: ImportStats) {
    return this.importReferential(abs, spec, batchSize, stats, mapCrewRow, (r) => r.titleId, (rows) =>
      this.prisma.iMDbCrew.createMany({ data: rows, skipDuplicates: true }),
    );
  }

  /**
   * Episode structure (title.episode). Referential on the EPISODE's own tconst,
   * so a row is kept only when the episode title itself was imported (i.e. TV is
   * on and the episode passed the filters). Idempotent — episodeTitleId is unique.
   */
  private importEpisodes(abs: string, spec: DatasetFileSpec, batchSize: number, stats: ImportStats) {
    return this.importReferential(abs, spec, batchSize, stats, mapEpisodeRow, (r) => r.episodeTitleId, (rows) =>
      this.prisma.iMDbEpisode.createMany({ data: rows, skipDuplicates: true }),
    );
  }

  /**
   * Stream a title-referencing dataset (ratings/akas/crew/episode), keeping only
   * rows whose referenced title was imported in step 1 (referential integrity)
   * and writing them in batches. `idOf` extracts the tconst that must exist in
   * imdb_titles. Rows for un-imported titles are counted as `skippedParentMissing`.
   */
  private async importReferential<T>(
    abs: string,
    spec: DatasetFileSpec,
    batchSize: number,
    stats: ImportStats,
    map: (f: string[]) => T | null,
    idOf: (row: T) => string,
    insert: (rows: T[]) => Promise<{ count: number }>,
  ): Promise<void> {
    let batch: T[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const { kept, missing } = await this.keepExistingTitles(batch, idOf);
      stats.skippedParentMissing += missing;
      if (kept.length) {
        const res = await insert(kept);
        stats.rowsImported += res.count;
      }
      batch = [];
    };
    for await (const fields of streamTsvRecords(abs, spec)) {
      stats.rowsScanned += 1;
      const row = map(fields);
      if (!row) {
        stats.errors += 1;
        continue;
      }
      batch.push(row);
      if (batch.length >= batchSize) {
        await flush();
        this.throwIfCancelled(); // cooperative stop point (after committing the batch)
      }
    }
    await flush();
  }

  /** Import all people (name.basics) — not title-scoped, so no parent filter. */
  private async importPeople(abs: string, spec: DatasetFileSpec, batchSize: number, stats: ImportStats): Promise<void> {
    let batch: any[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const res = await this.prisma.iMDbPerson.createMany({ data: batch, skipDuplicates: true });
      stats.rowsImported += res.count;
      batch = [];
    };
    for await (const fields of streamTsvRecords(abs, spec)) {
      stats.rowsScanned += 1;
      const row = mapPersonRow(fields);
      if (!row) {
        stats.errors += 1;
        continue;
      }
      batch.push(row);
      if (batch.length >= batchSize) {
        await flush();
        this.throwIfCancelled(); // cooperative stop point (after committing the batch)
      }
    }
    await flush();
  }

  /** Split a batch into rows whose referenced title exists vs those that don't. */
  private async keepExistingTitles<T>(
    rows: T[],
    idOf: (row: T) => string,
  ): Promise<{ kept: T[]; missing: number }> {
    const ids = Array.from(new Set(rows.map(idOf)));
    const existing = await this.prisma.iMDbTitle.findMany({
      where: { tconst: { in: ids } },
      select: { tconst: true },
    });
    const present = new Set(existing.map((e) => e.tconst));
    const kept = rows.filter((r) => present.has(idOf(r)));
    return { kept, missing: rows.length - kept.length };
  }
}
