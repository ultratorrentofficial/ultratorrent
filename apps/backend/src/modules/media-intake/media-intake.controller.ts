import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
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

}
