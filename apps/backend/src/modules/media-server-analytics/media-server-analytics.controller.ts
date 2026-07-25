import { Body, Controller, Delete, Get, Header, NotFoundException, Param, Patch, Post, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { MediaServerIntegrationService } from '../media/media-server-integration.service';
import { MediaServerAnalyticsService } from './media-server-analytics.service';
import { MediaServerSessionService } from './media-server-session.service';
import { MediaServerReportService, type ReportFilter, type PlayDrill } from './media-server-report.service';
import { parsePage } from '../../common/pagination';
import { MediaServerSyncService } from './media-server-sync.service';
import { AnalyticsImportService } from './analytics-import.service';
import { MediaServerEmailService } from './media-server-email.service';
import { MediaServerNewsletterService } from './media-server-newsletter.service';
import { NewsletterImageService } from './newsletter-image.service';

const P = PERMISSIONS;

/** Parse the shared analytics filter (?days=&mediaType=&connectionId=&libraryName=&userName=). */
function parseFilter(q: Record<string, string> | undefined): ReportFilter | undefined {
  if (!q) return undefined;
  const days = q.days ? Number.parseInt(q.days, 10) : undefined;
  const filter: ReportFilter = {};
  if (days && Number.isFinite(days) && days > 0) filter.days = days;
  if (q.mediaType?.trim()) filter.mediaType = q.mediaType.trim();
  if (q.connectionId?.trim()) filter.connectionId = q.connectionId.trim();
  if (q.libraryName?.trim()) filter.libraryName = q.libraryName.trim();
  if (q.userName?.trim()) filter.userName = q.userName.trim();
  return Object.keys(filter).length ? filter : undefined;
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
    private readonly sync: MediaServerSyncService,
    private readonly imports: AnalyticsImportService,
    private readonly email: MediaServerEmailService,
    private readonly newsletters: MediaServerNewsletterService,
    private readonly images: NewsletterImageService,
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
  /** Proxy the now-playing poster for a live session (provider auth injected server-side). */
  @Get('live/:id/artwork')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY)
  async liveArtwork(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const img = await this.sessions.artwork(id);
    if (!img) throw new NotFoundException('No artwork for this session.');
    res.set({ 'Content-Type': img.contentType, 'Cache-Control': 'private, max-age=120' });
    return new StreamableFile(img.body);
  }
  @Get('watch-history')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_HISTORY)
  watchHistory(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.service.watchHistory(page, pageSize);
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
  /**
   * The individual plays behind one slice of a chart — the drill-down every chart
   * clicks through to. Takes the dashboard's own filter plus the clicked dimension:
   * `users`/`devices` (comma-separated; `__unknown__` for the NULL bar, several
   * values for a folded "Other" bar), `resolution`/`playbackMethod` (a canonical
   * chart LABEL, resolved server-side back to the raw values it folds), `dow`+`hour`
   * (a heatmap cell), or `title`.
   *
   * Gated on VIEW_HISTORY, not VIEW_REPORTS: an aggregate hides who watched what,
   * and this does not — it returns named rows, so it needs the same permission as
   * the watch-history page.
   */
  @Get('reports/plays')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_HISTORY)
  reportPlays(@Query() q: Record<string, string>) {
    const list = (v?: string) =>
      v?.split(',').map((s) => s.trim()).filter(Boolean) ?? undefined;
    const int = (v?: string) => {
      if (v == null || v === '') return undefined;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    };
    const drill: PlayDrill = {
      users: list(q.users),
      devices: list(q.devices),
      resolution: q.resolution?.trim() || undefined,
      playbackMethod: q.playbackMethod?.trim() || undefined,
      dow: int(q.dow),
      hour: int(q.hour),
      title: q.title?.trim() || undefined,
    };
    return this.reports.plays(parseFilter(q), drill, parsePage(q.page, q.pageSize));
  }

  @Get('reports/library-growth')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  reportLibraryGrowth(@Query() q: Record<string, string>) {
    return this.reports.libraryGrowth(parseFilter(q));
  }
  @Get('reports/bandwidth')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  reportBandwidth(@Query() q: Record<string, string>) {
    return this.reports.bandwidth(parseFilter(q));
  }
  @Get('export/watch-history')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_EXPORT)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="watch-history.csv"')
  exportWatchHistory(@Query() q: Record<string, string>) {
    return this.reports.exportWatchHistoryCsv(parseFilter(q));
  }

  // --- normalized metadata + sync (Phase 6e) ------------------------------
  /** Synced libraries — populates the dashboard's library filter. */
  @Get('meta/libraries')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW)
  metaLibraries() {
    return this.sync.listLibraries();
  }
  /** Known viewers — populates the dashboard's user filter. */
  @Get('meta/users')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW)
  metaUsers() {
    return this.sync.listUsers();
  }
  /** Recent provider sync runs. */
  @Get('meta/sync-runs')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  metaSyncRuns(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.sync.listRuns(page, pageSize);
  }
  /** Trigger a metadata sync (libraries + users) across all connections now. */
  @Post('meta/sync')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS)
  runSync() {
    return this.sync.syncAll();
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
  listImportJobs(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.imports.listJobs(page, pageSize);
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
  // Synced media-server users offered in the recipient picker. Declared BEFORE the
  // `newsletters/:id` routes below so `recipient-options` isn't captured as an id.
  @Get('newsletters/recipient-options')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS)
  newsletterRecipientOptions() {
    return this.sync.listUsers();
  }
  /** Manually set/clear a synced user's email (servers whose accounts carry none). */
  @Patch('newsletters/recipient-options/:userId')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS)
  setRecipientEmail(@Param('userId') userId: string, @Body() body: { email?: string | null }) {
    return this.sync.setUserEmail(userId, body?.email ?? null);
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
  newsletterDeliveries(@Param('id') id: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.newsletters.deliveries(id, page, pageSize);
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

  // --- newsletter image (poster) hosting settings -------------------------
  @Get('settings/newsletter-images')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS)
  getNewsletterImageSettings() {
    return this.images.getSettings();
  }
  @Patch('settings/newsletter-images')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS)
  updateNewsletterImageSettings(@Body() body: Record<string, unknown>) {
    return this.images.updateSettings(body ?? {});
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
