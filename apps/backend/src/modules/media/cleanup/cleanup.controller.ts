import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { CurrentUser, AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { ProtectionService } from './protection.service';
import {
  BulkCreateProtectionDto, CreateProtectionDto, ExpiringQueryDto,
  ProtectionListQueryDto, RevokeProtectionDto,
} from './dto/protection.dto';

/**
 * Library Cleanup Center. Static routes are declared BEFORE any `:id` route so
 * Nest cannot shadow them.
 */
@ApiTags('library-cleanup')
@ApiBearerAuth()
@Controller('media/cleanup')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CleanupController {
  constructor(private readonly protections: ProtectionService) {}

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
