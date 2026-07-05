import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { createGunzip } from 'node:zlib';
import { WS_EVENTS, type ImdbEventPayload } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../../files/file-path.service';
import { AuditService } from '../../audit/audit.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import type { AuditContext } from '../media-metadata.service';
import {
  DatasetFileSpec,
  DEFAULT_IMDB_DATASET_BASE_URL,
  IMDB_DATASET_FILES,
  mapAkaRow,
  mapCrewRow,
  mapEpisodeRow,
  mapPersonRow,
  mapPrincipalRow,
  mapRatingRow,
  mapTitleRow,
  parseTsvLine,
  validateHeader,
} from './imdb-tsv';
import { ImdbSettingsService } from './imdb-settings.service';
import { ImdbOptimizedImportService } from './imdb-optimized-import.service';
import { ImportCancelledError } from './imdb-cancel';

/** Per-file validation outcome. */
export interface DatasetFileReport {
  file: string;
  key: string;
  present: boolean;
  gzipOk: boolean;
  headerOk: boolean;
  sizeBytes: number | null;
  error?: string;
}

export interface DatasetValidationReport {
  datasetPath: string;
  valid: boolean;
  filesFound: number;
  files: DatasetFileReport[];
  /** Any required file missing? (title.basics is the minimum viable input.) */
  hasMinimum: boolean;
}

/** Per-file outcome of an auto-download run. */
export interface DatasetDownloadFileReport {
  file: string;
  ok: boolean;
  bytes: number;
  error?: string;
}

export interface DatasetDownloadReport {
  datasetPath: string;
  baseUrl: string;
  files: DatasetDownloadFileReport[];
  filesDownloaded: number;
}

const BATCH_SIZE = 1000;

/** Per-file download timeout — datasets are large; title.principals is ~hundreds of MB. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

/**
 * Validates and stream-imports the official IMDb non-commercial TSV datasets
 * (user-supplied `.tsv.gz` files) into the local IMDb* tables.
 *
 * COMPLIANCE: import reads only on-disk dataset files under the allowed storage
 * roots. The optional `downloadDataset` fetches the official non-commercial
 * `.tsv.gz` files from their sanctioned distribution host (datasets.imdbws.com
 * by default) — the only network access here. There is NO imdb.com HTML request,
 * NO browser automation, and NO web-page parsing. Every file path is asserted
 * with FilePathService.assertWithinHardRoots first.
 *
 * MEMORY: each `.gz` is parsed as a stream (createReadStream → gunzip →
 * readline), one line at a time, and upserted in bounded batches. The whole
 * file is NEVER read into memory.
 */
@Injectable()
export class ImdbDatasetImporterService {
  private readonly logger = new Logger(ImdbDatasetImporterService.name);
  /**
   * Import ids for which a stop has been requested. The detached worker checks
   * this cooperatively between files and at each batch boundary; the flag is
   * cleared once the worker reaches a terminal state. In-process only — a stop
   * cannot cross a restart, but neither can the worker (orphans are failed at
   * boot by ImdbService.onModuleInit).
   */
  private readonly cancelRequested = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly filePath: FilePathService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly settingsSvc: ImdbSettingsService,
    private readonly optimized: ImdbOptimizedImportService,
  ) {}

  /** Resolve a dataset directory to an absolute path inside the hard roots. */
  private assertDir(datasetPath: string): string {
    return this.filePath.assertWithinHardRoots(datasetPath);
  }

  /** Resolve a single dataset file, re-asserting containment (defense in depth). */
  private assertFile(dirAbs: string, file: string): string {
    return this.filePath.assertWithinHardRoots(path.join(dirAbs, file));
  }

  private emit(event: string, payload: Omit<ImdbEventPayload, 'at'>): void {
    this.realtime.broadcast(event, { ...payload, at: new Date().toISOString() });
  }

  // --- download ------------------------------------------------------------

  /**
   * Download the seven official IMDb `.tsv.gz` datasets from `baseUrl` into the
   * (hard-root-confined) dataset directory, streaming each file straight to disk
   * via a temp `.part` file that is atomically renamed on success.
   *
   * COMPLIANCE: the only network access this subsystem performs. It fetches the
   * official, non-commercial dataset files from their sanctioned distribution
   * host (`datasets.imdbws.com` by default; operator-configurable) — this is NOT
   * scraping imdb.com HTML, browser automation, or web-page parsing, all of
   * which remain forbidden. Nothing but the published dataset files is fetched.
   */
  async downloadDataset(
    datasetPath: string,
    baseUrl: string = DEFAULT_IMDB_DATASET_BASE_URL,
    ctx: AuditContext = {},
  ): Promise<DatasetDownloadReport> {
    const dirAbs = this.assertDir(datasetPath);
    await fs.mkdir(dirAbs, { recursive: true });

    // Normalise the base so relative filenames resolve under it.
    let base: URL;
    try {
      base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    } catch {
      throw new BadRequestException(`Invalid dataset base URL "${baseUrl}".`);
    }
    if (base.protocol !== 'https:' && base.protocol !== 'http:') {
      throw new BadRequestException('Dataset base URL must be an http(s) URL.');
    }

    this.emit(WS_EVENTS.IMDB_DATASET_DOWNLOAD_STARTED, { message: base.toString() });
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.imdb.dataset.download.started',
      objectType: 'imdb_dataset',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { baseUrl: base.toString(), datasetPath: dirAbs },
    });

    const files: DatasetDownloadFileReport[] = [];
    try {
      let done = 0;
      for (const spec of IMDB_DATASET_FILES) {
        const url = new URL(spec.file, base).toString();
        const dest = this.assertFile(dirAbs, spec.file);
        try {
          const bytes = await this.downloadFile(url, dest);
          files.push({ file: spec.file, ok: true, bytes });
        } catch (err) {
          files.push({ file: spec.file, ok: false, bytes: 0, error: (err as Error).message });
          this.logger.warn(`IMDb dataset download failed for ${spec.file}: ${(err as Error).message}`);
        }
        done += 1;
        this.emit(WS_EVENTS.IMDB_DATASET_DOWNLOAD_PROGRESS, {
          progress: Math.round((done / IMDB_DATASET_FILES.length) * 100),
          message: spec.file,
        });
      }
    } catch (err) {
      this.emit(WS_EVENTS.IMDB_DATASET_DOWNLOAD_FAILED, { error: (err as Error).message });
      await this.audit.record({
        userId: ctx.userId,
        action: 'media.imdb.dataset.download.failed',
        objectType: 'imdb_dataset',
        result: 'failure',
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        metadata: { error: (err as Error).message },
      });
      throw err;
    }

    const filesDownloaded = files.filter((f) => f.ok).length;
    if (filesDownloaded === 0) {
      const message = 'No dataset files could be downloaded.';
      this.emit(WS_EVENTS.IMDB_DATASET_DOWNLOAD_FAILED, { error: message });
      throw new BadRequestException(message);
    }

    this.emit(WS_EVENTS.IMDB_DATASET_DOWNLOAD_COMPLETED, {
      progress: 100,
      message: `${filesDownloaded}/${IMDB_DATASET_FILES.length}`,
    });
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.imdb.dataset.download.completed',
      objectType: 'imdb_dataset',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { filesDownloaded, total: IMDB_DATASET_FILES.length },
    });

    return { datasetPath: dirAbs, baseUrl: base.toString(), files, filesDownloaded };
  }

  /** Stream one remote file to a temp `.part`, then atomically rename it in. */
  private async downloadFile(url: string, dest: string): Promise<number> {
    const tmp = `${dest}.part`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp));
      await fs.rename(tmp, dest);
      const stat = await fs.stat(dest);
      return stat.size;
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // --- validation ----------------------------------------------------------

  /** Read only the header line of a `.gz` to check the TSV structure. */
  private async readHeader(absPath: string): Promise<string[] | null> {
    const rl = readline.createInterface({
      input: createReadStream(absPath).pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        return parseTsvLine(line);
      }
      return null;
    } finally {
      rl.close();
    }
  }

  async validate(
    datasetPath: string,
    ctx: AuditContext = {},
  ): Promise<DatasetValidationReport> {
    const dirAbs = this.assertDir(datasetPath);
    this.emit(WS_EVENTS.IMDB_DATASET_VALIDATE_STARTED, { message: datasetPath });
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.imdb.dataset.validate.started',
      objectType: 'imdb_dataset',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { datasetPath: dirAbs },
    });

    const files: DatasetFileReport[] = [];
    for (const spec of IMDB_DATASET_FILES) {
      const report: DatasetFileReport = {
        file: spec.file,
        key: spec.key,
        present: false,
        gzipOk: false,
        headerOk: false,
        sizeBytes: null,
      };
      try {
        const abs = this.assertFile(dirAbs, spec.file);
        const stat = await fs.stat(abs).catch(() => null);
        if (!stat || !stat.isFile()) {
          files.push(report);
          continue;
        }
        report.present = true;
        report.sizeBytes = Number(stat.size);
        const header = await this.readHeader(abs);
        report.gzipOk = header !== null;
        report.headerOk = header !== null && validateHeader(header, spec.header);
      } catch (err) {
        report.error = (err as Error).message;
      }
      files.push(report);
    }

    const filesFound = files.filter((f) => f.present).length;
    const titleBasics = files.find((f) => f.key === 'title.basics');
    const hasMinimum = Boolean(titleBasics?.present && titleBasics?.headerOk);
    const valid = hasMinimum && files.every((f) => !f.present || f.headerOk);

    const result: DatasetValidationReport = {
      datasetPath: dirAbs,
      valid,
      filesFound,
      files,
      hasMinimum,
    };

    this.emit(WS_EVENTS.IMDB_DATASET_VALIDATE_COMPLETED, {
      message: `${filesFound} file(s) found`,
      status: valid ? 'valid' : 'invalid',
    });
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.imdb.dataset.validate.completed',
      objectType: 'imdb_dataset',
      result: valid ? 'success' : 'failure',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { datasetPath: dirAbs, filesFound, valid },
    });
    return result;
  }

  // --- import (detached worker) -------------------------------------------

  /**
   * Create the import record and launch the streaming import as a detached
   * in-process job. Returns immediately so the HTTP request never blocks.
   */
  async startImport(datasetPath: string, ctx: AuditContext = {}) {
    const dirAbs = this.assertDir(datasetPath);
    // Single choke point: never run two imports at once. If one is already
    // queued/running, return it instead of spawning a concurrent worker (which
    // would contend on the same tables). Covers Import-now, Update-now, and the
    // scheduler alike.
    const active = await this.prisma.iMDbDatasetImport.findFirst({
      where: { status: { in: ['pending', 'running'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (active) {
      this.logger.log(`IMDb import already in progress (${active.id}); not starting another.`);
      return active;
    }
    const record = await this.prisma.iMDbDatasetImport.create({
      data: { status: 'pending', sourcePath: dirAbs },
    });
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.imdb.dataset.import.started',
      objectType: 'imdb_dataset_import',
      objectId: record.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { datasetPath: dirAbs },
    });
    // Detached — do NOT await; failures are recorded on the import row + WS.
    void this.runImport(record.id, dirAbs, ctx).catch((err) =>
      this.logger.error(`IMDb import ${record.id} crashed: ${(err as Error).message}`),
    );
    return record;
  }

  /**
   * Request cooperative cancellation of the in-progress import. Flags the active
   * run so the detached worker stops at its next file/batch boundary and marks
   * the row `cancelled`; work already committed (whole files, partial batches) is
   * kept — the resume design means a later re-run continues from there. Returns
   * the affected import row (still `running`/`pending` until the worker observes
   * the flag); throws if nothing is running.
   */
  async stopImport(ctx: AuditContext = {}) {
    const active = await this.prisma.iMDbDatasetImport.findFirst({
      where: { status: { in: ['pending', 'running'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!active) {
      throw new NotFoundException('No IMDb dataset import is currently running.');
    }
    this.cancelRequested.add(active.id);
    this.logger.log(`IMDb import ${active.id} — stop requested.`);
    this.emit(WS_EVENTS.IMDB_DATASET_IMPORT_PROGRESS, {
      id: active.id,
      status: 'stopping',
      message: 'stop requested',
      recordsImported: active.recordsImported,
    });
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.imdb.dataset.import.stop_requested',
      objectType: 'imdb_dataset_import',
      objectId: active.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { recordsImported: active.recordsImported },
    });
    return active;
  }

  /**
   * The detached worker body. Dispatches on the configured import strategy:
   * `optimized_movies` (default) runs the lean, filtered movie import; `full`
   * runs the legacy every-file import below. Isolated per-file; safe to re-run.
   */
  async runImport(importId: string, dirAbs: string, ctx: AuditContext = {}): Promise<void> {
    const settings = await this.settingsSvc.read();
    if (settings.importStrategy === 'optimized_movies') {
      // The optimized strategy owns its terminal state; it polls this flag at
      // batch/step boundaries and marks the row 'cancelled' if a stop is asked.
      try {
        await this.optimized.execute(importId, dirAbs, settings, ctx, () =>
          this.cancelRequested.has(importId),
        );
      } finally {
        this.cancelRequested.delete(importId);
      }
      return;
    }

    // --- legacy full import: import every present dataset file as-is ---------
    const existing = await this.prisma.iMDbDatasetImport.findUnique({
      where: { id: importId },
    });
    const alreadyDone = new Set<string>(
      Array.isArray(existing?.filesImported)
        ? (existing!.filesImported as unknown[]).map(String)
        : [],
    );
    let recordsImported = existing?.recordsImported ?? 0;

    await this.prisma.iMDbDatasetImport.update({
      where: { id: importId },
      data: { status: 'running', startedAt: existing?.startedAt ?? new Date() },
    });

    const present = IMDB_DATASET_FILES.filter((spec) => {
      try {
        return Boolean(this.assertFile(dirAbs, spec.file));
      } catch {
        return false;
      }
    });

    const shouldCancel = () => this.cancelRequested.has(importId);

    let failure: string | null = null;
    let cancelled = false;
    let processed = 0;
    for (const spec of IMDB_DATASET_FILES) {
      if (shouldCancel()) {
        cancelled = true;
        break;
      }
      processed += 1;
      if (alreadyDone.has(spec.key)) continue;
      const abs = this.assertFile(dirAbs, spec.file);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) continue; // optional file absent — skip cleanly.

      try {
        const count = await this.importFile(spec, abs, shouldCancel);
        recordsImported += count;
        alreadyDone.add(spec.key);
        await this.prisma.iMDbDatasetImport.update({
          where: { id: importId },
          data: {
            filesImported: Array.from(alreadyDone),
            recordsImported,
            datasetDate: existing?.datasetDate ?? stat.mtime,
          },
        });
        this.emit(WS_EVENTS.IMDB_DATASET_IMPORT_PROGRESS, {
          id: importId,
          status: 'running',
          progress: Math.round((processed / IMDB_DATASET_FILES.length) * 100),
          message: spec.key,
          recordsImported,
          filesImported: Array.from(alreadyDone),
        });
      } catch (err) {
        if (err instanceof ImportCancelledError) {
          cancelled = true;
          break;
        }
        // Per-file failure: record it but continue with the remaining files.
        failure = `${spec.key}: ${(err as Error).message}`;
        this.logger.warn(`IMDb import ${importId} — ${failure}`);
      }
    }

    if (cancelled) {
      this.cancelRequested.delete(importId);
      await this.prisma.iMDbDatasetImport.update({
        where: { id: importId },
        data: { status: 'cancelled', completedAt: new Date(), recordsImported },
      });
      this.emit(WS_EVENTS.IMDB_DATASET_IMPORT_CANCELLED, {
        id: importId,
        status: 'cancelled',
        recordsImported,
        filesImported: Array.from(alreadyDone),
      });
      await this.audit.record({
        userId: ctx.userId,
        action: 'media.imdb.dataset.import.cancelled',
        objectType: 'imdb_dataset_import',
        objectId: importId,
        metadata: { recordsImported, filesImported: Array.from(alreadyDone) },
      });
      this.logger.log(`IMDb import ${importId} stopped by user (${recordsImported} records kept).`);
      return;
    }

    if (failure) {
      this.cancelRequested.delete(importId);
      await this.prisma.iMDbDatasetImport.update({
        where: { id: importId },
        data: { status: 'failed', failedAt: new Date(), errorMessage: failure, recordsImported },
      });
      this.emit(WS_EVENTS.IMDB_DATASET_IMPORT_FAILED, {
        id: importId,
        status: 'failed',
        error: failure,
        recordsImported,
      });
      await this.audit.record({
        userId: ctx.userId,
        action: 'media.imdb.dataset.import.failed',
        objectType: 'imdb_dataset_import',
        objectId: importId,
        result: 'failure',
        metadata: { error: failure, recordsImported },
      });
      return;
    }

    this.cancelRequested.delete(importId);
    await this.prisma.iMDbDatasetImport.update({
      where: { id: importId },
      data: { status: 'completed', completedAt: new Date(), recordsImported },
    });
    this.emit(WS_EVENTS.IMDB_DATASET_IMPORT_COMPLETED, {
      id: importId,
      status: 'completed',
      progress: 100,
      recordsImported,
      filesImported: Array.from(alreadyDone),
    });
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.imdb.dataset.import.completed',
      objectType: 'imdb_dataset_import',
      objectId: importId,
      metadata: { recordsImported, filesImported: Array.from(alreadyDone), presentFiles: present.length },
    });
  }

  /**
   * Stream a single `.gz` dataset file into its table in bounded batches.
   * Returns the number of rows imported. Never loads the whole file.
   */
  async importFile(
    spec: DatasetFileSpec,
    absPath: string,
    shouldCancel: () => boolean = () => false,
  ): Promise<number> {
    let batch: any[] = [];
    let imported = 0;
    let header: string[] | null = null;

    const flush = async () => {
      if (batch.length === 0) return;
      await this.writeBatch(spec.key, batch);
      imported += batch.length;
      batch = [];
    };

    const rl = readline.createInterface({
      input: createReadStream(absPath).pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        if (!line) continue;
        const fields = parseTsvLine(line);
        if (!header) {
          header = fields;
          if (!validateHeader(header, spec.header)) {
            throw new BadRequestException(
              `Unexpected header for ${spec.file}: got [${header.slice(0, spec.header.length).join(', ')}]`,
            );
          }
          continue;
        }
        const row = this.mapRow(spec.key, fields);
        if (row) batch.push(row);
        if (batch.length >= BATCH_SIZE) {
          await flush();
          // Cooperative stop point: bail after committing the batch so a huge
          // file (title.principals ~90M rows) cancels within one batch.
          if (shouldCancel()) throw new ImportCancelledError();
        }
      }
      await flush();
    } finally {
      rl.close();
    }
    return imported;
  }

  /** Map a parsed line to the right Prisma create input for the file's table. */
  private mapRow(key: string, fields: string[]): any | null {
    switch (key) {
      case 'title.basics':
        return mapTitleRow(fields);
      case 'name.basics':
        return mapPersonRow(fields);
      case 'title.akas':
        return mapAkaRow(fields);
      case 'title.crew':
        return mapCrewRow(fields);
      case 'title.episode':
        return mapEpisodeRow(fields);
      case 'title.principals':
        return mapPrincipalRow(fields);
      case 'title.ratings':
        return mapRatingRow(fields);
      default:
        return null;
    }
  }

  /** Insert a batch. Unique-keyed tables skip duplicates → re-run safe. */
  private async writeBatch(key: string, rows: any[]): Promise<void> {
    switch (key) {
      case 'title.basics':
        await this.prisma.iMDbTitle.createMany({ data: rows, skipDuplicates: true });
        return;
      case 'name.basics':
        await this.prisma.iMDbPerson.createMany({ data: rows, skipDuplicates: true });
        return;
      case 'title.akas':
        await this.prisma.iMDbAka.createMany({ data: rows, skipDuplicates: true });
        return;
      case 'title.crew':
        await this.prisma.iMDbCrew.createMany({ data: rows, skipDuplicates: true });
        return;
      case 'title.episode':
        await this.prisma.iMDbEpisode.createMany({ data: rows, skipDuplicates: true });
        return;
      case 'title.principals':
        await this.prisma.iMDbPrincipal.createMany({ data: rows });
        return;
      case 'title.ratings':
        await this.prisma.iMDbRating.createMany({ data: rows, skipDuplicates: true });
        return;
    }
  }
}
