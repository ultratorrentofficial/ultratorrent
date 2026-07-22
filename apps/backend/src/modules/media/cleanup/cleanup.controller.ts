import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { ProtectionService } from './protection.service';
import { PolicyService } from './policy.service';
import {
  BulkCreateProtectionDto, CreateProtectionDto, ExpiringQueryDto,
  ProtectionListQueryDto, RevokeProtectionDto,
} from './dto/protection.dto';
import {
  CreatePolicyDto, PolicyListQueryDto, PublishPolicyDto,
  SavePolicyDraftDto, UpdatePolicyDto, ValidatePolicyDto, CreateFromTemplateDto,
} from './dto/policy.dto';

/**
 * Library Cleanup Center. Static routes are declared BEFORE any `:id` route so
 * Nest cannot shadow them.
 */
@ApiTags('library-cleanup')
@ApiBearerAuth()
@Controller('media/cleanup')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CleanupController {
  constructor(
    private readonly protections: ProtectionService,
    private readonly policies: PolicyService,
  ) {}

  // ── Catalogue & stateless validation ───────────────────────────────────────
  /** The condition palette + engine limits that drive the policy builder. */
  @Get('catalog')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_VIEW)
  catalog() {
    return this.policies.catalog();
  }

  @Post('validate')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_VIEW)
  validate(@Body() dto: ValidatePolicyDto) {
    return this.policies.validate(dto.document);
  }

  /** Starter templates. Code, not seeded rows — nothing exists until instantiated. */
  @Get('templates')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_VIEW)
  templates() {
    return this.policies.templates();
  }

  // ── Policies ───────────────────────────────────────────────────────────────
  @Get('policies')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_VIEW)
  listPolicies(@Query() query: PolicyListQueryDto) {
    return this.policies.list(query);
  }

  @Post('policies')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_POLICY_CREATE)
  createPolicy(@Body() dto: CreatePolicyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.policies.create(dto, user);
  }

  /** Instantiate a template as a new DRAFT policy — still disabled, still unpublished. */
  @Post('policies/from-template')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_POLICY_CREATE)
  createFromTemplate(@Body() dto: CreateFromTemplateDto, @CurrentUser() user: AuthenticatedUser) {
    return this.policies.createFromTemplate(dto.templateKey, dto.name, user);
  }

  @Get('policies/:id')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_VIEW)
  getPolicy(@Param('id') id: string) {
    return this.policies.get(id);
  }

  @Patch('policies/:id')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_POLICY_EDIT)
  updatePolicy(@Param('id') id: string, @Body() dto: UpdatePolicyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.policies.updateMeta(id, dto, user);
  }

  @Put('policies/:id/draft')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_POLICY_EDIT)
  saveDraft(@Param('id') id: string, @Body() dto: SavePolicyDraftDto, @CurrentUser() user: AuthenticatedUser) {
    return this.policies.saveDraft(id, dto.document, dto.changeNotes, user);
  }

  /** Freezes the draft into an immutable version. Does NOT enable it. */
  @Post('policies/:id/publish')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_POLICY_PUBLISH)
  publishPolicy(@Param('id') id: string, @Body() dto: PublishPolicyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.policies.publish(id, dto.changeNotes, user);
  }

  /** Arming a destructive policy is a deliberate act, separate from publishing. */
  @Post('policies/:id/enable')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_POLICY_ENABLE)
  enablePolicy(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.policies.setEnabled(id, true, user);
  }

  @Post('policies/:id/disable')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_POLICY_ENABLE)
  disablePolicy(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.policies.setEnabled(id, false, user);
  }

  @Post('policies/:id/archive')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_POLICY_DELETE)
  archivePolicy(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.policies.archive(id, user);
  }

  @Delete('policies/:id')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_POLICY_DELETE)
  deletePolicy(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.policies.remove(id, user);
  }

  // ── Protections ────────────────────────────────────────────────────────────
  @Get('protections/expiring')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_PROTECTION_VIEW)
  expiring(@Query() query: ExpiringQueryDto) {
    return this.protections.expiring(query.withinDays);
  }

  @Get('protections')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_PROTECTION_VIEW)
  listProtections(@Query() query: ProtectionListQueryDto) {
    return this.protections.list(query);
  }

  @Post('protections')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_PROTECTION_CREATE)
  createProtection(@Body() dto: CreateProtectionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.protections.create(dto, user);
  }

  @Post('protections/bulk')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_PROTECTION_CREATE)
  bulkCreateProtections(@Body() dto: BulkCreateProtectionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.protections.bulkCreate(dto, user);
  }

  @Get('protections/:id')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_PROTECTION_VIEW)
  getProtection(@Param('id') id: string) {
    return this.protections.get(id);
  }

  /** Revocation, not deletion — the row survives so the audit history does too. */
  @Post('protections/:id/revoke')
  @RequirePermissions(PERMISSIONS.LIBRARY_CLEANUP_PROTECTION_REVOKE)
  revokeProtection(
    @Param('id') id: string,
    @Body() dto: RevokeProtectionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.protections.revoke(id, dto.reason, user);
  }
}
