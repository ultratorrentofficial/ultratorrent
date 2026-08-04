import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PERMISSIONS } from '@ultratorrent/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { SchedulerModeService } from './scheduler-mode.service';
import { SchedulerPreviewService } from './scheduler-preview.service';
import type { SchedulerMode } from './scheduler-sweep.service';

/**
 * The scheduler's read surface, plus the one mutation Phase 3 has: an engine's
 * mode.
 *
 * There is no reconcile endpoint and no override endpoint, because nothing can
 * act yet. Publishing routes that accept a request and change nothing would make
 * the API describe a system that does not exist.
 */
@ApiTags('torrent-scheduler')
@ApiBearerAuth()
@Controller('torrent-scheduler')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TorrentSchedulerController {
  constructor(
    private readonly modes: SchedulerModeService,
    private readonly preview: SchedulerPreviewService,
  ) {}

  /** Every engine: mode, health, and what it is actually capable of. */
  @Get('engines')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_VIEW)
  engines() {
    return this.modes.list();
  }

  /**
   * What the scheduler would do right now.
   *
   * A GET even though it computes: it is read-only by construction, and an
   * operator refreshing a preview should not be POSTing.
   */
  @Get('preview')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_VIEW)
  async previewAll() {
    const plans = await this.preview.previewAll();
    return {
      generatedAt: new Date().toISOString(),
      enginePlans: plans,
      limitations: plans.flatMap((p) => p.limitations),
    };
  }

  @Get('preview/:engineId')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_VIEW)
  previewEngine(@Param('engineId') engineId: string) {
    return this.preview.previewEngine(engineId);
  }

  @Get('history/:engineId')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_VIEW)
  history(@Param('engineId') engineId: string, @Query('limit') limit?: string) {
    return this.modes.history(engineId, limit ? Number(limit) : undefined);
  }

  /**
   * Change an engine's scheduling mode.
   *
   * Guarded by its own permission rather than a general torrent grant: this
   * decides whether an automated system may later act on someone's queue, which
   * is a different authority from pausing one torrent by hand.
   */
  @Put('engines/:engineId/mode')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_MANAGE_ENGINE_MODE)
  setMode(
    @Param('engineId') engineId: string,
    @Body() body: { mode?: string },
    @Req() req: Request,
  ) {
    const user = req.user as AuthenticatedUser | undefined;
    return this.modes.setMode(engineId, body?.mode as SchedulerMode, user?.id);
  }

  /**
   * Recalculate now, without waiting for the sweep.
   *
   * POST because the operator is asking for work to happen, even though the work
   * only produces a plan. It applies nothing — there is nothing to apply with.
   */
  @Post('preview/:engineId/refresh')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_VIEW)
  refresh(@Param('engineId') engineId: string) {
    return this.preview.previewEngine(engineId, new Date());
  }
}
