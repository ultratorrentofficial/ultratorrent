import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { PERMISSIONS } from '@ultratorrent/shared';
import { ImdbService, ImdbMatchDto } from './imdb/imdb.service';
import { ImdbSettingsPatch } from './imdb/imdb-settings.service';
import type { ImdbTitleKind } from './imdb/imdb-match';
import { MediaService, RenameRequest } from './media.service';
import type { CleanupRules } from './media-renamer';
import { MediaLibraryService, LibraryInput } from './media-library.service';
import { MediaScannerService } from './media-scanner.service';
import {
  MediaIdentificationService,
  ManualMatchDto,
} from './media-identification.service';
import { MediaItemService, ItemUpdateDto } from './media-item.service';
import { MediaHealthService } from './media-health.service';
import {
  MediaMetadataService,
  MetadataUpdateDto,
  AuditContext,
} from './media-metadata.service';
import { MediaArtworkService, ArtworkUpload } from './media-artwork.service';
import { MediaSubtitleService } from './media-subtitle.service';
import { MediaNfoService } from './media-nfo.service';
import { MediaDuplicateService } from './media-duplicate.service';
import {
  MediaServerIntegrationService,
  IntegrationInput,
} from './media-server-integration.service';
import { MediaProcessingQueueService } from './media-processing-queue.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

const P = PERMISSIONS;

/** Build an audit context (user + request metadata) from the request. */
function auditCtx(req: Request): AuditContext {
  const user = req.user as AuthenticatedUser | undefined;
  return {
    userId: user?.id,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  };
}

@ApiTags('media')
@ApiBearerAuth()
@Controller('media')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly libraries: MediaLibraryService,
    private readonly scanner: MediaScannerService,
    private readonly identification: MediaIdentificationService,
    private readonly items: MediaItemService,
    private readonly healthSvc: MediaHealthService,
    private readonly metadata: MediaMetadataService,
    private readonly artwork: MediaArtworkService,
    private readonly subtitles: MediaSubtitleService,
    private readonly nfo: MediaNfoService,
    private readonly duplicates: MediaDuplicateService,
    private readonly integrations: MediaServerIntegrationService,
    private readonly jobs: MediaProcessingQueueService,
    private readonly imdb: ImdbService,
  ) {}

  // --- overview ----------------------------------------------------------
  @Get('dashboard')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  dashboard() {
    return this.healthSvc.dashboard();
  }

  @Get('health')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  health() {
    return this.healthSvc.health();
  }

  // --- libraries ---------------------------------------------------------
  @Get('libraries')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  listLibraries() {
    return this.libraries.list();
  }

  @Post('libraries')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_LIBRARIES)
  createLibrary(@Body() body: LibraryInput) {
    return this.libraries.create(body ?? {});
  }

  @Patch('libraries/:id')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_LIBRARIES)
  updateLibrary(@Param('id') id: string, @Body() body: LibraryInput) {
    return this.libraries.update(id, body ?? {});
  }

  @Delete('libraries/:id')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_LIBRARIES)
  removeLibrary(@Param('id') id: string) {
    return this.libraries.remove(id);
  }

  @Post('libraries/:id/scan')
  @RequirePermissions(P.MEDIA_MANAGER_SCAN)
  scanLibrary(@Param('id') id: string) {
    // Tracked as a MediaProcessingJob; the scanner streams progress + a per-file
    // action log over the media_manager.job.progress WS event.
    return this.jobs.run('library_scan', { libraryId: id }, (report) =>
      this.scanner.scanLibrary(id, report),
    );
  }

  // --- items -------------------------------------------------------------
  @Get('items')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  listItems(
    @Query('mediaType') mediaType?: string,
    @Query('matchStatus') matchStatus?: string,
    @Query('libraryId') libraryId?: string,
    @Query('search') search?: string,
    @Query('title') title?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.items.list({
      mediaType,
      matchStatus,
      libraryId,
      search,
      title,
      page: page ? Number.parseInt(page, 10) : undefined,
      pageSize: pageSize ? Number.parseInt(pageSize, 10) : undefined,
    });
  }

  /** Paginated TV browser: episodes grouped by show (collapsible Show → Season → Episode). */
  @Get('series')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  listSeries(
    @Query('mediaType') mediaType?: string,
    @Query('matchStatus') matchStatus?: string,
    @Query('libraryId') libraryId?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.items.series({
      mediaType,
      matchStatus,
      libraryId,
      search,
      page: page ? Number.parseInt(page, 10) : undefined,
      pageSize: pageSize ? Number.parseInt(pageSize, 10) : undefined,
    });
  }

  /** One show's episodes, grouped into seasons — the browser's lazy drill-down. */
  @Get('series/episodes')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  seriesEpisodes(
    @Query('key') key: string,
    @Query('matchStatus') matchStatus?: string,
    @Query('libraryId') libraryId?: string,
  ) {
    return this.items.episodesForSeries(key, { matchStatus, libraryId });
  }

  @Get('items/:id')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  getItem(@Param('id') id: string) {
    return this.items.get(id);
  }

  @Patch('items/:id')
  @RequirePermissions(P.MEDIA_MANAGER_EDIT_METADATA)
  updateItem(@Param('id') id: string, @Body() body: ItemUpdateDto) {
    return this.items.update(id, body ?? {});
  }

  @Post('items/reidentify')
  @RequirePermissions(P.MEDIA_MANAGER_MATCH)
  reidentifyItems(@Body() body: { libraryId?: string; matchStatus?: string }) {
    // Bulk re-run of automatic identification (e.g. to recover a library that
    // scanned as unmatched). Tracked as a media_identification job with WS
    // progress. Omitting matchStatus re-identifies all non-manual items; pass
    // matchStatus: 'unmatched' to retry only the failures.
    const filter = {
      libraryId: body?.libraryId,
      matchStatus: body?.matchStatus,
    };
    return this.jobs.run(
      'media_identification',
      { libraryId: filter.libraryId ?? null, payload: filter },
      (report) => this.identification.identifyBulk(filter, report),
    );
  }

  @Post('items/:id/match')
  @RequirePermissions(P.MEDIA_MANAGER_MATCH)
  matchItem(@Param('id') id: string, @Body() body: ManualMatchDto) {
    // A body identifies manually; an empty body re-runs automatic identification.
    if (body && Object.keys(body).length > 0) {
      return this.identification.matchManually(id, body);
    }
    return this.identification.identify(id);
  }

  @Post('items/:id/unmatch')
  @RequirePermissions(P.MEDIA_MANAGER_MATCH)
  unmatchItem(@Param('id') id: string) {
    return this.identification.unmatch(id);
  }

  // --- metadata ----------------------------------------------------------
  @Post('items/:id/metadata/fetch')
  @RequirePermissions(P.MEDIA_MANAGER_EDIT_METADATA)
  fetchMetadata(@Param('id') id: string, @Req() req: Request) {
    return this.metadata.fetchMetadata(id, auditCtx(req));
  }

  @Patch('items/:id/metadata')
  @RequirePermissions(P.MEDIA_MANAGER_EDIT_METADATA)
  updateMetadata(
    @Param('id') id: string,
    @Body() body: MetadataUpdateDto,
    @Req() req: Request,
  ) {
    return this.metadata.updateMetadata(id, body ?? {}, auditCtx(req));
  }

  // --- artwork -----------------------------------------------------------
  @Get('items/:id/artwork')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  listArtwork(@Param('id') id: string) {
    return this.artwork.list(id);
  }

  @Post('items/:id/artwork/select')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_ARTWORK)
  selectArtwork(
    @Param('id') id: string,
    @Body() body: { artworkId: string },
    @Req() req: Request,
  ) {
    return this.artwork.select(id, body?.artworkId, auditCtx(req));
  }

  @Post('items/:id/artwork/upload')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_ARTWORK)
  uploadArtwork(
    @Param('id') id: string,
    @Body() body: ArtworkUpload,
    @Req() req: Request,
  ) {
    return this.artwork.uploadCustom(id, body, auditCtx(req));
  }

  @Post('items/:id/artwork/import')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_ARTWORK)
  importArtwork(@Param('id') id: string, @Req() req: Request) {
    const ctx = auditCtx(req);
    // Tracked as a MediaProcessingJob (WS progress) — same path the
    // media_fetch_artwork automation action takes. Falls back to reporting the
    // gap when no provider key / external id is configured.
    return this.jobs.run('artwork_fetch', { itemId: id }, () =>
      this.artwork.importFromProvider(id, ctx),
    );
  }

  @Get('items/:id/artwork/missing')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  missingArtwork(@Param('id') id: string) {
    return this.artwork.detectMissing(id);
  }

  /**
   * Stream a locally-stored artwork image (custom uploads + on-disk provider
   * imports) so the browser can render it — filesystem paths aren't reachable
   * from an <img> tag. Remote-only artwork is loaded directly from its url.
   */
  @Get('artwork/:artworkId/image')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  async artworkImage(
    @Param('artworkId') artworkId: string,
    @Res({ passthrough: true }) res: Response,
    @Query('thumb') thumb?: string,
  ): Promise<StreamableFile> {
    // `?thumb=1` serves a small cached WebP thumbnail for fast grid rendering;
    // otherwise the full-size original.
    const { stream, contentType, size } = thumb
      ? await this.artwork.thumbnail(artworkId)
      : await this.artwork.readImage(artworkId);
    res.set({
      'Content-Type': contentType,
      'Content-Length': String(size),
      'Cache-Control': 'private, max-age=86400',
    });
    return new StreamableFile(stream);
  }

  // --- subtitles ---------------------------------------------------------
  @Get('items/:id/subtitles')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  listSubtitles(@Param('id') id: string) {
    return this.subtitles.list(id);
  }

  @Post('items/:id/subtitles/scan')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_SUBTITLES)
  scanSubtitles(@Param('id') id: string) {
    return this.subtitles.scan(id);
  }

  @Get('items/:id/subtitles/missing')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  missingSubtitles(
    @Param('id') id: string,
    @Query('preferred') preferred?: string,
  ) {
    const langs = preferred ? preferred.split(',').map((l) => l.trim()) : undefined;
    return this.subtitles.detectMissing(id, langs);
  }

  // --- NFO ---------------------------------------------------------------
  @Post('nfo/generate')
  @RequirePermissions(P.MEDIA_MANAGER_GENERATE_NFO)
  generateNfo(
    @Body() body: { itemId?: string; libraryId?: string },
    @Req() req: Request,
  ) {
    return this.nfo.generate(body ?? {}, auditCtx(req));
  }

  // --- duplicates --------------------------------------------------------
  @Get('duplicates')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  listDuplicates(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.duplicates.list(page, pageSize);
  }

  @Post('duplicates/detect')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  detectDuplicates() {
    return this.duplicates.detect();
  }

  // --- media-server integrations ----------------------------------------
  @Get('server-integrations')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_INTEGRATIONS)
  listIntegrations() {
    return this.integrations.list();
  }

  @Post('server-integrations')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_INTEGRATIONS)
  createIntegration(@Body() body: IntegrationInput, @Req() req: Request) {
    return this.integrations.create(body ?? {}, auditCtx(req));
  }

  @Patch('server-integrations/:id')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_INTEGRATIONS)
  updateIntegration(
    @Param('id') id: string,
    @Body() body: IntegrationInput,
    @Req() req: Request,
  ) {
    return this.integrations.update(id, body ?? {}, auditCtx(req));
  }

  @Delete('server-integrations/:id')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_INTEGRATIONS)
  removeIntegration(@Param('id') id: string, @Req() req: Request) {
    return this.integrations.remove(id, auditCtx(req));
  }

  @Post('server-integrations/:id/test')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_INTEGRATIONS)
  testIntegration(@Param('id') id: string, @Req() req: Request) {
    return this.integrations.test(id, auditCtx(req));
  }

  @Post('server-integrations/:id/refresh')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_INTEGRATIONS)
  refreshIntegration(@Param('id') id: string, @Req() req: Request) {
    return this.integrations.refresh(id, auditCtx(req));
  }

  // --- TMDB metadata provider -------------------------------------------
  @Post('providers/tmdb/test')
  @RequirePermissions(P.SETTINGS_MANAGE)
  testTmdbApi(@Body() body: { apiKey?: string }, @Req() req: Request) {
    return this.media.testTmdbKey(body?.apiKey, auditCtx(req));
  }

  // --- IMDb metadata provider -------------------------------------------
  @Get('providers/imdb/status')
  @RequirePermissions(P.MEDIA_MANAGER_IMDB_VIEW)
  imdbStatus() {
    return this.imdb.status();
  }

  @Get('providers/imdb/settings')
  @RequirePermissions(P.MEDIA_MANAGER_IMDB_VIEW)
  imdbSettings() {
    return this.imdb.getSettings();
  }

  @Patch('providers/imdb/settings')
  @RequirePermissions(P.MEDIA_MANAGER_IMDB_CONFIGURE)
  updateImdbSettings(@Body() body: ImdbSettingsPatch, @Req() req: Request) {
    return this.imdb.updateSettings(body ?? {}, auditCtx(req));
  }

  @Post('providers/imdb/test')
  @RequirePermissions(P.MEDIA_MANAGER_IMDB_CONFIGURE)
  testImdbApi(@Req() req: Request) {
    return this.imdb.testApiConnection(auditCtx(req));
  }

  @Post('providers/imdb/dataset/validate')
  @RequirePermissions(P.MEDIA_MANAGER_IMDB_IMPORT_DATASET)
  validateImdbDataset(@Body() body: { datasetPath?: string }, @Req() req: Request) {
    return this.imdb.validateDataset(body?.datasetPath ?? '', auditCtx(req));
  }

  @Post('providers/imdb/dataset/import')
  @RequirePermissions(P.MEDIA_MANAGER_IMDB_IMPORT_DATASET)
  importImdbDataset(@Body() body: { datasetPath?: string }, @Req() req: Request) {
    // Returns the import record immediately; the import runs as a detached job.
    return this.imdb.importDataset(body?.datasetPath ?? '', auditCtx(req));
  }

  @Post('providers/imdb/dataset/import/stop')
  @RequirePermissions(P.MEDIA_MANAGER_IMDB_IMPORT_DATASET)
  stopImdbImport(@Req() req: Request) {
    // Cooperative stop; 404 if nothing is running. The worker flips the row to
    // 'cancelled' once it observes the flag (streamed over imdb.*.cancelled WS).
    return this.imdb.stopImport(auditCtx(req));
  }

  @Post('providers/imdb/dataset/update-now')
  @RequirePermissions(P.MEDIA_MANAGER_IMDB_IMPORT_DATASET)
  updateImdbDatasetNow(@Req() req: Request) {
    // Download the configured datasets then import them — detached; progress
    // streams over the imdb.dataset.download.* / import.* WS events.
    return this.imdb.triggerDatasetUpdate(auditCtx(req));
  }

  @Post('providers/imdb/dataset/reset')
  @RequirePermissions(P.MEDIA_MANAGER_IMDB_IMPORT_DATASET)
  resetImdbData(@Body() body: { reimport?: boolean }, @Req() req: Request) {
    // Wipe all imported IMDb rows; optionally kick off a fresh import.
    return this.imdb.resetData(auditCtx(req), Boolean(body?.reimport));
  }

  @Get('providers/imdb/dataset/imports')
  @RequirePermissions(P.MEDIA_MANAGER_IMDB_VIEW)
  imdbImports() {
    return this.imdb.listImports();
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('providers/imdb/search')
  @RequirePermissions(P.MEDIA_MANAGER_IMDB_SEARCH)
  imdbSearch(
    @Query('title') title?: string,
    @Query('year') year?: string,
    @Query('type') type?: string,
    @Query('season') season?: string,
    @Query('episode') episode?: string,
  ) {
    const y = year ? Number.parseInt(year, 10) : undefined;
    return this.imdb.search({
      title: title ?? '',
      year: Number.isFinite(y as number) ? (y as number) : undefined,
      type: (type as ImdbTitleKind) || undefined,
      season: season ? Number.parseInt(season, 10) : undefined,
      episode: episode ? Number.parseInt(episode, 10) : undefined,
    });
  }

  @Get('providers/imdb/title/:imdbId')
  @RequirePermissions(P.MEDIA_MANAGER_IMDB_VIEW)
  imdbTitle(@Param('imdbId') imdbId: string) {
    return this.imdb.getTitle(imdbId);
  }

  @Post('items/:id/match/imdb')
  @RequirePermissions(P.MEDIA_MANAGER_IMDB_MATCH)
  matchItemImdb(
    @Param('id') id: string,
    @Body() body: ImdbMatchDto,
    @Req() req: Request,
  ) {
    return this.imdb.matchItem(id, body ?? ({} as ImdbMatchDto), auditCtx(req));
  }

  // --- rename engine (retained) -----------------------------------------
  @Get('presets')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  presets() {
    return this.media.presets();
  }

  @Post('preview')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  preview(@Req() req: Request) {
    return this.media.buildPlan((req.body ?? {}) as RenameRequest);
  }

  @Post('apply')
  @RequirePermissions(P.MEDIA_MANAGER_RENAME)
  apply(@Req() req: Request) {
    return this.media.apply((req.body ?? {}) as RenameRequest);
  }

  @Get('history')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  history(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.media.history(page, pageSize);
  }

  // --- cleanup rules (junk deletion during rename) ----------------------
  @Get('settings/cleanup')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  getCleanup() {
    return this.media.getCleanup();
  }

  @Patch('settings/cleanup')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_LIBRARIES)
  updateCleanup(@Body() body: Partial<CleanupRules>, @Req() req: Request) {
    return this.media.setCleanup(body ?? {}, auditCtx(req));
  }
}
