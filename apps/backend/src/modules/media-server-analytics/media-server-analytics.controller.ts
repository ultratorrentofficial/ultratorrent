import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { MediaServerIntegrationService } from '../media/media-server-integration.service';
import { MediaServerAnalyticsService } from './media-server-analytics.service';
import { MediaServerSessionService } from './media-server-session.service';
import { MediaServerReportService, type ReportFilter } from './media-server-report.service';
import { AnalyticsImportService } from './analytics-import.service';
import { MediaServerEmailService } from './media-server-email.service';
import { MediaServerNewsletterService } from './media-server-newsletter.service';

const P = PERMISSIONS;

/** Parse the shared analytics filter (?days=&mediaType=) from query params. */
function parseFilter(q: Record<string, string> | undefined): ReportFilter | undefined {
  if (!q) return undefined;
  const days = q.days ? Number.parseInt(q.days, 10) : undefined;
  const mediaType = q.mediaType?.trim() || undefined;
  const filter: ReportFilter = {};
  if (days && Number.isFinite(days) && days > 0) filter.days = days;
  if (mediaType) filter.mediaType = mediaType;
  return filter.days || filter.mediaType ? filter : undefined;
}

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
    private readonly email: MediaServerEmailService,
    private readonly newsletters: MediaServerNewsletterService,
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
  reportUsage(@Query() q: Record<string, string>) {
    return this.reports.usage(parseFilter(q));
  }
  @Get('reports/users')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  reportUsers(@Query() q: Record<string, string>) {
    return this.reports.users(parseFilter(q));
  }
  @Get('reports/libraries')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  reportLibraries(@Query() q: Record<string, string>) {
    return this.reports.libraries(parseFilter(q));
  }
  @Get('reports/playback')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  reportPlayback(@Query() q: Record<string, string>) {
    return this.reports.playback(parseFilter(q));
  }
  @Get('reports/top-media')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  reportTopMedia(@Query() q: Record<string, string>) {
    return this.reports.topMedia(10, parseFilter(q));
  }
  @Get('reports/devices')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  reportDevices(@Query() q: Record<string, string>) {
    return this.reports.devices(parseFilter(q));
  }
  @Get('reports/heatmap')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  reportHeatmap(@Query() q: Record<string, string>) {
    return this.reports.heatmap(parseFilter(q));
  }
  @Get('reports/trends')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  reportTrends(@Query() q: Record<string, string>) {
    return this.reports.trends(parseFilter(q));
  }
  @Get('reports/resolutions')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  reportResolutions(@Query() q: Record<string, string>) {
    return this.reports.resolutions(parseFilter(q));
  }
  @Get('reports/library-growth')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  reportLibraryGrowth(@Query() q: Record<string, string>) {
    return this.reports.libraryGrowth(parseFilter(q));
  }
  @Get('export/watch-history')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_EXPORT)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="watch-history.csv"')
  exportWatchHistory(@Query() q: Record<string, string>) {
    return this.reports.exportWatchHistoryCsv(parseFilter(q));
  }
  @Get('users')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_USERS)
  users(@Query() q: Record<string, string>) {
    return this.reports.users(parseFilter(q));
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

  // --- newsletters --------------------------------------------------------
  @Get('newsletters')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS)
  listNewsletters() {
    return this.newsletters.list();
  }
  @Post('newsletters')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS)
  createNewsletter(@Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.newsletters.create(body ?? {}, u?.id);
  }
  @Get('newsletters/:id')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS)
  getNewsletter(@Param('id') id: string) {
    return this.newsletters.get(id);
  }
  @Patch('newsletters/:id')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS)
  updateNewsletter(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.newsletters.update(id, body ?? {}, u?.id);
  }
  @Delete('newsletters/:id')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS)
  deleteNewsletter(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.newsletters.remove(id, u?.id);
  }
  @Post('newsletters/:id/preview')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS)
  previewNewsletter(@Param('id') id: string) {
    return this.newsletters.preview(id);
  }
  @Post('newsletters/:id/test-send')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_SEND_NEWSLETTERS)
  testSendNewsletter(@Param('id') id: string, @Body() body: { recipient?: string }, @CurrentUser() u: AuthenticatedUser) {
    return this.newsletters.testSend(id, body?.recipient ?? '', u?.id);
  }
  @Post('newsletters/:id/send-now')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_SEND_NEWSLETTERS)
  sendNewsletter(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.newsletters.sendNow(id, u?.id);
  }
  @Get('newsletters/:id/deliveries')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS)
  newsletterDeliveries(@Param('id') id: string) {
    return this.newsletters.deliveries(id);
  }

  // --- email settings -----------------------------------------------------
  @Get('settings/email')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS)
  getEmailSettings() {
    return this.email.getSettings();
  }
  @Patch('settings/email')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS)
  updateEmailSettings(@Body() body: Record<string, unknown>) {
    return this.email.updateSettings(body ?? {});
  }
  @Post('settings/email/test')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS)
  testEmail(@Body() body: { recipient?: string }) {
    return this.email.testEmail(body?.recipient ?? '');
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
