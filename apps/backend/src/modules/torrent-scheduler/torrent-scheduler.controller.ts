import {
  Body,
  Controller,
  Delete,
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
import { SchedulerActivationService } from './scheduler-activation.service';
import { SchedulerPolicyService, type PolicyInput } from './scheduler-policy.service';
import { SchedulerOverrideService, type OverrideInput } from './scheduler-override.service';
import type { SchedulerMode } from './scheduler-sweep.service';

/**
 * The scheduler's read surface, the mode switch, and the guarded activation flow.
 *
 * Enforcement is deliberately NOT reachable through the mode endpoint. Enabling
 * it means UltraTorrent starts pausing torrents, so it goes through activation:
 * a capability check, a preview of exactly which torrents are affected, and an
 * explicit confirmation. One PUT should not be able to start that.
 */
@ApiTags('torrent-scheduler')
@ApiBearerAuth()
@Controller('torrent-scheduler')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TorrentSchedulerController {
  constructor(
    private readonly modes: SchedulerModeService,
    private readonly preview: SchedulerPreviewService,
    private readonly activation: SchedulerActivationService,
    private readonly policies: SchedulerPolicyService,
    private readonly overrides: SchedulerOverrideService,
  ) {}

  // --- per-torrent overrides ---------------------------------------------
  @Get('torrents/:engineId/overrides')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_VIEW)
  listOverrides(@Param('engineId') engineId: string) {
    return this.overrides.list(engineId);
  }

  @Post('torrents/:engineId/:hash/override')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_OVERRIDE)
  setOverride(
    @Param('engineId') engineId: string,
    @Param('hash') hash: string,
    @Body() body: OverrideInput,
    @Req() req: Request,
  ) {
    return this.overrides.set(
      engineId, hash, body ?? {}, (req.user as AuthenticatedUser | undefined)?.id,
    );
  }

  @Delete('torrents/:engineId/:hash/override/:kind')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_OVERRIDE)
  clearOverride(
    @Param('engineId') engineId: string,
    @Param('hash') hash: string,
    @Param('kind') kind: string,
    @Req() req: Request,
  ) {
    return this.overrides.clear(
      engineId, hash, kind, (req.user as AuthenticatedUser | undefined)?.id,
    );
  }

  // --- policies ----------------------------------------------------------
  @Get('policies')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_VIEW)
  listPolicies() {
    return this.policies.list();
  }

  @Post('policies')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_MANAGE_POLICIES)
  createPolicy(@Body() body: PolicyInput, @Req() req: Request) {
    return this.policies.create(body ?? {}, (req.user as AuthenticatedUser | undefined)?.id);
  }

  @Put('policies/:id')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_MANAGE_POLICIES)
  updatePolicy(@Param('id') id: string, @Body() body: PolicyInput, @Req() req: Request) {
    return this.policies.update(id, body ?? {}, (req.user as AuthenticatedUser | undefined)?.id);
  }

  @Delete('policies/:id')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_MANAGE_POLICIES)
  deletePolicy(@Param('id') id: string, @Req() req: Request) {
    return this.policies.remove(id, (req.user as AuthenticatedUser | undefined)?.id);
  }

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

  /** What enabling enforcement would do to this engine, right now. */
  @Get('engines/:engineId/activation')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_MANAGE_ENGINE_MODE)
  describeActivation(@Param('engineId') engineId: string) {
    return this.activation.describe(engineId);
  }

  /**
   * Enable enforcement.
   *
   * `confirm: true` is mandatory; without it the request is refused with what
   * would have happened, so enforcement can only be reached by asking twice.
   */
  @Post('engines/:engineId/activate')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_MANAGE_ENGINE_MODE)
  activate(
    @Param('engineId') engineId: string,
    @Body() body: { confirm?: boolean },
    @Req() req: Request,
  ) {
    const user = req.user as AuthenticatedUser | undefined;
    return this.activation.activate(engineId, body?.confirm === true, user?.id);
  }

  /**
   * Stop enforcing. Torrents the scheduler paused stay paused unless
   * `resumePaused` is asked for — blanket-resuming would start downloads nobody
   * chose to start.
   */
  @Post('engines/:engineId/deactivate')
  @RequirePermissions(PERMISSIONS.TORRENT_SCHEDULER_MANAGE_ENGINE_MODE)
  deactivate(
    @Param('engineId') engineId: string,
    @Body() body: { resumePaused?: boolean },
    @Req() req: Request,
  ) {
    const user = req.user as AuthenticatedUser | undefined;
    return this.activation.deactivate(engineId, body?.resumePaused === true, user?.id);
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
