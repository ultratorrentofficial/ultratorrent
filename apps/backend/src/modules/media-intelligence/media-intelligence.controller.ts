import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type MediaIntelligenceEntityType } from '@ultratorrent/shared';

import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { reqAuditContext } from '../../common/request-audit-context';
import { AuditService } from '../audit/audit.service';
import { MediaIntelligenceService } from './media-intelligence.service';
import { MediaIntelligenceProjectionService } from './media-intelligence-projection.service';
import {
  ListFindingsDto,
  ListMediaIntelligenceDto,
  MediaIntelligenceEntityParamsDto,
} from './dto/media-intelligence.dto';

const P = PERMISSIONS;

/**
 * Media Intelligence API — observational and advisory.
 *
 * Every route is a read except `refresh` and `rebuild`, and those two only
 * re-evaluate facts the owning domains already stored: they start no scan, no
 * probe, no metadata fetch and no indexer search, and they never modify media.
 *
 * **RBAC reuses the Media Manager's permissions rather than minting a family.**
 * Reads gate on `media_manager.view`, exactly as Duplicates, Unmatched and the
 * Rename Engine do — a distinct permission would silently lock existing Power
 * Users out of a read-only page. Recomputation gates on `media_manager.admin`,
 * because a whole-library rebuild is maintenance, not browsing.
 *
 * Path exposure follows the same rule as everywhere else: raw storage paths are
 * included only for callers who may already see them, so Intelligence cannot
 * become a side channel around the Media Manager's own path restrictions.
 */
@ApiTags('media-intelligence')
@ApiBearerAuth()
@Controller('media-intelligence')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MediaIntelligenceController {
  constructor(
    private readonly intelligence: MediaIntelligenceService,
    private readonly projections: MediaIntelligenceProjectionService,
    private readonly audit: AuditService,
  ) {}

  /** Aggregated counts for the Intelligence overview. */
  @Get('overview')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  overview() {
    return this.intelligence.overview();
  }

  /** Paged Media Health list, served from the derived projection. */
  @Get()
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  list(@Query() query: ListMediaIntelligenceDto) {
    return this.intelligence.list(query);
  }

  /**
   * The full unified state for one entity, assembled live.
   *
   * `includePaths` is decided here from the caller's own permissions, never
   * from a query parameter — a client must not be able to ask for more than it
   * may see.
   */
  @Get(':entityType/:entityId')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  detail(@Param() params: MediaIntelligenceEntityParamsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.intelligence.detail(
      params.entityType as MediaIntelligenceEntityType,
      params.entityId,
      { includePaths: this.maySeePaths(user) },
    );
  }

  /** Stored findings for one entity, with their lifecycle timestamps. */
  @Get(':entityType/:entityId/findings')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  findings(@Param() params: MediaIntelligenceEntityParamsDto, @Query() query: ListFindingsDto) {
    return this.intelligence.findings(
      params.entityType as MediaIntelligenceEntityType,
      params.entityId,
      query,
    );
  }

  /**
   * Re-evaluate one entity from already-stored facts.
   *
   * Audited: it is an operator-initiated action with a visible effect on what
   * the rest of the team sees, which is the line the audit log is written at.
   * Automatic evaluations are deliberately NOT audited — an unattended sweep
   * writing a row per entity would drown the trail it exists to keep readable.
   */
  @Post(':entityType/:entityId/refresh')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  async refresh(
    @Param() params: MediaIntelligenceEntityParamsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.intelligence.refresh(
      params.entityType as MediaIntelligenceEntityType,
      params.entityId,
    );
    await this.audit.record({
      userId: user?.id,
      ...reqAuditContext(req),
      action: 'media_intelligence.refresh',
      objectType: 'media_intelligence',
      objectId: `${params.entityType}:${params.entityId}`,
      metadata: { health: result.health, findings: result.findingCount },
    });
    return result;
  }

  /**
   * Rebuild the whole derived projection.
   *
   * Reads the source domains and writes only the two derived tables, so it is
   * safe to run at any time and cannot damage media. Runs inline and returns a
   * summary; concurrent calls are refused by the service rather than queued.
   */
  /*
   * Gated on `scan`, not `admin`. A rebuild is the same kind of act as a
   * library scan — recompute something library-wide from what is already on
   * disk — and `scan` is the permission Power Users actually hold. `admin` is
   * granted to no role below Administrator, so gating here would have shipped
   * a control the operators who need it cannot press.
   */
  @Post('rebuild')
  @RequirePermissions(P.MEDIA_MANAGER_SCAN)
  async rebuild(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Body() _body: unknown) {
    const summary = await this.projections.rebuildAll();
    await this.audit.record({
      userId: user?.id,
      ...reqAuditContext(req),
      action: 'media_intelligence.rebuild',
      objectType: 'media_intelligence',
      objectId: 'all',
      metadata: { ...summary },
    });
    return summary;
  }

  /**
   * Whether this caller may see raw storage paths.
   *
   * Mirrors the Media Manager's own boundary instead of inventing a second
   * one: a user who can manage libraries already sees paths there, so showing
   * them here reveals nothing new — and a user who cannot, still cannot.
   */
  private maySeePaths(user: AuthenticatedUser): boolean {
    const held = new Set(user?.permissions ?? []);
    return held.has(P.MEDIA_MANAGER_MANAGE_LIBRARIES) || held.has(P.MEDIA_MANAGER_ADMIN);
  }
}
