import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import type { IntakeState } from '@ultratorrent/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { MediaIntakeService } from './media-intake.service';
import { StorageProfileService, type StorageProfileInput } from './storage-profile.service';
import { PathMappingRegistryService } from './path-mapping-registry.service';
import { StorageCapabilityDetector } from './storage-capability-detector.service';
import { IntakePipelineService } from './intake-pipeline.service';
import { IntakeMigrationService } from './intake-migration.service';

const P = PERMISSIONS;

/**
 * The Media Intake REST surface.
 *
 * Static segments are declared before any `:id` route so Nest cannot shadow
 * them — `profiles/defaults` must not be read as a profile called "defaults".
 *
 * Permissions are split three ways on purpose: reading the dashboard, changing
 * configuration, and acting on a running intake are different privileges, and a
 * single `manage` covering all three would make read-only monitoring impossible
 * to grant.
 */
@ApiTags('media-intake')
@ApiBearerAuth()
@Controller('media/intake')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MediaIntakeController {
  constructor(
    private readonly intake: MediaIntakeService,
    private readonly profiles: StorageProfileService,
    private readonly paths: PathMappingRegistryService,
    private readonly capabilities: StorageCapabilityDetector,
    private readonly pipeline: IntakePipelineService,
    private readonly migration: IntakeMigrationService,
  ) {}

  // --- dashboard ----------------------------------------------------------
  /** Counts per state — the queue summary, in one query. */
  @Get('summary')
  @RequirePermissions(P.MEDIA_INTAKE_VIEW)
  summary() {
    return this.intake.summary();
  }

  @Get('jobs')
  @RequirePermissions(P.MEDIA_INTAKE_VIEW)
  jobs(@Query('state') state?: string, @Query('active') active?: string) {
    return this.intake.list({ state, active: active === '1' || active === 'true' });
  }

  @Get('jobs/:id')
  @RequirePermissions(P.MEDIA_INTAKE_VIEW)
  job(@Param('id') id: string) {
    return this.intake.detail(id);
  }

  /**
   * Stage something by hand — a watched folder, a manual grab, or a test.
   *
   * The engine is deliberately not torrent-only: an intake needs a path and a
   * profile, and where those came from is not its business.
   */
  @Post('jobs')
  @RequirePermissions(P.MEDIA_INTAKE_OPERATE)
  async enqueue(@Body() body: { profileId?: string; sourcePath?: string; engineId?: string | null }) {
    if (!body?.profileId || !body?.sourcePath) {
      throw new BadRequestException('profileId and sourcePath are required.');
    }
    const job = await this.intake.enqueue({
      profileId: body.profileId,
      sourcePath: body.sourcePath,
      engineId: body.engineId ?? null,
    });
    const result = await this.pipeline.advance(job.id);
    return { job, result };
  }

  /** Run the pipeline from wherever this intake currently sits. */
  @Post('jobs/:id/advance')
  @RequirePermissions(P.MEDIA_INTAKE_OPERATE)
  advance(@Param('id') id: string) {
    return this.pipeline.advance(id);
  }

  // --- operating a running intake -----------------------------------------
  /** Put a failed intake back in at the stage it stopped. */
  @Post('jobs/:id/retry')
  @RequirePermissions(P.MEDIA_INTAKE_OPERATE)
  retry(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.intake.retry(id, u?.id);
  }

  @Post('jobs/:id/cancel')
  @RequirePermissions(P.MEDIA_INTAKE_OPERATE)
  cancel(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.intake.transition(id, 'cancelled', { message: 'Cancelled by operator', userId: u?.id });
  }

  /**
   * Release a quarantined intake back into the pipeline.
   *
   * The state machine decides where it may resume; it can never jump straight
   * to import, because whatever caused the quarantine was never re-checked.
   */
  @Post('jobs/:id/release')
  @RequirePermissions(P.MEDIA_INTAKE_OPERATE)
  release(
    @Param('id') id: string,
    @Body() body: { resumeAt?: IntakeState; note?: string },
    @CurrentUser() u: AuthenticatedUser,
  ) {
    return this.intake.transition(id, body?.resumeAt ?? 'verified', {
      message: body?.note ?? 'Quarantine released',
      userId: u?.id,
    });
  }

  // --- storage profiles ---------------------------------------------------
  @Get('profiles')
  @RequirePermissions(P.MEDIA_INTAKE_VIEW)
  listProfiles() {
    return this.profiles.list();
  }

  @Post('profiles')
  @RequirePermissions(P.MEDIA_INTAKE_MANAGE)
  createProfile(@Body() body: StorageProfileInput) {
    return this.profiles.create(body ?? {});
  }

  @Get('profiles/:id')
  @RequirePermissions(P.MEDIA_INTAKE_VIEW)
  profile(@Param('id') id: string) {
    return this.profiles.get(id);
  }

  @Patch('profiles/:id')
  @RequirePermissions(P.MEDIA_INTAKE_MANAGE)
  updateProfile(@Param('id') id: string, @Body() body: StorageProfileInput) {
    return this.profiles.update(id, body ?? {});
  }

  @Delete('profiles/:id')
  @RequirePermissions(P.MEDIA_INTAKE_MANAGE)
  removeProfile(@Param('id') id: string) {
    return this.profiles.remove(id);
  }

  /**
   * Measure what this profile's storage can do.
   *
   * A write — it creates and deletes scratch files under the target — so it is
   * a POST and needs `manage`, not `view`.
   */
  @Post('profiles/:id/probe')
  @RequirePermissions(P.MEDIA_INTAKE_MANAGE)
  async probe(
    @Param('id') id: string,
    @Body() body: { targetRoot?: string; engineId?: string | null },
  ) {
    const profile = await this.profiles.get(id);
    const target = body?.targetRoot?.trim()
      || profile.movieLibrary?.path
      || profile.tvLibrary?.path
      || profile.stagingRoot;
    return this.capabilities.probe(id, profile.stagingRoot, target, body?.engineId ?? null);
  }

  // --- path mapping registry ----------------------------------------------
  @Get('path-mappings')
  @RequirePermissions(P.MEDIA_INTAKE_VIEW)
  listMappings() {
    return this.paths.list();
  }

  @Post('path-mappings')
  @RequirePermissions(P.MEDIA_INTAKE_MANAGE)
  createMapping(@Body() body: { space: string; fromPrefix: string; toPrefix: string; scopeId?: string | null; priority?: number; isEnabled?: boolean }) {
    return this.paths.create(body);
  }

  /** Resolve a path into another space — the diagnostic for a mapping that looks wrong. */
  @Get('path-mappings/resolve')
  @RequirePermissions(P.MEDIA_INTAKE_VIEW)
  async resolve(
    @Query('path') path: string,
    @Query('space') space: string,
    @Query('scopeId') scopeId?: string,
  ) {
    return {
      canonical: path,
      space,
      resolved: await this.paths.toSpace(path, space as never, scopeId ?? null),
    };
  }

  @Patch('path-mappings/:id')
  @RequirePermissions(P.MEDIA_INTAKE_MANAGE)
  updateMapping(@Param('id') id: string, @Body() body: Record<string, never>) {
    return this.paths.update(id, body ?? {});
  }

  @Delete('path-mappings/:id')
  @RequirePermissions(P.MEDIA_INTAKE_MANAGE)
  removeMapping(@Param('id') id: string) {
    return this.paths.remove(id);
  }

  // --- migration wizard ------------------------------------------------------

  /**
   * What bulk conversion WOULD do. Read-only, and lists blocked rules too — a
   * preview that hides its refusals turns "why is this one blocked" into the
   * worse question "why is this one missing".
   */
  @Get('migration/preview')
  @RequirePermissions(P.MEDIA_INTAKE_MIGRATE)
  previewMigration(@Query('profileId') profileId?: string) {
    return this.migration.preview(profileId || undefined);
  }

  /** Convert the named rules — save path and mode together, in one transaction. */
  @Post('migration/apply')
  @RequirePermissions(P.MEDIA_INTAKE_MIGRATE)
  applyMigration(@Body() body: { ruleIds?: string[] }, @CurrentUser() u: AuthenticatedUser) {
    return this.migration.apply(body?.ruleIds ?? [], u?.id);
  }

  /** Put converted rules back, restoring the save path they had before. */
  @Post('migration/revert')
  @RequirePermissions(P.MEDIA_INTAKE_MIGRATE)
  revertMigration(@Body() body: { ruleIds?: string[] }, @CurrentUser() u: AuthenticatedUser) {
    return this.migration.revert(body?.ruleIds ?? [], u?.id);
  }
}
