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
import { MediaAutomationActions } from './media-automation.actions';
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
import { MediaShowDuplicateService } from './media-show-duplicate.service';
import { RunShowMergeDto, ShowMergeDto } from './dto/show-merge.dto';
import { BulkPreviewDto, BulkResolveDto, DeleteDuplicateItemDto, IgnoreDuplicateGroupDto, ListDuplicatesDto, ResolveCleanupDto, ResolveDuplicateDto } from './dto/duplicates.dto';
import { DuplicateResolutionService } from './duplicate-resolution.service';
import {
  MediaServerIntegrationService,
  IntegrationInput,
} from './media-server-integration.service';
import { MediaProcessingQueueService } from './media-processing-queue.service';
import { MediaProcessingService } from './media-processing.service';
import { MetadataProviderRegistry } from './metadata-provider-registry.service';
import { COMPOSABLE_FIELDS } from './universal-metadata.provider';
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
    private readonly duplicateResolution: DuplicateResolutionService,
    private readonly showDuplicates: MediaShowDuplicateService,
    private readonly integrations: MediaServerIntegrationService,
    private readonly jobs: MediaProcessingQueueService,
    private readonly imdb: ImdbService,
    private readonly mediaActions: MediaAutomationActions,
    private readonly providerRegistry: MetadataProviderRegistry,
    private readonly processing: MediaProcessingService,
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
  async createLibrary(@Body() body: LibraryInput, @Req() req: Request) {
    const library = await this.libraries.create(body ?? {});
    // A library that has never been scanned knows nothing about its own contents:
    // no items, and no `MediaShow` rows, so the acquisition side has no folder to
    // file a grab into. Scan it immediately rather than leave it blank until the
    // operator finds the Scan button (or the 5-minute scheduler gets to it).
    const { jobId } = await this.launchLibraryScan(library.id, req);
    return { ...library, scanJobId: jobId };
  }

  @Patch('libraries/:id')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_LIBRARIES)
  async updateLibrary(@Param('id') id: string, @Body() body: LibraryInput, @Req() req: Request) {
    const library = await this.libraries.update(id, body ?? {});
    // Re-scan on edit too: the path, kind or naming mode may have changed, and each
    // of those changes what the library's contents *are* as far as the DB is
    // concerned. Detached, so a large library can't time the request out.
    const { jobId } = await this.launchLibraryScan(library.id, req);
    return { ...library, scanJobId: jobId };
  }

  /**
   * Fire the same detached scan the explicit Scan button runs, returning its job id.
   * Progress and the result arrive over the `media_manager.job.*` WS events.
   */
  private launchLibraryScan(id: string, req: Request): Promise<{ jobId: string }> {
    return this.jobs.runDetached('library_scan', { libraryId: id }, async (report) => {
      const scan = await this.scanner.scanLibrary(id, (p, m) => report(p * 0.8, m));
      const organized = await this.mediaActions.organizeLibrary(id, { dryRun: false }, auditCtx(req), (p, m) =>
        report(80 + p * 0.2, m),
      );
      return { ...scan, organized };
    });
  }

  @Delete('libraries/:id')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_LIBRARIES)
  removeLibrary(@Param('id') id: string) {
    return this.libraries.remove(id);
  }

  @Post('libraries/:id/scan')
  @RequirePermissions(P.MEDIA_MANAGER_SCAN)
  scanLibrary(@Param('id') id: string, @Req() req: Request) {
    // Tracked as a MediaProcessingJob; the scanner streams progress + a per-file
    // action log over the media_manager.job.progress WS event. A manual scan runs
    // the same three stages, in the same order, as the post-download and periodic
    // paths: index (scanner) → organise/rename (organizeLibrary) → enrich
    // (identify + metadata + artwork). For an organize-mode library
    // (rename_in_place/rename_move) the scan moves in-place files into
    // Show/Season NN and applies junk cleanup; a no-op for link/preview libraries
    // (organizeLibrary self-gates on the library mode). Enrichment runs LAST so it
    // reads the final, post-rename paths, and fills only gaps (unmatched items, or
    // matched items missing metadata/poster) — so it never re-hammers a
    // steady-state library. Detached: return { jobId } immediately so a
    // large-library scan can't time the HTTP request out at the gateway (504).
    // Progress + the final result arrive over the media_manager.job.* WS events.
    return this.jobs.runDetached('library_scan', { libraryId: id }, async (report) => {
      const scan = await this.scanner.scanLibrary(id, (p, m) => report(p * 0.55, m));
      const organized = await this.mediaActions.organizeLibrary(id, { dryRun: false }, auditCtx(req), (p, m) =>
        report(55 + p * 0.15, m),
      );
      const enriched = await this.processing.enrichLibrary(id, (p, m) => report(70 + p * 0.3, m));
      return { ...scan, organized, enriched };
    });
  }

  /**
   * Organize a library's in-place files into Show/Season NN + junk cleanup,
   * WITHOUT a scan. `?dryRun=1` previews the moves/deletes (touches no disk);
   * otherwise it executes, tracked as a job. Only rename_in_place/rename_move
   * libraries are eligible.
   */
  @Post('libraries/:id/organize')
  @RequirePermissions(P.MEDIA_MANAGER_RENAME)
  organizeLibrary(@Param('id') id: string, @Query('dryRun') dryRun: string | undefined, @Req() req: Request) {
    const dry = dryRun === 'true' || dryRun === '1';
    if (dry) return this.mediaActions.organizeLibrary(id, { dryRun: true }, auditCtx(req));
    return this.jobs.run('library_organize', { libraryId: id }, (report) =>
      this.mediaActions.organizeLibrary(id, { dryRun: false }, auditCtx(req), report),
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
    return this.identification.reidentify(id);
  }

  @Post('items/:id/unmatch')
  @RequirePermissions(P.MEDIA_MANAGER_MATCH)
  unmatchItem(@Param('id') id: string) {
    return this.identification.unmatch(id);
  }

  // --- lock --------------------------------------------------------------
  // A locked item is skipped by identification, enrichment, the organizer and
  // the renamer, so a hand-corrected file survives a tree that another tool
  // (tinyMediaManager, Kodi) also writes to.
  @Post('items/:id/lock')
  @RequirePermissions(P.MEDIA_MANAGER_EDIT_METADATA)
  lockItem(@Param('id') id: string) {
    return this.items.setLocked(id, true);
  }

  @Post('items/:id/unlock')
  @RequirePermissions(P.MEDIA_MANAGER_EDIT_METADATA)
  unlockItem(@Param('id') id: string) {
    return this.items.setLocked(id, false);
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
  /** Counts for the Duplicate Center landing screen. */
  @Get('duplicates/overview')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  duplicatesOverview() {
    return this.duplicates.overview();
  }

  @Get('duplicates')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  listDuplicates(@Query() query: ListDuplicatesDto) {
    return this.duplicates.list(query.page, query.pageSize, query);
  }

  /**
   * Re-run duplicate detection. This is a WRITE: it clears every existing group
   * (`deleteMany({})`) before rebuilding, so it discards grouping state for everyone.
   * It was gated on MEDIA_MANAGER_VIEW, which let a read-only account destroy that
   * state and trigger a full-table scan. SCAN is the permission that already governs
   * "make the server go and re-examine the library".
   */
  /**
   * Re-run duplicate detection as a background job.
   *
   * Detached because it is not fast: measured at **10.5 s** on a live 29,558-item
   * library, which on a larger one is a gateway timeout and everywhere is a spinner
   * with nothing behind it. Returns `{ jobId }` at once; progress, the metrics
   * result and failures arrive over the `media_manager.job.*` WS events.
   */
  @Post('duplicates/detect')
  @RequirePermissions(P.MEDIA_MANAGER_SCAN)
  detectDuplicates() {
    return this.jobs.runDetached('duplicate_detect', {}, (report, signal) =>
      this.duplicates.detect(report, signal),
    );
  }

  /**
   * Ask a running Media Manager job to stop.
   *
   * Cooperative: the job body decides where it is safe to stop, so a job mid-write
   * finishes that write rather than leaving a half-applied batch. Returns whether
   * the request reached a job this process is actually running.
   */
  @Post('jobs/:jobId/cancel')
  @RequirePermissions(P.MEDIA_MANAGER_SCAN)
  cancelJob(@Param('jobId') jobId: string) {
    return { requested: this.jobs.requestCancel(jobId) };
  }

  /** One group with the side-by-side comparison payload. */
  @Get('duplicates/:groupId')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  getDuplicateGroup(@Param('groupId') groupId: string) {
    return this.duplicates.get(groupId);
  }

  /**
   * "These are not duplicates." Recorded against the group's durable identity, so it
   * survives the next detection run instead of reappearing.
   */
  @Post('duplicates/:groupId/ignore')
  @RequirePermissions(P.MEDIA_MANAGER_MATCH)
  ignoreDuplicateGroup(
    @Param('groupId') groupId: string,
    @Body() body: IgnoreDuplicateGroupDto,
    @Req() req: Request,
  ) {
    return this.duplicates.ignore(groupId, body?.reason, (req as unknown as { user?: { id?: string } }).user?.id);
  }

  /**
   * Build a cleanup plan. Touches nothing — the plan is persisted and pinned to the
   * group version it was built against, so execution runs what was approved.
   */
  @Post('duplicates/:groupId/preview')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  previewDuplicateCleanup(
    @Param('groupId') groupId: string,
    @Body() body: ResolveDuplicateDto,
    @Req() req: Request,
  ) {
    return this.duplicateResolution.preview(groupId, body?.keepItemId, auditCtx(req));
  }

  /**
   * Build a plan to delete ONE named copy while keeping the rest — the per-file
   * Delete action. Like the cleanup preview it touches nothing; the plan is
   * persisted and executed through the same `resolutions/:id/resolve` route, which
   * refuses if no surviving copy remains.
   */
  @Post('duplicates/:groupId/preview-delete')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  previewDuplicateItemDeletion(
    @Param('groupId') groupId: string,
    @Body() body: DeleteDuplicateItemDto,
    @Req() req: Request,
  ) {
    return this.duplicateResolution.previewItemDeletion(groupId, body.deleteItemId, auditCtx(req));
  }

  /**
   * Execute a previewed plan. Destructive: redundant copies go to Trash, so this
   * needs DELETE in addition to the review permission.
   */
  @Post('duplicates/resolutions/:resolutionId/resolve')
  @RequirePermissions(P.MEDIA_MANAGER_DELETE)
  resolveDuplicateCleanup(
    @Param('resolutionId') resolutionId: string,
    @Body() body: ResolveCleanupDto,
    @Req() req: Request,
  ) {
    return this.duplicateResolution.resolve(resolutionId, auditCtx(req), { permanent: body?.permanent === true });
  }

  /**
   * Groups safe to clean without opening each one. Eligibility is decided here, not
   * by the client: only groups the engine neither flagged for review nor left without
   * a keeper.
   */
  @Get('duplicates/quick-clean/candidates')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  quickCleanCandidates() {
    return this.duplicateResolution.quickCleanCandidates();
  }

  /** Plan a cleanup for many groups at once. Touches nothing. */
  @Post('duplicates/bulk/preview')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  bulkPreviewDuplicates(@Body() body: BulkPreviewDto, @Req() req: Request) {
    return this.duplicateResolution.bulkPreview(body.groupIds, body.keepByGroup ?? {}, auditCtx(req));
  }

  /** Execute many previewed plans. Destructive — same permission as a single resolve. */
  @Post('duplicates/bulk/resolve')
  @RequirePermissions(P.MEDIA_MANAGER_DELETE)
  bulkResolveDuplicates(@Body() body: BulkResolveDto, @Req() req: Request) {
    return this.duplicateResolution.bulkResolve(body.resolutionIds, auditCtx(req), {
      permanent: body.permanent === true,
    });
  }

  /**
   * What the Duplicate Center has sent to Trash. Restore goes through the existing
   * `/api/files/trash/restore` route rather than a duplicate of it.
   */
  @Get('duplicates/trash/history')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  duplicateTrashHistory() {
    return this.duplicateResolution.trashedByCleanup();
  }

  /** Put an ignored or resolved group back in front of the operator. */
  @Post('duplicates/:groupId/reopen')
  @RequirePermissions(P.MEDIA_MANAGER_MATCH)
  reopenDuplicateGroup(@Param('groupId') groupId: string) {
    return this.duplicates.reopen(groupId);
  }

  // --- duplicate SHOW FOLDERS --------------------------------------------
  // Two directories that are really the same show ("Happy's Place (2024)" vs
  // "Happys Place"). Distinct from the duplicates above, which are duplicate
  // *files*. Nothing here is automatic: detect reports, preview plans, and only
  // an explicit merge — with the operator's chosen canonical path — touches disk.

  /**
   * Duplicate show folders, bounded. Each family costs a recursive directory walk
   * per member, so the response is a page with a `total`, not an unbounded array.
   */
  @Get('shows/duplicates')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  detectDuplicateShows(@Query('libraryId') libraryId?: string, @Query('limit') limit?: string) {
    const n = Number(limit);
    return this.showDuplicates.detect(libraryId, Number.isFinite(n) && n > 0 ? n : undefined);
  }

  /**
   * Build and store a merge plan. Touches no disk. Returns the plan for the operator
   * to read plus the `planId` that {@link mergeShows} takes.
   */
  @Post('shows/duplicates/preview')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  previewShowMerge(@Body() body: ShowMergeDto, @Req() req: Request) {
    return this.showDuplicates.preview(
      {
        canonicalShowId: body.canonicalShowId,
        duplicateShowIds: body.duplicateShowIds,
        collisionChoices: body.collisionChoices,
        acknowledgeMetadataConflict: body.acknowledgeMetadataConflict,
      },
      auditCtx(req),
    );
  }

  /**
   * Run a previously previewed merge, then rescan the library so the moved files are
   * filed into `Season NN` and the media server picks them up.
   *
   * Takes only the plan id: what executes is the plan the operator read, and a
   * client cannot hand-craft a list of files to move and delete. Destructive — needs
   * both RENAME (it moves files) and DELETE (it removes folders).
   */
  @Post('shows/duplicates/merge')
  @RequirePermissions(P.MEDIA_MANAGER_RENAME, P.MEDIA_MANAGER_DELETE)
  async mergeShows(@Body() body: RunShowMergeDto, @Req() req: Request) {
    const result = await this.showDuplicates.merge(body.planId, auditCtx(req));
    // Step 12 of the workflow. The merge deliberately drops files in the canonical
    // folder's ROOT rather than guessing at a season layout; the library's own
    // organiser — which the scan job runs — is what knows the naming template. A
    // failed merge is not rescanned: there is nothing new to index and the operator
    // needs the folders exactly as the failure left them.
    let rescanJobId: string | null = null;
    let serverRefresh = { refreshed: 0, failed: 0 };
    if (result.status !== 'failed') {
      rescanJobId = (await this.launchLibraryScan(result.libraryId, req)).jobId;
      // Step 13. Best-effort: the files have already moved, and a media server that
      // is down is not a reason to report the merge as failed.
      serverRefresh = await this.integrations.refreshAllEnabled(auditCtx(req));
    }
    return { ...result, rescanJobId, serverRefresh };
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

  // --- TheTVDB metadata provider ----------------------------------------
  @Post('providers/tvdb/test')
  @RequirePermissions(P.SETTINGS_MANAGE)
  testTvdbApi(@Body() body: { apiKey?: string; pin?: string }, @Req() req: Request) {
    return this.media.testTvdbKey(body?.apiKey, body?.pin, auditCtx(req));
  }

  /** Which metadata providers are configured, and the chain each kind resolves to. */
  @Get('providers')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  async listProviders() {
    const [configured, tv, movie, config] = await Promise.all([
      this.providerRegistry.configured(),
      this.providerRegistry.chain('tv'),
      this.providerRegistry.chain('movie'),
      this.providerRegistry.config(),
    ]);
    return {
      configured,
      chains: { tv: tv.map((p) => p.name), movie: movie.map((p) => p.name) },
      universal: {
        enabled: config.universalEnabled === true,
        // On, but only one provider configured: Universal cannot compose a single
        // source, so it stays inert. Say so rather than let the toggle lie.
        active: config.universalEnabled === true && configured.length > 1,
        fields: config.universalFields ?? {},
        composableFields: COMPOSABLE_FIELDS,
      },
    };
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
