import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { MediaServerIntegrationService } from '../media/media-server-integration.service';
import { MediaServerAnalyticsService } from './media-server-analytics.service';
import { MediaServerSessionService } from './media-server-session.service';
import { MediaServerReportService } from './media-server-report.service';
import { AnalyticsImportService } from './analytics-import.service';

const P = PERMISSIONS;

/**
 * Media Server Analytics API. Core module, RBAC-gated. Phase 1: dashboard +
 * connection management (delegating to the shared MediaServerIntegrationService)
 * + capability-aware library listing.
 */
@ApiTags('media-server-analytics')
@ApiBearerAuth()
@Controller('media-server-analytics')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MediaServerAnalyticsController {
  constructor(
    private readonly service: MediaServerAnalyticsService,
    private readonly integrations: MediaServerIntegrationService,
    private readonly sessions: MediaServerSessionService,
    private readonly reports: MediaServerReportService,
    private readonly imports: AnalyticsImportService,
  ) {}

  @Get('dashboard')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW)
  dashboard() {
    return this.service.dashboard();
  }

  // --- live activity + watch history --------------------------------------
  @Get('live')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY)
  live() {
    return this.sessions.liveActivity();
  }
  /** Manually reconcile sessions now (the poller also runs every 30s). */
  @Post('live/poll')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS)
  pollLive() {
    return this.sessions.poll();
  }
  @Get('watch-history')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_HISTORY)
  watchHistory() {
    return this.service.watchHistory();
  }

  // --- reports + users + recently added -----------------------------------
  @Get('reports/usage')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  reportUsage() {
    return this.reports.usage();
  }
  @Get('reports/users')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  reportUsers() {
    return this.reports.users();
  }
  @Get('reports/libraries')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  reportLibraries() {
    return this.reports.libraries();
  }
  @Get('reports/playback')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  reportPlayback() {
    return this.reports.playback();
  }
  @Get('users')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_USERS)
  users() {
    return this.reports.users();
  }
  @Get('recently-added')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW)
  recentlyAdded() {
    return this.reports.recentlyAdded();
  }

  // --- analytics import (Tautulli) ----------------------------------------
  @Get('import-sources')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS)
  listImportSources() {
    return this.imports.listSources();
  }
  @Post('import-sources')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS)
  createImportSource(@Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.imports.createSource(body ?? {}, u?.id);
  }
  @Get('import-sources/:id')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS)
  getImportSource(@Param('id') id: string) {
    return this.imports.getSource(id);
  }
  @Patch('import-sources/:id')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS)
  updateImportSource(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.imports.updateSource(id, body ?? {}, u?.id);
  }
  @Delete('import-sources/:id')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS)
  deleteImportSource(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.imports.removeSource(id, u?.id);
  }
  @Post('import-sources/:id/test')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS)
  testImportSource(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.imports.test(id, u?.id);
  }
  @Post('import-sources/:id/preview')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS)
  previewImport(@Param('id') id: string) {
    return this.imports.preview(id);
  }
  @Post('import-sources/:id/import')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_RUN_IMPORTS)
  runImport(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.imports.runImport(id, u?.id);
  }
  @Get('import-jobs')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS)
  listImportJobs() {
    return this.imports.listJobs();
  }
  @Get('import-jobs/:id')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS)
  getImportJob(@Param('id') id: string) {
    return this.imports.getJob(id);
  }

  // --- connections (reuse the shared integration store) -------------------
  @Get('connections')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW)
  listConnections() {
    return this.integrations.list();
  }
  @Post('connections')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS)
  createConnection(@Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.integrations.create(body ?? {}, { userId: u?.id });
  }
  @Get('connections/:id')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW)
  getConnection(@Param('id') id: string) {
    return this.service.connection(id);
  }
  @Patch('connections/:id')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS)
  updateConnection(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.integrations.update(id, body ?? {}, { userId: u?.id });
  }
  @Delete('connections/:id')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS)
  deleteConnection(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.integrations.remove(id, { userId: u?.id });
  }
  /** Test + persist server health (status/version/platform/capabilities). */
  @Post('connections/:id/test')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS)
  testConnection(@Param('id') id: string) {
    return this.integrations.healthCheck(id);
  }
  @Post('connections/:id/sync')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS)
  syncConnection(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.integrations.refresh(id, { userId: u?.id });
  }
  @Get('connections/:id/libraries')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW)
  libraries(@Param('id') id: string) {
    return this.integrations.libraries(id);
  }
}
