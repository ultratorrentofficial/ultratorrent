import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
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
import { AttentionService } from './attention/attention.service';
import { RecommendationQueryService } from './recommendations/recommendation-query.service';
import { UpgradeVerificationService } from './recommendations/upgrade-verification.service';
import { LifecyclePolicyService } from './policies/lifecycle-policy.service';
import { LifecycleEvaluationService } from './policies/lifecycle-evaluation.service';
import { AttentionDispositionService } from './attention/attention-disposition.service';
import {
  ListFindingsDto,
  ListMediaIntelligenceDto,
  MediaIntelligenceEntityParamsDto,
} from './dto/media-intelligence.dto';
import {
  BulkDispositionDto,
  DispositionDto,
  ListAttentionDto,
  SnoozeDto,
} from './dto/attention.dto';
import { ListRecommendationsDto } from './dto/recommendation.dto';
import {
  CreateLifecyclePolicyDto,
  UpdateLifecyclePolicyDto,
} from './dto/lifecycle-policy.dto';

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
    private readonly attention: AttentionService,
    private readonly dispositions: AttentionDispositionService,
    private readonly recommendations: RecommendationQueryService,
    private readonly verification: UpgradeVerificationService,
    private readonly policies: LifecyclePolicyService,
    private readonly lifecycle: LifecycleEvaluationService,
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

  /* ------------------------------------------------- Attention Center */

  /**
   * The attention queue.
   *
   * A read over persisted state: no provider, indexer, media server, probe,
   * filesystem or torrent-engine call happens here, and nothing triggers a
   * rebuild. An operational inbox that fanned out to the network on every
   * glance is a page people learn not to open.
   */
  @Get('attention')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  listAttention(@Query() query: ListAttentionDto) {
    // Both shapes share one predicate and one set of filters; only the unit
    // of paging differs (findings vs titles).
    return query.groupBy === 'media' ? this.attention.listGrouped(query) : this.attention.list(query);
  }

  /** Counts for the queue, derived from the same predicate as the list. */
  @Get('attention/summary')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  attentionSummary() {
    return this.attention.summary();
  }

  /** One finding's transitions. Loaded on detail only, never per list row. */
  @Get('attention/:findingId/history')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  findingHistory(@Param('findingId') findingId: string) {
    return this.attention.history(findingId);
  }

  /*
   * Disposition gates on `view`, not `scan`.
   *
   * Deciding you do not want to be asked about a finding is a workflow act,
   * not a library-wide recomputation — it changes no media and no fact. Any
   * operator who can open the queue can triage it; gating triage behind the
   * rebuild permission would hand people a list they are forbidden to act on.
   * The REMEDIATION each finding points at keeps its own owning module's
   * permission, which is where the real authority lives.
   */
  /*
   * Bulk routes are declared BEFORE their single-finding counterparts, and
   * this block sits above the generic `:entityType/:entityId` media routes.
   * Nest matches in declaration order, so `attention/:findingId/dismiss`
   * placed first would answer `/attention/bulk/dismiss` with findingId="bulk"
   * — the literal route would simply never run. A repo-wide gate checks this,
   * because the same shape once silently disabled duplicate detection for
   * several releases without anything failing loudly.
   */
  @Post('attention/bulk/acknowledge')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  bulkAcknowledge(@Body() body: BulkDispositionDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.disposition('acknowledge', body.findingIds, body.reason, undefined, user, req, true);
  }

  @Post('attention/bulk/snooze')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  bulkSnooze(@Body() body: BulkDispositionDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.disposition('snooze', body.findingIds, body.reason, body.snoozedUntil, user, req, true);
  }

  @Post('attention/bulk/dismiss')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  bulkDismiss(@Body() body: BulkDispositionDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.disposition('dismiss', body.findingIds, body.reason, undefined, user, req, true);
  }

  @Post('attention/:findingId/acknowledge')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  acknowledge(
    @Param('findingId') findingId: string,
    @Body() body: DispositionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.disposition('acknowledge', [findingId], body?.reason, undefined, user, req);
  }

  @Post('attention/:findingId/snooze')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  snooze(
    @Param('findingId') findingId: string,
    @Body() body: SnoozeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.disposition('snooze', [findingId], body?.reason, body?.snoozedUntil, user, req);
  }

  @Post('attention/:findingId/dismiss')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  dismiss(
    @Param('findingId') findingId: string,
    @Body() body: DispositionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.disposition('dismiss', [findingId], body?.reason, undefined, user, req);
  }

  /** Clear a disposition and return the finding to the unreviewed queue. */
  @Post('attention/:findingId/reset')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  resetDisposition(
    @Param('findingId') findingId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.disposition('reset', [findingId], undefined, undefined, user, req);
  }

  /**
   * One operator action, one audit row.
   *
   * Single and bulk share this, because a bulk action of one is not a
   * different act. The audit records the whole selection rather than a row
   * per finding — a dismissal of two hundred findings is one decision a
   * person made, and two hundred rows would bury the trail it belongs to.
   */
  private async disposition(
    action: 'acknowledge' | 'snooze' | 'dismiss' | 'reset',
    findingIds: readonly string[],
    reason: string | undefined,
    snoozedUntil: string | undefined,
    user: AuthenticatedUser,
    req: Request,
    bulk = false,
  ) {
    const result = await this.dispositions.apply(action, findingIds, user.id, { reason, snoozedUntil });
    await this.audit.record({
      userId: user?.id,
      ...reqAuditContext(req),
      action: `media_intelligence.finding.${bulk ? 'bulk_' : ''}${action}`,
      objectType: 'media_intelligence_finding',
      objectId: bulk ? 'bulk' : findingIds[0],
      metadata: {
        count: findingIds.length,
        applied: result.applied,
        ...(result.unknown.length ? { unknown: result.unknown.length } : {}),
        ...(result.skippedResolved.length ? { skippedResolved: result.skippedResolved.length } : {}),
        ...(snoozedUntil ? { snoozedUntil } : {}),
      },
    });
    return result;
  }

  /*
   * Recommendations.
   *
   * Every route here is a READ over persisted state. Opening this list starts
   * no indexer search, no probe and no provider call — availability is
   * established only by an explicit verification, never as a side effect of
   * looking at the queue.
   *
   * Declared ABOVE the generic `:entityType/:entityId` routes below. Nest
   * matches in declaration order and both `recommendations/summary` and
   * `recommendations/:id` are two segments, so placing either beneath the
   * parameterised pair would make it answer as entityType="recommendations"
   * and never run. A repo-wide gate enforces this; Phase 3 shipped four
   * unreachable routes of exactly this shape before it existed.
   */
  @Get('recommendations')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  listRecommendations(@Query() query: ListRecommendationsDto) {
    return this.recommendations.list(query);
  }

  /** Counts, derived from the same predicate as the list. */
  @Get('recommendations/summary')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  recommendationSummary() {
    return this.recommendations.summary();
  }

  /** Every active recommendation for one finding. Loaded by the drawer. */
  @Get('recommendations/finding/:findingId')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  recommendationsForFinding(@Param('findingId') findingId: string) {
    return this.recommendations.forFinding(findingId);
  }

  /** One recommendation in full. */
  @Get('recommendations/:id')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  recommendation(@Param('id') id: string) {
    return this.recommendations.byId(id);
  }

  /*
   * Establish whether a better release can ACTUALLY be obtained.
   *
   * The ONLY route in this module that reaches outside the installation, and
   * it runs only because a person pressed something. Gated on `scan` rather
   * than `view` — reading the queue must never be able to make the system go
   * and ask an indexer — and deliberately single-target: Phase 4 ships no
   * "verify my whole library", because fanning out across thousands of
   * titles is a policy decision, not a button.
   *
   * It downloads nothing. A verified candidate is a normalized snapshot; the
   * grab stays with Media Acquisition behind that module's own permission.
   */
  @Post('recommendations/:id/verify')
  @RequirePermissions(P.MEDIA_MANAGER_SCAN)
  async verifyRecommendation(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Body() _body: unknown,
  ) {
    const result = await this.verification.verify(id);
    await this.audit.record({
      userId: user?.id,
      ...reqAuditContext(req),
      action: 'media_intelligence.recommendation.verified',
      objectType: 'media_intelligence_recommendation',
      objectId: id,
      metadata: {
        status: result.status,
        candidates: result.candidates.length,
        indexersQueried: result.indexersQueried,
        indexersFailed: result.indexersFailed,
      },
    });
    return result;
  }

  /*
   * Lifecycle policies — operator intent.
   *
   * The only mutable, NON-derived state in this module: everything else here
   * is a conclusion that can be rebuilt, and these rows are what a person
   * asked for. Reads stay on `media_manager.view`, matching the rest of Media
   * Intelligence; authoring requires its own permission, because stating what
   * the system should maintain is a different privilege from reading what it
   * observed — and Phase 6 will act on these rows.
   *
   * Declared ABOVE the generic `:entityType/:entityId` routes. `policies/:id`
   * is two segments and would otherwise be answered as
   * entityType="policies", which is exactly the shape that shipped four
   * unreachable routes in Phase 3.
   */
  @Get('policies')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  listPolicies() {
    return this.policies.list();
  }

  @Get('policies/:id')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  policy(@Param('id') id: string) {
    return this.policies.byId(id);
  }

  @Post('policies')
  @RequirePermissions(P.MEDIA_LIFECYCLE_POLICY_MANAGE)
  createPolicy(
    @Body() dto: CreateLifecyclePolicyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.policies.create(dto as never, user?.id, reqAuditContext(req));
  }

  @Patch('policies/:id')
  @RequirePermissions(P.MEDIA_LIFECYCLE_POLICY_MANAGE)
  updatePolicy(
    @Param('id') id: string,
    @Body() dto: UpdateLifecyclePolicyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.policies.update(id, dto as never, user?.id, reqAuditContext(req));
  }

  /**
   * Remove operator intent — and only that.
   *
   * Deletes no media, no findings and no history. Derived desired state
   * rebuilds from whatever policies remain.
   */
  @Delete('policies/:id')
  @RequirePermissions(P.MEDIA_LIFECYCLE_POLICY_MANAGE)
  deletePolicy(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.policies.remove(id, user?.id, reqAuditContext(req));
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
  /**
   * What the operator wants for this entity, and which policy said so.
   *
   * Resolvable from the policies and the entity's scope keys alone, so it
   * stays cheap even where a full evaluation would not be. Every dimension
   * carries its provenance — which policy supplied it, whether it was
   * inherited, and what it overrode — because a desired state that cannot
   * cite its source is not something an operator can argue with.
   */
  @Get(':entityType/:entityId/desired-state')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  desiredState(@Param() params: MediaIntelligenceEntityParamsDto) {
    return this.lifecycle.desiredState(
      params.entityType as MediaIntelligenceEntityType,
      params.entityId,
    );
  }

  /**
   * Desired state, actual state, and the difference.
   *
   * A READ over facts that already exist: no indexer, no provider, no probe,
   * no media server. `unknown` is a first-class answer here and never
   * collapses into either `compliant` or `drift` — an unmeasured file is not
   * wrong, and a library nobody could measure is not healthy.
   */
  @Get(':entityType/:entityId/drift')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  drift(@Param() params: MediaIntelligenceEntityParamsDto) {
    return this.lifecycle.evaluate(
      params.entityType as MediaIntelligenceEntityType,
      params.entityId,
    );
  }

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
