import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS as P } from '@ultratorrent/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { paginate, parsePage } from '../../common/pagination';
import { DiscoveryProviderRegistry } from './discovery-provider-registry.service';
import { DiscoverySyncService } from './discovery-sync.service';
import { DiscoveryPreviewService, type PreviewableTemplate } from './discovery-preview.service';
import { DiscoveryEvaluationService } from './discovery-evaluation.service';
import { DiscoveryTemplateService, type DiscoveryTemplateInput } from './discovery-template.service';
import { AcquisitionTemplateService, type AcquisitionTemplateInput } from './acquisition-template.service';

/** One provider as the Providers screen shows it. Never carries a credential. */
export interface ProviderStatus {
  provider: string;
  /** False when state exists for a provider this installation no longer configures. */
  registered: boolean;
  capabilities: string[];
  enabled: boolean;
  healthy: boolean | null;
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
    private readonly registry: DiscoveryProviderRegistry,
    private readonly sync: DiscoverySyncService,
    private readonly preview: DiscoveryPreviewService,
    private readonly evaluation: DiscoveryEvaluationService,
    private readonly templates: DiscoveryTemplateService,
    private readonly acquisition: AcquisitionTemplateService,
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

  @Post('providers/:name/enable')
  @RequirePermissions(P.MEDIA_DISCOVERY_PROVIDERS_MANAGE)
  async enableProvider(@Param('name') name: string, @Body() body: { enabled?: boolean }) {
    const enabled = body?.enabled !== false;
    return this.prisma.discoveryProviderState.upsert({
      where: { provider: name },
      create: { provider: name, enabled },
      update: { enabled },
    });
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
  createTemplate(@Body() body: DiscoveryTemplateInput) {
    return this.templates.create(body);
  }

  @Get('acquisition-templates')
  @RequirePermissions(P.MEDIA_DISCOVERY_VIEW)
  listAcquisitionTemplates() {
    return this.acquisition.list();
  }

  @Post('acquisition-templates')
  @RequirePermissions(P.MEDIA_DISCOVERY_TEMPLATES_MANAGE)
  createAcquisitionTemplate(@Body() body: AcquisitionTemplateInput) {
    return this.acquisition.create(body);
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
  runSync(@Body() body: { providers?: string[] }) {
    const names = body?.providers?.length ? body.providers : this.registry.all().map((p) => p.name);
    return this.sync.syncProviders(names);
  }

  /** Evaluate now rather than waiting for the hourly tick. */
  @Post('evaluate')
  @RequirePermissions(P.MEDIA_DISCOVERY_MANAGE)
  runEvaluation() {
    return this.evaluation.runAll();
  }
}
