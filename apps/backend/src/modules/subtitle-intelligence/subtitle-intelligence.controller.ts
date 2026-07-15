import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PERMISSIONS } from '@ultratorrent/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { SubtitleService } from './subtitle.service';
import { SubtitleSyncService, type SyncRequest } from './sync/subtitle-sync.service';
import { SubtitleMissingScanService } from './jobs/subtitle-missing-scan.service';
import { SubtitleQueueService } from './jobs/subtitle-queue.service';
import type { ProviderConfigPatch } from './providers/subtitle-provider-settings.service';

const P = PERMISSIONS;

interface AuditCtx {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
}
function auditCtx(req: Request): AuditCtx {
  const user = req.user as AuthenticatedUser | undefined;
  return { userId: user?.id, ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

@ApiTags('subtitle-intelligence')
@ApiBearerAuth()
@Controller('subtitle-intelligence')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SubtitleIntelligenceController {
  constructor(
    private readonly subtitles: SubtitleService,
    private readonly sync: SubtitleSyncService,
    private readonly missingScan: SubtitleMissingScanService,
    private readonly queue: SubtitleQueueService,
  ) {}

  // --- overview ----------------------------------------------------------
  @Get('dashboard')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_VIEW)
  dashboard() {
    return this.subtitles.dashboard();
  }

  // --- providers ---------------------------------------------------------
  @Get('providers')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_VIEW)
  listProviders() {
    return this.subtitles.listProviders();
  }

  @Patch('providers/:provider')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_PROVIDERS)
  upsertProvider(@Param('provider') provider: string, @Body() body: ProviderConfigPatch, @Req() req: Request) {
    return this.subtitles.upsertProvider(provider, body ?? {}, auditCtx(req));
  }

  @Post('providers/:provider/test')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_PROVIDERS)
  testProvider(@Param('provider') provider: string, @Req() req: Request) {
    return this.subtitles.testProvider(provider, auditCtx(req));
  }

  @Post('providers/health-check')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_PROVIDERS)
  healthCheckAll(@Req() req: Request) {
    return this.subtitles.healthCheckAll(auditCtx(req));
  }

  // --- bulk / library-wide -----------------------------------------------
  @Post('libraries/:libraryId/scan-missing')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_SEARCH)
  scanMissing(@Param('libraryId') libraryId: string) {
    // Detached — a large library (optionally auto-downloading) would time out the request.
    return this.queue.runDetached('missing_scan', { libraryId }, (report) =>
      this.missingScan.scanLibrary(libraryId, report),
    );
  }

  // --- language settings (per library) -----------------------------------
  @Get('libraries/:libraryId/languages')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_VIEW)
  getLanguages(@Param('libraryId') libraryId: string) {
    return this.subtitles.getLanguageSettings(libraryId);
  }

  @Patch('libraries/:libraryId/languages')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_SETTINGS)
  setLanguages(@Param('libraryId') libraryId: string, @Body() body: Record<string, unknown>, @Req() req: Request) {
    return this.subtitles.setLanguageSettings(libraryId, body ?? {}, auditCtx(req));
  }

  // --- fingerprint / search ----------------------------------------------
  @Post('items/:id/fingerprint')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_SEARCH)
  fingerprint(@Param('id') id: string) {
    return this.subtitles.fingerprint(id);
  }

  @Post('items/:id/search')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_SEARCH)
  search(
    @Param('id') id: string,
    @Body() body: { languages?: string[]; hearingImpaired?: boolean; forced?: boolean },
    @Req() req: Request,
  ) {
    return this.subtitles.search(id, body ?? {}, auditCtx(req));
  }

  @Get('items/:id/candidates')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_VIEW)
  candidates(@Param('id') id: string) {
    return this.subtitles.listCandidates(id);
  }

  // --- download / validate -----------------------------------------------
  @Post('candidates/:candidateId/download')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_DOWNLOAD)
  download(@Param('candidateId') candidateId: string, @Req() req: Request) {
    return this.subtitles.downloadCandidate(candidateId, auditCtx(req));
  }

  @Post('validate')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_VIEW)
  validate(@Body() body: { content: string; ext?: string }) {
    return this.subtitles.validateText(body?.content ?? '', body?.ext ?? null);
  }

  // --- synchronization ----------------------------------------------------
  @Get('sync/capabilities')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_VIEW)
  syncCapabilities() {
    return this.sync.capabilities();
  }

  @Post('downloads/:downloadId/synchronize')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_SYNCHRONIZE)
  synchronize(@Param('downloadId') downloadId: string, @Body() body: SyncRequest, @Req() req: Request) {
    return this.sync.synchronize(downloadId, body ?? {}, auditCtx(req));
  }

  @Get('downloads/:downloadId/synchronizations')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_VIEW)
  synchronizations(@Param('downloadId') downloadId: string) {
    return this.sync.listForDownload(downloadId);
  }

  // --- read models --------------------------------------------------------
  @Get('downloads')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_VIEW)
  downloads(@Query('itemId') itemId?: string) {
    return this.subtitles.listDownloads(itemId);
  }

  @Get('history')
  @RequirePermissions(P.SUBTITLE_INTELLIGENCE_VIEW)
  history(@Query('itemId') itemId?: string) {
    return this.subtitles.listHistory(itemId);
  }
}
