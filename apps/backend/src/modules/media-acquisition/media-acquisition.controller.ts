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
import { AcquisitionDecision } from './decision.engine';
import {
  CreateAcquisitionProfileDto,
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

  // --- evaluations --------------------------------------------------------
  @Post('evaluate')
  @RequirePermissions(P.MEDIA_ACQUISITION_EVALUATE)
  evaluate(@Body() dto: EvaluateReleaseDto, @CurrentUser() u: AuthenticatedUser) {
    return this.evaluator.evaluate(dto, u?.id);
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
