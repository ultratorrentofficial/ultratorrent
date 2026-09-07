import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS as P } from '@ultratorrent/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { reqAuditContext } from '../../common/request-audit-context';
import { paginate, parsePage } from '../../common/pagination';
import { DiscoveryProviderRegistry } from './discovery-provider-registry.service';
import { DiscoverySyncService } from './discovery-sync.service';
import { DiscoveryPreviewService, type PreviewableTemplate } from './discovery-preview.service';
import { DiscoveryEvaluationService } from './discovery-evaluation.service';
import { DiscoveryTemplateService, type DiscoveryTemplateInput } from './discovery-template.service';
import { AcquisitionTemplateService, type AcquisitionTemplateInput } from './acquisition-template.service';
import { DiscoveryRemovalService, type RemovalScope } from './discovery-removal.service';
import { DiscoveryReconciliationService } from './discovery-reconciliation.service';

/** Validated rather than trusted: an unknown scope must never fall through. */
const REMOVAL_SCOPES: RemovalScope[] = ['catalog', 'monitoring', 'library'];
const TORRENT_ACTIONS = ['keep', 'stop', 'stop_and_delete'] as const;

/**
 * Where each provider's credential lives, for a provider that is not registered.
 *
 * The VALUE is a location, never a secret — this endpoint must not carry a key,
 * and saying where one is set is not the same as saying what it is.
 */
const CONFIGURATION_HINTS: Record<string, string> = {
  tmdb: 'Set a TMDB API key in Media Manager settings; Discovery reuses the same key.',
};

/** One provider as the Providers screen shows it. Never carries a credential. */
export interface ProviderStatus {
  provider: string;
  /** False when state exists for a provider this installation no longer configures. */
  registered: boolean;
  capabilities: string[];
  enabled: boolean;
  healthy: boolean | null;
  /**
   * What an operator must do to make an unregistered provider usable.
   *
   * "Not configured" without saying WHERE is a dead end — the TMDB key lives in
   * Media Manager settings, which is not a place anyone would guess from a
   * Discovery screen.
   */
  configurationHint: string | null;
  lastSuccessfulSync: Date | null;
  lastFailureAt: Date | null;
  lastFailureReason: string | null;
  lastResponseMs: number | null;
  itemsDiscovered: number;
}

/**
 * The Discovery API.
 *
 * Reading is separated from acting throughout: `media_discovery.view` opens the
 * inbox, `media_discovery.manage` acts on what is in it, and configuring the
 * automation that fills it needs `templates.manage` or `providers.manage`.
 * Seeing what was discovered and deciding that the system should acquire things
 * on its own are different privileges.
 *
 * **No endpoint here calls a provider.** A sync is queued against the existing
 * background service; the inbox reads the database. A page load must never wait
 * on TMDB.
 */
@ApiTags('media-discovery')
@ApiBearerAuth()
@Controller('media-discovery')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MediaDiscoveryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: DiscoveryProviderRegistry,
    private readonly sync: DiscoverySyncService,
    private readonly preview: DiscoveryPreviewService,
    private readonly evaluation: DiscoveryEvaluationService,
    private readonly templates: DiscoveryTemplateService,
    private readonly acquisition: AcquisitionTemplateService,
    private readonly removal: DiscoveryRemovalService,
    private readonly reconciliation: DiscoveryReconciliationService,
  ) {}

  // --- providers -----------------------------------------------------------
  /**
   * Provider health, from the stored state rather than by probing.
   *
   * Probing here would make a page load wait on a third party, and would report a
   * transient blip as the provider's condition rather than what its last sync
   * actually did.
   */
  @Get('providers')
  @RequirePermissions(P.MEDIA_DISCOVERY_VIEW)
  async providers(): Promise<ProviderStatus[]> {
    const stored = await this.prisma.discoveryProviderState.findMany({ orderBy: { provider: 'asc' } });
    const registered = new Set(this.registry.all().map((p) => p.name));

    const live: ProviderStatus[] = this.registry.all().map((p) => {
      const row = stored.find((s) => s.provider === p.name);
      return {
        provider: p.name,
        registered: true,
        configurationHint: null,
        capabilities: p.capabilities(),
        enabled: row?.enabled ?? false,
        healthy: row?.healthy ?? null,
        lastSuccessfulSync: row?.lastSuccessfulSync ?? null,
        lastFailureAt: row?.lastFailureAt ?? null,
        lastFailureReason: row?.lastFailureReason ?? null,
        lastResponseMs: row?.lastResponseMs ?? null,
        itemsDiscovered: row?.itemsDiscovered ?? 0,
      };
    });

    /*
     * A provider with stored state but no registration — usually an API key that
     * was removed. Reported rather than silently vanishing from the list, or an
     * operator is left wondering why a source stopped producing anything.
     */
    const orphaned: ProviderStatus[] = stored
      .filter((s) => !registered.has(s.provider))
      .map((s) => ({
        provider: s.provider,
        registered: false,
        configurationHint: CONFIGURATION_HINTS[s.provider] ?? null,
        capabilities: s.capabilities,
        enabled: s.enabled,
        healthy: false,
        lastSuccessfulSync: s.lastSuccessfulSync,
        lastFailureAt: s.lastFailureAt,
        lastFailureReason: 'Not configured on this installation',
        lastResponseMs: s.lastResponseMs,
        itemsDiscovered: s.itemsDiscovered,
      }));

    return [...live, ...orphaned];
  }

  /**
   * Enabling a provider is the moment this installation starts calling a third
   * party, so it is audited. Disabling is audited for the same reason in reverse:
   * a catalogue that stopped refreshing should have a traceable cause.
   */
  @Post('providers/:name/enable')
  @RequirePermissions(P.MEDIA_DISCOVERY_PROVIDERS_MANAGE)
  async enableProvider(
    @Param('name') name: string,
    @Body() body: { enabled?: boolean },
    @Req() req: Request,
  ) {
    const enabled = body?.enabled !== false;
    const row = await this.prisma.discoveryProviderState.upsert({
      where: { provider: name },
      create: { provider: name, enabled },
      update: { enabled },
    });
    await this.audit.record({
      userId: userId(req),
      ...reqAuditContext(req),
      action: enabled ? 'media_discovery.provider.enabled' : 'media_discovery.provider.disabled',
      objectType: 'discovery_provider',
      objectId: name,
      metadata: { provider: name, enabled },
    });
    return row;
  }

  // --- the inbox -----------------------------------------------------------
  /**
   * Discovered titles, filtered and paginated.
   *
   * Always bounded: the catalogue is thousands of rows and a discovery page is a
   * view of it, never an export.
   */
  @Get('inbox')
  @RequirePermissions(P.MEDIA_DISCOVERY_VIEW)
  async inbox(
    @Query('status') status?: string,
    @Query('decision') decision?: string,
    @Query('mediaType') mediaType?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const where = {
      ...(status ? { discoveryStatus: status } : {}),
      ...(decision ? { decision } : {}),
      ...(mediaType ? { mediaType } : {}),
      ...(search ? { title: { contains: search, mode: 'insensitive' as const } } : {}),
    };
    return paginate(
      this.prisma.discoveredMedia,
      {
        where,
        orderBy: [{ lastSeenAt: 'desc' }],
        include: { releaseDates: { orderBy: { date: 'asc' } } },
      },
      parsePage(page, pageSize),
    );
  }

  /** One title with the reasoning behind every decision made about it. */
  @Get('items/:id')
  @RequirePermissions(P.MEDIA_DISCOVERY_VIEW)
  item(@Param('id') id: string) {
    return this.prisma.discoveredMedia.findUnique({
      where: { id },
      include: {
        releaseDates: { orderBy: { date: 'asc' } },
        evaluations: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
  }

  // --- templates -----------------------------------------------------------
  @Get('templates')
  @RequirePermissions(P.MEDIA_DISCOVERY_VIEW)
  listTemplates() {
    return this.templates.list();
  }

  @Post('templates')
  @RequirePermissions(P.MEDIA_DISCOVERY_TEMPLATES_MANAGE)
  createTemplate(@Body() body: DiscoveryTemplateInput, @Req() req: Request) {
    return this.templates.create(body, userId(req));
  }

  @Patch('templates/:id')
  @RequirePermissions(P.MEDIA_DISCOVERY_TEMPLATES_MANAGE)
  updateTemplate(@Param('id') id: string, @Body() body: DiscoveryTemplateInput, @Req() req: Request) {
    return this.templates.update(id, body, userId(req));
  }

  @Delete('templates/:id')
  @RequirePermissions(P.MEDIA_DISCOVERY_TEMPLATES_MANAGE)
  deleteTemplate(@Param('id') id: string, @Req() req: Request) {
    return this.templates.remove(id, userId(req));
  }

  @Get('acquisition-templates')
  @RequirePermissions(P.MEDIA_DISCOVERY_VIEW)
  listAcquisitionTemplates() {
    return this.acquisition.list();
  }

  @Post('acquisition-templates')
  @RequirePermissions(P.MEDIA_DISCOVERY_TEMPLATES_MANAGE)
  createAcquisitionTemplate(@Body() body: AcquisitionTemplateInput, @Req() req: Request) {
    return this.acquisition.create(body, userId(req));
  }

  @Patch('acquisition-templates/:id')
  @RequirePermissions(P.MEDIA_DISCOVERY_TEMPLATES_MANAGE)
  updateAcquisitionTemplate(
    @Param('id') id: string,
    @Body() body: AcquisitionTemplateInput,
    @Req() req: Request,
  ) {
    return this.acquisition.update(id, body, userId(req));
  }

  @Delete('acquisition-templates/:id')
  @RequirePermissions(P.MEDIA_DISCOVERY_TEMPLATES_MANAGE)
  deleteAcquisitionTemplate(@Param('id') id: string, @Req() req: Request) {
    return this.acquisition.remove(id, userId(req));
  }

  /**
   * The feeds, storage profiles and acquisition templates a discovery template
   * can point at, in one call.
   *
   * One request rather than three because they are only ever needed together —
   * the template form cannot be filled in without all of them, and three
   * round-trips would show it half-populated on a slow connection.
   */
  @Get('template-options')
  @RequirePermissions(P.MEDIA_DISCOVERY_TEMPLATES_MANAGE)
  async templateOptions() {
    const [feeds, profiles, acquisitionTemplates] = await Promise.all([
      this.prisma.rssFeed.findMany({
        select: { id: true, name: true, isEnabled: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.storageProfile.findMany({
        select: { id: true, name: true, isEnabled: true, stagingRoot: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.acquisitionRuleTemplate.findMany({
        select: { id: true, name: true, mediaType: true, version: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return { feeds, profiles, acquisitionTemplates };
  }

  // --- preview and run -----------------------------------------------------
  /**
   * What a template WOULD do. Writes nothing, and takes the template by value so
   * an unsaved one can be previewed.
   *
   * Guarded by `templates.manage` rather than `view`: previewing is part of
   * configuring automation, and it reads the whole catalogue.
   */
  @Post('preview')
  @RequirePermissions(P.MEDIA_DISCOVERY_TEMPLATES_MANAGE)
  runPreview(@Body() body: PreviewableTemplate) {
    return this.preview.preview(body);
  }

  /**
   * Ask the background sync to refresh a provider's catalogue.
   *
   * The provider call happens in the sync service, not in this request — no
   * endpoint here waits on a third party.
   */
  @Post('sync')
  @RequirePermissions(P.MEDIA_DISCOVERY_PROVIDERS_MANAGE)
  async runSync(@Body() body: { providers?: string[] }, @Req() req: Request) {
    const names = body?.providers?.length ? body.providers : this.registry.all().map((p) => p.name);
    await this.audit.record({
      userId: userId(req),
      ...reqAuditContext(req),
      action: 'media_discovery.sync.requested',
      objectType: 'discovery_provider',
      objectId: names.join(','),
      metadata: { providers: names },
    });
    const outcomes = await this.sync.syncProviders(names);

    /*
     * A manual refresh re-decides the whole catalogue, not just what is new.
     *
     * "Refresh catalogues" is pressed after editing a template, and the question
     * being asked is "apply what I just changed". Returning only newly-fetched
     * titles answered a different question and left every already-decided title
     * on its old verdict — which looked exactly like the edit had done nothing.
     *
     * The evaluation is awaited rather than fired and forgotten: the caller is a
     * person watching a button, and a count they can read is the point.
     */
    const evaluations = await this.evaluation.runAll();
    return {
      providers: outcomes,
      evaluation: {
        templates: evaluations.length,
        examined: evaluations.reduce((n, e) => n + e.examined, 0),
        monitored: evaluations.reduce((n, e) => n + e.monitored, 0),
        retracted: evaluations.reduce((n, e) => n + e.retracted, 0),
        removedFromCatalog: evaluations.reduce((n, e) => n + e.removedFromCatalog, 0),
      },
    };
  }

  // --- catalogue management -------------------------------------------------

  /**
   * What removing this title would touch, without touching any of it.
   *
   * `view` rather than `manage`: reading the consequences of an action is not
   * the action, and somebody deciding whether to ask an admin to delete
   * something needs to be able to see what it would cost.
   */
  @Get('items/:id/removal-plan')
  @RequirePermissions(P.MEDIA_DISCOVERY_VIEW)
  removalPlan(@Param('id') id: string) {
    return this.removal.plan(id);
  }

  /**
   * Remove a discovered title, at the scope the caller names.
   *
   * `library` scope deletes media files, so it requires `manage` and is never
   * the default — the body must ask for it explicitly. The scope is validated
   * here rather than trusted, because an unrecognised value silently falling
   * through to the most destructive branch is the worst possible failure.
   */
  @Delete('items/:id')
  @RequirePermissions(P.MEDIA_DISCOVERY_MANAGE)
  async removeItem(
    @Param('id') id: string,
    @Body() body: { scope?: string; torrentAction?: string },
    @Req() req: Request,
  ) {
    const scope = body?.scope ?? 'catalog';
    if (!REMOVAL_SCOPES.includes(scope as RemovalScope)) {
      throw new BadRequestException(
        `Unknown removal scope "${scope}". Expected one of: ${REMOVAL_SCOPES.join(', ')}`,
      );
    }
    const torrentAction = body?.torrentAction ?? 'keep';
    if (!TORRENT_ACTIONS.includes(torrentAction as (typeof TORRENT_ACTIONS)[number])) {
      throw new BadRequestException(
        `Unknown torrent action "${torrentAction}". Expected one of: ${TORRENT_ACTIONS.join(', ')}`,
      );
    }
    return this.removal.remove(
      id,
      { scope: scope as RemovalScope, torrentAction: torrentAction as never },
      userId(req),
      reqAuditContext(req),
    );
  }

  // --- duplicate reconciliation --------------------------------------------

  /**
   * Shows being monitored more than once.
   *
   * `view`, because reading a report is not acting on it — and somebody who
   * cannot merge still needs to be able to see what is wrong and ask.
   */
  @Get('duplicates')
  @RequirePermissions(P.MEDIA_DISCOVERY_VIEW)
  duplicates() {
    return this.reconciliation.scan();
  }

  /** What merging these would do. Writes nothing. */
  @Post('duplicates/plan')
  @RequirePermissions(P.MEDIA_DISCOVERY_VIEW)
  duplicatePlan(@Body() body: { keepId?: string; archiveIds?: string[] }) {
    if (!body?.keepId) throw new BadRequestException('keepId is required.');
    return this.reconciliation.plan(body.keepId, body.archiveIds ?? []);
  }

  /**
   * Merge duplicates an operator has reviewed.
   *
   * The losers are archived rather than deleted, and no media, torrent or
   * hand-authored rule is touched — see `DiscoveryReconciliationService`.
   */
  @Post('duplicates/merge')
  @RequirePermissions(P.MEDIA_DISCOVERY_MANAGE)
  mergeDuplicates(
    @Body() body: { keepId?: string; archiveIds?: string[] },
    @Req() req: Request,
  ) {
    if (!body?.keepId) throw new BadRequestException('keepId is required.');
    if (!body?.archiveIds?.length) throw new BadRequestException('archiveIds must name at least one entry.');
    return this.reconciliation.merge(body.keepId, body.archiveIds, userId(req), reqAuditContext(req));
  }

  /** Titles held out of the catalogue, and why. */
  @Get('suppressions')
  @RequirePermissions(P.MEDIA_DISCOVERY_VIEW)
  suppressions() {
    return this.prisma.discoverySuppression.findMany({ orderBy: { suppressedAt: 'desc' }, take: 500 });
  }

  /** Let a removed title be discovered again on the next refresh. */
  @Delete('suppressions/:dedupeKey')
  @RequirePermissions(P.MEDIA_DISCOVERY_MANAGE)
  unsuppress(@Param('dedupeKey') dedupeKey: string, @Req() req: Request) {
    return this.removal.unsuppress(decodeURIComponent(dedupeKey), userId(req));
  }

  /**
   * Evaluate now rather than waiting for the hourly tick.
   *
   * **The most consequential endpoint here.** A run can create watchlist entries
   * and generate acquisition rules, so it is audited BEFORE it runs — an
   * evaluation that half-completed and then threw would otherwise leave the
   * things it created with nothing recording who asked for them.
   */
  @Post('evaluate')
  @RequirePermissions(P.MEDIA_DISCOVERY_MANAGE)
  async runEvaluation(@Req() req: Request) {
    await this.audit.record({
      userId: userId(req),
      ...reqAuditContext(req),
      action: 'media_discovery.evaluation.requested',
      objectType: 'discovery_template',
      objectId: 'all_enabled',
    });
    return this.evaluation.runAll();
  }
}

/** The acting user, for the audit rows these services write. */
function userId(req: Request): string | undefined {
  return (req as Request & { user?: { sub?: string; id?: string } }).user?.sub
    ?? (req as Request & { user?: { id?: string } }).user?.id;
}
