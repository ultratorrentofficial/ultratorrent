import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { MediaAcquisitionService } from './media-acquisition.service';
import { AcquisitionWatchlistService } from './watchlist.service';
import { AcquisitionProfileService } from './profile.service';
import { AcquisitionEvaluatorService } from './evaluator.service';
import { AcquisitionApprovalService } from './approval.service';
import { MissingEpisodesService } from './missing-episodes.service';
import { MissingMoviesService } from './missing-movies.service';
import { MissingEpisodeSearchService } from './missing-episode-search.service';
import { AcquisitionMatchPreferenceService } from './acquisition-match-preference.service';
import { AcquisitionDecision } from './decision.engine';
import {
  CreateAcquisitionProfileDto,
  CreateMatchCandidateDto,
  UpdateMatchCandidateDto,
  BulkAddWatchlistDto,
  CreateWatchlistItemDto,
  EvaluateReleaseDto,
  ExportAcquisitionDataDto,
  OverrideEvaluationDto,
  RejectEvaluationDto,
  UpdateAcquisitionProfileDto,
  UpdateWatchlistItemDto,
} from './dto/media-acquisition.dto';

const P = PERMISSIONS;

/**
 * Media Acquisition Intelligence API. Core module, RBAC-gated. Decisions are
 * explainable; this module never performs file operations.
 */
@ApiTags('media-acquisition')
@ApiBearerAuth()
@Controller('media-acquisition')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MediaAcquisitionController {
  constructor(
    private readonly service: MediaAcquisitionService,
    private readonly watchlist: AcquisitionWatchlistService,
    private readonly profiles: AcquisitionProfileService,
    private readonly evaluator: AcquisitionEvaluatorService,
    private readonly approval: AcquisitionApprovalService,
    private readonly missingEpisodes: MissingEpisodesService,
    private readonly missingMovies: MissingMoviesService,
    private readonly missingSearch: MissingEpisodeSearchService,
    private readonly matchPrefs: AcquisitionMatchPreferenceService,
  ) {}

  @Get('overview')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  overview() {
    return this.service.overview();
  }

  // --- watchlist ----------------------------------------------------------
  @Get('watchlist')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  listWatchlist(@Query('status') status?: string) {
    return this.watchlist.list(status);
  }
  @Get('watchlist/library-series')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  librarySeries(@Query('search') search?: string) {
    return this.watchlist.librarySeries(search);
  }
  @Post('watchlist/bulk')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_WATCHLIST)
  bulkAddWatchlist(@Body() dto: BulkAddWatchlistDto, @CurrentUser() u: AuthenticatedUser) {
    return this.watchlist.bulkCreate(dto.series, u?.id);
  }
  @Post('watchlist')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_WATCHLIST)
  createWatchlist(@Body() dto: CreateWatchlistItemDto, @CurrentUser() u: AuthenticatedUser) {
    return this.watchlist.create(dto, u?.id);
  }
  @Get('watchlist/:id')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  getWatchlist(@Param('id') id: string) {
    return this.watchlist.get(id);
  }
  @Patch('watchlist/:id')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_WATCHLIST)
  updateWatchlist(@Param('id') id: string, @Body() dto: UpdateWatchlistItemDto, @CurrentUser() u: AuthenticatedUser) {
    return this.watchlist.update(id, dto, u?.id);
  }
  @Delete('watchlist/:id')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_WATCHLIST)
  deleteWatchlist(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.watchlist.remove(id, u?.id);
  }

  // --- profiles -----------------------------------------------------------
  @Get('profiles')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  listProfiles(@Query('mediaType') mediaType?: string) {
    return this.profiles.list(mediaType);
  }
  @Post('profiles')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_PROFILES)
  createProfile(@Body() dto: CreateAcquisitionProfileDto, @CurrentUser() u: AuthenticatedUser) {
    return this.profiles.create(dto, u?.id);
  }
  @Get('profiles/:id')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  getProfile(@Param('id') id: string) {
    return this.profiles.get(id);
  }
  @Patch('profiles/:id')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_PROFILES)
  updateProfile(@Param('id') id: string, @Body() dto: UpdateAcquisitionProfileDto, @CurrentUser() u: AuthenticatedUser) {
    return this.profiles.update(id, dto, u?.id);
  }
  @Delete('profiles/:id')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_PROFILES)
  deleteProfile(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.profiles.remove(id, u?.id);
  }

  // --- auto-download match preferences (global defaults) ------------------
  // The ranked candidate list (quality + size cap) the missing-episode sweep
  // uses when a show isn't linked to an RSS rule. Same model as RSS rules.
  @Get('match-preferences')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  listMatchPreferences() {
    return this.matchPrefs.list();
  }
  @Post('match-preferences')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_PROFILES)
  createMatchPreference(@Body() dto: CreateMatchCandidateDto) {
    return this.matchPrefs.create(dto as never);
  }
  @Patch('match-preferences/:id')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_PROFILES)
  updateMatchPreference(@Param('id') id: string, @Body() dto: UpdateMatchCandidateDto) {
    return this.matchPrefs.update(id, dto as never);
  }
  @Delete('match-preferences/:id')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_PROFILES)
  deleteMatchPreference(@Param('id') id: string) {
    return this.matchPrefs.remove(id);
  }

  // --- evaluations --------------------------------------------------------
  @Post('evaluate')
  @RequirePermissions(P.MEDIA_ACQUISITION_EVALUATE)
  evaluate(@Body() dto: EvaluateReleaseDto, @CurrentUser() u: AuthenticatedUser) {
    return this.evaluator.evaluate(dto, u?.id);
  }
  /** Dry-run: full decision + stage-by-stage explanation, no side effects. */
  @Post('simulate')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  simulate(@Body() dto: EvaluateReleaseDto) {
    return this.evaluator.simulate(dto);
  }
  @Get('evaluations')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  listEvaluations(@Query('decision') decision?: string, @Query('approvalStatus') approvalStatus?: string) {
    return this.service.listEvaluations({ decision, approvalStatus });
  }
  @Get('evaluations/:id')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  getEvaluation(@Param('id') id: string) {
    return this.service.getEvaluation(id);
  }

  // --- queues -------------------------------------------------------------
  @Get('waiting')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  waiting() {
    return this.service.waiting();
  }
  @Get('upgrades')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  upgrades() {
    return this.service.upgrades();
  }
  @Get('rejected')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  rejected() {
    return this.service.rejected();
  }

  // --- approval queue -----------------------------------------------------
  @Get('approval-queue')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  approvalQueue() {
    return this.approval.queue();
  }
  @Post('evaluations/:id/approve')
  @RequirePermissions(P.MEDIA_ACQUISITION_APPROVE)
  approve(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.approval.approve(id, u?.id);
  }
  @Post('evaluations/:id/reject')
  @RequirePermissions(P.MEDIA_ACQUISITION_REJECT)
  reject(@Param('id') id: string, @Body() dto: RejectEvaluationDto, @CurrentUser() u: AuthenticatedUser) {
    return this.approval.reject(id, dto.reason, u?.id);
  }
  @Post('evaluations/:id/override')
  @RequirePermissions(P.MEDIA_ACQUISITION_OVERRIDE)
  override(@Param('id') id: string, @Body() dto: OverrideEvaluationDto, @CurrentUser() u: AuthenticatedUser) {
    return this.approval.override(id, dto.decision as AcquisitionDecision, dto.reason, u?.id);
  }

  // --- missing episodes ---------------------------------------------------
  @Get('missing-episodes')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  missingEpisodesOverview() {
    return this.missingEpisodes.listGrouped();
  }
  @Get('missing-episodes/:watchlistItemId')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  missingEpisodesForSeries(@Param('watchlistItemId') watchlistItemId: string) {
    return this.missingEpisodes.listForSeries(watchlistItemId);
  }
  @Post('missing-episodes/scan')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_WATCHLIST)
  scanMissingEpisodes(
    @Body() body: { watchlistItemId?: string },
    @CurrentUser() u: AuthenticatedUser,
  ) {
    return body?.watchlistItemId
      ? this.missingEpisodes.scanSeries(body.watchlistItemId, u?.id)
      : this.missingEpisodes.scanAll(u?.id);
  }
  // Auto-acquire bridge: search indexers for a wanted episode (or a whole series)
  // and hand the best release to the evaluator (profile-gated auto-grab).
  @Post('missing-episodes/series/:watchlistItemId/search')
  @RequirePermissions(P.MEDIA_ACQUISITION_EVALUATE)
  searchMissingEpisodesForSeries(@Param('watchlistItemId') watchlistItemId: string, @CurrentUser() u: AuthenticatedUser) {
    return this.missingSearch.searchSeries(watchlistItemId, u?.id);
  }
  @Post('missing-episodes/:id/search')
  @RequirePermissions(P.MEDIA_ACQUISITION_EVALUATE)
  searchMissingEpisode(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.missingSearch.searchEpisode(id, u?.id);
  }
  @Post('missing-episodes/:id/ignore')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_WATCHLIST)
  ignoreMissingEpisode(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.missingEpisodes.ignore(id, u?.id);
  }
  @Post('missing-episodes/:id/unignore')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_WATCHLIST)
  unignoreMissingEpisode(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.missingEpisodes.unignore(id, u?.id);
  }

  // --- missing seasons (rollup of a series' episodes) ---------------------
  @Get('missing-episodes/:watchlistItemId/seasons')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  missingSeasons(@Param('watchlistItemId') watchlistItemId: string) {
    return this.missingEpisodes.listSeasons(watchlistItemId);
  }

  // --- missing movies -----------------------------------------------------
  @Get('missing-movies')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  missingMoviesOverview() {
    return this.missingMovies.listMissingMovies();
  }
  @Post('missing-movies/scan')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_WATCHLIST)
  scanMissingMovies(
    @Body() body: { watchlistItemId?: string },
    @CurrentUser() u: AuthenticatedUser,
  ) {
    return body?.watchlistItemId
      ? this.missingMovies.scanMovie(body.watchlistItemId, u?.id)
      : this.missingMovies.scanAll(u?.id);
  }
  @Post('missing-movies/:id/ignore')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_WATCHLIST)
  ignoreMissingMovie(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.missingMovies.ignore(id, u?.id);
  }
  @Post('missing-movies/:id/unignore')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_WATCHLIST)
  unignoreMissingMovie(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.missingMovies.unignore(id, u?.id);
  }

  // --- history / recommendations / settings / export ---------------------
  @Get('history')
  @RequirePermissions(P.MEDIA_ACQUISITION_HISTORY)
  history(@Query('limit') limit?: string) {
    return this.service.history(limit ? Number(limit) : undefined);
  }
  @Get('recommendations')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  recommendations() {
    return this.service.recommendations();
  }
  @Get('settings')
  @RequirePermissions(P.MEDIA_ACQUISITION_SETTINGS)
  getSettings() {
    return this.service.getSettings();
  }
  @Patch('settings')
  @RequirePermissions(P.MEDIA_ACQUISITION_SETTINGS)
  updateSettings(@Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.service.updateSettings(body, u?.id);
  }
  @Post('export')
  @RequirePermissions(P.MEDIA_ACQUISITION_EXPORT)
  export(@Body() dto: ExportAcquisitionDataDto, @CurrentUser() u: AuthenticatedUser) {
    return this.service.export(dto, u?.id);
  }
}
