import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import * as path from 'node:path';
import type { Prisma } from '@prisma/client';
import type { NormalizedTorrent } from '@ultratorrent/shared';
import { WS_EVENTS } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../../settings/settings.module';
import { FilePathService } from '../../files/file-path.service';
import { AuditService } from '../../audit/audit.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { AutomationEngine } from '../../automation/automation.module';
import type { AuditContext } from '../media-metadata.service';
import { ImdbSettingsService, ImdbSettingsPatch } from './imdb-settings.service';
import { ImdbDatasetImporterService } from './imdb-dataset-importer.service';
import {
  ImdbMetadataProvider,
  ImdbSearchQuery,
} from './imdb-metadata.provider';

/** Well-formed IMDb title id: `tt` followed by digits. */
export function isValidImdbId(id: string): boolean {
  return /^tt\d{5,10}$/.test(id);
}

export interface ImdbMatchDto {
  imdbId: string;
  confidence?: number;
}

/**
 * Orchestrates the IMDb provider: status, settings (root-checked datasetPath +
 * encrypted key), dataset validate/import delegation, search/lookup, manual
 * matching, and cross-provider enrichment. Ties together the settings service,
 * the streaming importer, and the metadata provider. Never logs secrets.
 */
@Injectable()
export class ImdbService implements OnModuleInit {
  private readonly logger = new Logger(ImdbService.name);
  /** In-memory guard against overlapping download+import runs (per process). */
  private datasetUpdateInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsSvc: ImdbSettingsService,
    private readonly importer: ImdbDatasetImporterService,
    private readonly filePath: FilePathService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly settings: SettingsService,
    // AutomationEngine lives in AutomationModule, which imports MediaService /
    // MediaAutomationActions back from this module — a module cycle. Resolve it
    // lazily via ModuleRef so it isn't needed at construction time (it's only
    // used for a fire-and-forget trigger), which breaks the bootstrap cycle.
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * A detached import worker cannot survive a process restart, so any import row
   * still marked running/pending at boot is orphaned — fail it so it doesn't
   * block future runs (the concurrency guard treats such rows as active).
   */
  async onModuleInit(): Promise<void> {
    const stale = await this.prisma.iMDbDatasetImport
      .updateMany({
        where: { status: { in: ['pending', 'running'] } },
        data: { status: 'failed', failedAt: new Date(), errorMessage: 'Interrupted by a server restart.' },
      })
      .catch(() => ({ count: 0 }));
    if (stale.count > 0) {
      this.logger.warn(`Marked ${stale.count} interrupted IMDb import(s) as failed on startup.`);
    }
  }

  /** True while a dataset import is queued/running (guards concurrent updates). */
  private async activeImportExists(): Promise<boolean> {
    const active = await this.prisma.iMDbDatasetImport.findFirst({
      where: { status: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    return Boolean(active);
  }

  /** Build a provider bound to the current settings. */
  private async provider(): Promise<ImdbMetadataProvider> {
    const settings = await this.settingsSvc.read();
    return new ImdbMetadataProvider(this.prisma, settings);
  }

  // --- status / settings ---------------------------------------------------

  async status() {
    const provider = await this.provider();
    const [health, lastImport, titleCount] = await Promise.all([
      provider.healthCheck(),
      this.prisma.iMDbDatasetImport.findFirst({ orderBy: { createdAt: 'desc' } }),
      this.prisma.iMDbTitle.count(),
    ]);
    return {
      ...health,
      capabilities: provider.providerCapabilities(),
      datasetTitleCount: titleCount,
      lastImport: lastImport
        ? {
            id: lastImport.id,
            status: lastImport.status,
            recordsImported: lastImport.recordsImported,
            completedAt: lastImport.completedAt,
            datasetDate: lastImport.datasetDate,
          }
        : null,
    };
  }

  getSettings() {
    return this.settingsSvc.readRedacted();
  }

  async updateSettings(patch: ImdbSettingsPatch, ctx: AuditContext = {}) {
    // Root-check the dataset path BEFORE persisting (defense: never store an
    // out-of-bounds path). An explicit clear (null/'') is allowed.
    if (patch.datasetPath != null && patch.datasetPath !== '') {
      const abs = this.filePath.assertWithinHardRoots(patch.datasetPath);
      patch = { ...patch, datasetPath: abs };
      await this.audit.record({
        userId: ctx.userId,
        action: 'media.imdb.dataset_path.changed',
        objectType: 'imdb_settings',
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        metadata: { datasetPath: abs },
      });
    }
    const result = await this.settingsSvc.update(patch);
    // Audit safe metadata only — NEVER the API key.
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.imdb.settings.changed',
      objectType: 'imdb_settings',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: {
        mode: result.mode,
        hasApiKey: result.hasApiKey,
        apiBaseUrl: result.apiBaseUrl,
        includeAdult: result.includeAdult,
        minVotes: result.minVotes,
      },
    });
    return result;
  }

  /** Test the configured official/licensed API connection (safe metadata only). */
  async testApiConnection(ctx: AuditContext = {}) {
    const provider = await this.provider();
    const health = await provider.healthCheck();
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.imdb.official_api.tested',
      objectType: 'imdb_settings',
      result: health.apiConfigured ? 'success' : 'failure',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { apiConfigured: health.apiConfigured, available: health.available },
    });
    return { apiConfigured: health.apiConfigured, available: health.available };
  }

  // --- dataset validate / import -------------------------------------------

  validateDataset(datasetPath: string, ctx: AuditContext = {}) {
    return this.importer.validate(datasetPath, ctx);
  }

  importDataset(datasetPath: string, ctx: AuditContext = {}) {
    return this.importer.startImport(datasetPath, ctx);
  }

  listImports() {
    return this.prisma.iMDbDatasetImport.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /** Timestamp of the most recent dataset import attempt (for the scheduler). */
  async latestImportAt(): Promise<Date | null> {
    const last = await this.prisma.iMDbDatasetImport.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return last?.createdAt ?? null;
  }

  /**
   * The directory downloads land in / imports read from. Uses the configured
   * `datasetPath` when set; otherwise falls back to a managed location under the
   * first storage root and persists it, so auto-download works out of the box
   * without the operator pre-picking a folder (the path is a *destination* for
   * the download, not a pre-existing source).
   */
  private async resolveDatasetDir(): Promise<string> {
    const s = await this.settingsSvc.read();
    if (s.datasetPath) return s.datasetPath;
    const root = this.filePath.hardRoots[0];
    if (!root) {
      throw new BadRequestException(
        'No storage root is configured. Set FILE_MANAGER_ROOTS or an IMDb dataset path first.',
      );
    }
    const dir = this.filePath.assertWithinHardRoots(
      path.join(root, '.ultratorrent', 'imdb-datasets'),
    );
    // Persist the default so the rest of the UI (validate/import/history) points here.
    await this.settingsSvc.update({ datasetPath: dir });
    return dir;
  }

  /**
   * Download the datasets then (re)import them. Awaitable — used by the
   * scheduler so it can track completion; the import itself runs detached.
   */
  async runDatasetUpdate(ctx: AuditContext = {}): Promise<void> {
    // Serialise: never run two download+import cycles at once. The flag is set
    // synchronously (before any await) so racing callers can't both pass; the
    // DB check additionally rejects an import already running from elsewhere.
    if (this.datasetUpdateInFlight) return;
    this.datasetUpdateInFlight = true;
    try {
      if (await this.activeImportExists()) {
        this.logger.log('IMDb dataset update skipped — an import is already in progress.');
        return;
      }
      const dir = await this.resolveDatasetDir();
      const s = await this.settingsSvc.read();
      await this.importer.downloadDataset(dir, s.datasetBaseUrl, ctx);
      await this.importer.startImport(dir, ctx);
    } finally {
      // Cleared once the import row exists (startImport returned); the import
      // continues detached and the DB 'running' row now guards re-entry.
      this.datasetUpdateInFlight = false;
    }
  }

  /**
   * Manual "update now": kick off a download + import in the background and
   * return immediately so the HTTP request never blocks on the large transfer.
   * Progress streams over the imdb.dataset.download.* / import.* WS events.
   */
  async triggerDatasetUpdate(
    ctx: AuditContext = {},
  ): Promise<{ started: boolean; datasetPath: string | null }> {
    // Reject a duplicate click while a download/import is already in flight.
    if (this.datasetUpdateInFlight || (await this.activeImportExists())) {
      return { started: false, datasetPath: null };
    }
    // Resolve (and persist a default) up front so a misconfiguration surfaces
    // synchronously to the caller instead of only in the detached job.
    const datasetPath = await this.resolveDatasetDir();
    void this.runDatasetUpdate(ctx).catch((err) =>
      this.logger.error(`IMDb dataset update failed: ${(err as Error).message}`),
    );
    return { started: true, datasetPath };
  }

  // --- search / lookup -----------------------------------------------------

  async search(query: ImdbSearchQuery) {
    const provider = await this.provider();
    return provider.searchTitle(query);
  }

  async getTitle(imdbId: string) {
    if (!isValidImdbId(imdbId)) throw new BadRequestException('Invalid IMDb id.');
    const provider = await this.provider();
    const details = await provider.getTitleById(imdbId);
    if (!details) throw new NotFoundException('IMDb title not found.');
    return { ...details, imdbUrl: ImdbMetadataProvider.imdbUrl(imdbId) };
  }

  // --- manual match --------------------------------------------------------

  async matchItem(itemId: string, dto: ImdbMatchDto, ctx: AuditContext = {}) {
    if (!dto?.imdbId || !isValidImdbId(dto.imdbId)) {
      throw new BadRequestException('A valid IMDb id (tt…) is required.');
    }
    const item = await this.prisma.mediaItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Item not found');

    const provider = await this.provider();
    const [details, ratings] = await Promise.all([
      provider.getTitleById(dto.imdbId),
      provider.getRatings(dto.imdbId),
    ]);

    // Store the IMDb external id (used for cross-provider lookup + links).
    await this.prisma.mediaExternalId.upsert({
      where: { itemId_provider: { itemId, provider: 'imdb' } },
      create: {
        itemId,
        provider: 'imdb',
        externalId: dto.imdbId,
        url: ImdbMetadataProvider.imdbUrl(dto.imdbId),
      },
      update: {
        externalId: dto.imdbId,
        url: ImdbMetadataProvider.imdbUrl(dto.imdbId),
      },
    });

    // Update item metadata + rating from IMDb (rating is a rating source only).
    const rating = ratings?.averageRating ?? details?.rating ?? null;
    if (details) {
      const data: Prisma.MediaMetadataUncheckedUpdateInput &
        Prisma.MediaMetadataUncheckedCreateInput = {
        itemId,
        title: details.title ?? item.title,
        originalTitle: details.originalTitle ?? null,
        year: details.year ?? item.year ?? null,
        runtime: details.runtime ?? null,
        genres: (details.genres ?? []) as Prisma.InputJsonValue,
        directors: (details.directors ?? []) as Prisma.InputJsonValue,
        writers: (details.writers ?? []) as Prisma.InputJsonValue,
        rating,
        providerName: 'imdb',
      };
      await this.prisma.mediaMetadata.upsert({
        where: { itemId },
        create: data,
        update: data,
      });
    } else if (rating !== null) {
      await this.prisma.mediaMetadata.upsert({
        where: { itemId },
        create: { itemId, title: item.title, rating, providerName: 'imdb' },
        update: { rating },
      });
    }

    const confidence =
      typeof dto.confidence === 'number'
        ? Math.max(0, Math.min(1, dto.confidence))
        : 1;
    const updated = await this.prisma.mediaItem.update({
      where: { id: itemId },
      data: {
        matchStatus: 'manual',
        confidence,
        title: details?.title ?? item.title,
        year: details?.year ?? item.year,
      },
    });

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.imdb.match.applied',
      objectType: 'media_item',
      objectId: itemId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { imdbId: dto.imdbId, confidence, rating },
    });

    this.realtime.broadcast(WS_EVENTS.IMDB_MATCH_COMPLETED, {
      itemId,
      imdbId: dto.imdbId,
      status: 'matched',
      at: new Date().toISOString(),
    });

    // Fire the media.matched automation trigger (best-effort; no torrent context).
    this.fireMatched(item.title);

    // Cross-provider enrichment (TMDB/OMDb by IMDb id) — best-effort.
    await this.enrichCrossProvider(itemId, dto.imdbId, ctx).catch((err) =>
      this.logger.warn(`Cross-provider enrichment failed: ${(err as Error).message}`),
    );

    return { item: updated, imdbId: dto.imdbId, rating, matched: Boolean(details) };
  }

  private fireMatched(title: string): void {
    const context = { name: title } as unknown as NormalizedTorrent;
    this.moduleRef
      .get(AutomationEngine, { strict: false })
      .evaluate('media.matched', context)
      .catch((err) =>
        this.logger.warn(`media.matched trigger failed: ${(err as Error).message}`),
      );
  }

  // --- cross-provider enrichment -------------------------------------------

  /**
   * When an item carries an IMDb external id and TMDB/OMDb are configured,
   * resolve their ids by IMDb id, store the cross-provider external ids, and use
   * the IMDb rating (only) as a rating source. Emits `imdb.enrichment.completed`.
   *
   * These call TMDB (`/find`) and OMDb — separate licensed APIs — NOT imdb.com.
   */
  async enrichCrossProvider(
    itemId: string,
    imdbId: string,
    ctx: AuditContext = {},
  ): Promise<{ tmdb?: string; omdbRating?: number } | null> {
    if (!isValidImdbId(imdbId)) return null;
    const tmdbKey =
      (await this.settings.get<string>('media.tmdbApiKey')) ?? process.env.TMDB_API_KEY;
    const omdbKey =
      (await this.settings.get<string>('media.omdbApiKey')) ?? process.env.OMDB_API_KEY;
    if (!tmdbKey && !omdbKey) return null;

    const result: { tmdb?: string; omdbRating?: number } = {};

    if (tmdbKey) {
      const found = await this.tmdbFindByImdb(imdbId, tmdbKey);
      if (found) {
        result.tmdb = found;
        await this.storeExternalId(itemId, 'tmdb', found, null);
      }
    }

    // IMDb rating as a rating source only (never artwork). Prefer our dataset.
    const provider = await this.provider();
    let rating = (await provider.getRatings(imdbId))?.averageRating ?? null;
    if (rating === null && omdbKey) {
      const omdb = await this.omdbByImdb(imdbId, omdbKey);
      if (omdb?.rating != null) {
        rating = omdb.rating;
        result.omdbRating = omdb.rating;
      }
    }
    if (rating !== null) {
      await this.prisma.mediaMetadata
        .update({ where: { itemId }, data: { rating } })
        .catch(() => undefined);
    }

    this.realtime.broadcast(WS_EVENTS.IMDB_ENRICHMENT_COMPLETED, {
      itemId,
      imdbId,
      status: 'completed',
      at: new Date().toISOString(),
    });
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.imdb.enrichment.completed',
      objectType: 'media_item',
      objectId: itemId,
      metadata: { imdbId, tmdb: result.tmdb ?? null, ratingApplied: rating !== null },
    });
    return result;
  }

  private async storeExternalId(
    itemId: string,
    provider: string,
    externalId: string,
    url: string | null,
  ): Promise<void> {
    await this.prisma.mediaExternalId
      .upsert({
        where: { itemId_provider: { itemId, provider } },
        create: { itemId, provider, externalId, url },
        update: { externalId },
      })
      .catch(() => undefined);
  }

  private async tmdbFindByImdb(imdbId: string, key: string): Promise<string | null> {
    const url = new URL(`https://api.themoviedb.org/3/find/${imdbId}`);
    url.searchParams.set('api_key', key);
    url.searchParams.set('external_source', 'imdb_id');
    const data = await safeJson(url);
    const hit = data?.movie_results?.[0] ?? data?.tv_results?.[0];
    return hit?.id != null ? String(hit.id) : null;
  }

  private async omdbByImdb(
    imdbId: string,
    key: string,
  ): Promise<{ rating: number | null } | null> {
    const url = new URL('https://www.omdbapi.com/');
    url.searchParams.set('i', imdbId);
    url.searchParams.set('apikey', key);
    const data = await safeJson(url);
    if (!data || data.Response === 'False') return null;
    const r = Number.parseFloat(data.imdbRating);
    return { rating: Number.isFinite(r) ? r : null };
  }
}

/** GET JSON with an 8s timeout; null on any error. Never throws. */
async function safeJson(url: URL): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
