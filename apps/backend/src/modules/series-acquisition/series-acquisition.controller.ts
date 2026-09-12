import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';

import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { reqAuditContext } from '../../common/request-audit-context';
import { TvShowStatusService } from '../rss/tv-show-status/tv-show-status.service';
import { SeriesAcquisitionProvisioningService } from './series-acquisition-provisioning.service';
import { SeriesBackfillService } from './series-backfill.service';
import { SeriesAcquisitionDto } from './dto/series-acquisition.dto';

const P = PERMISSIONS;
const BACKFILL_ACTIONS = ['pause', 'resume', 'cancel'] as const;
type BackfillAction = (typeof BACKFILL_ACTIONS)[number];

/**
 * Add Series — the unified acquisition workflow API. RBAC-gated and audited. The
 * provisioning path is idempotent (re-running links to what exists), so a retry or
 * a scope change is safe. Monitoring an ended/canceled show additionally requires
 * the override permission, on top of watchlist-management.
 */
@ApiTags('series-acquisition')
@ApiBearerAuth()
@Controller('series-acquisition')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SeriesAcquisitionController {
  constructor(
    private readonly provisioning: SeriesAcquisitionProvisioningService,
    private readonly backfill: SeriesBackfillService,
    private readonly showStatus: TvShowStatusService,
  ) {}

  /** Search providers for a series to add (candidates carry their external id). */
  @Get('search')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  search(@Query('q') q: string, @Query('year') year?: string) {
    const parsedYear = year ? Number.parseInt(year, 10) : null;
    return this.showStatus.searchShows(q ?? '', Number.isNaN(parsedYear as number) ? null : parsedYear);
  }

  /** Dry-run: what provisioning would ensure. No writes. */
  @Post('plan')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  plan(@Body() dto: SeriesAcquisitionDto, @CurrentUser() u: AuthenticatedUser, @Req() req: Request) {
    const ctx = reqAuditContext(req);
    return this.provisioning.planSeriesAcquisition(dto, { userId: u?.id, ...ctx });
  }

  /** Ensure the full acquisition stack for a series (idempotent). */
  @Post('provision')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_WATCHLIST)
  provision(@Body() dto: SeriesAcquisitionDto, @CurrentUser() u: AuthenticatedUser, @Req() req: Request) {
    // Monitoring an ended/canceled show is a deliberate override and needs the
    // override permission in addition to watchlist-management — a normal operator
    // cannot commit the system to watching a show that will never air again.
    if (dto.allowInactiveShowMonitoring && !this.holds(u, P.MEDIA_ACQUISITION_OVERRIDE)) {
      throw new ForbiddenException(
        `Monitoring an ended or canceled show requires the "${P.MEDIA_ACQUISITION_OVERRIDE}" permission.`,
      );
    }
    return this.provisioning.provisionSeriesAcquisition(dto, u?.id, reqAuditContext(req));
  }

  /** Current/most-recent backfill job for a series. */
  @Get('backfill/:watchlistItemId')
  @RequirePermissions(P.MEDIA_ACQUISITION_VIEW)
  backfillStatus(@Param('watchlistItemId') watchlistItemId: string) {
    return this.backfill.latestJob(watchlistItemId);
  }

  /** Pause / resume / cancel a backfill job. */
  @Post('backfill/job/:jobId/:action')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_WATCHLIST)
  async backfillControl(@Param('jobId') jobId: string, @Param('action') action: string) {
    if (!BACKFILL_ACTIONS.includes(action as BackfillAction)) {
      throw new BadRequestException(`Unknown backfill action "${action}".`);
    }
    switch (action as BackfillAction) {
      case 'pause':
        return { ok: await this.backfill.pause(jobId) };
      case 'resume':
        return { job: await this.backfill.resume(jobId) };
      case 'cancel':
        return { ok: await this.backfill.cancel(jobId) };
    }
  }

  private holds(u: AuthenticatedUser, permission: string): boolean {
    if (u?.roles?.includes(SystemRole.SUPER_ADMIN)) return true;
    return Boolean(u?.permissions?.includes(permission));
  }
}
