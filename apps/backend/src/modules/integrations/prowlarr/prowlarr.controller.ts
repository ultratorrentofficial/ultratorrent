import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { AuthenticatedUser, CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { ProwlarrIntegrationService } from './prowlarr.service';
import { TestProwlarrDto, UpdateProwlarrSettingsDto } from './dto/prowlarr.dto';

const P = PERMISSIONS;

/**
 * Prowlarr companion integration. RBAC-gated; the API key is never returned
 * (redacted) or logged. This controller does NOT proxy arbitrary Prowlarr
 * endpoints — only saved settings + read-only health checks.
 */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations/prowlarr')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ProwlarrController {
  constructor(private readonly prowlarr: ProwlarrIntegrationService) {}

  @Get()
  @RequirePermissions(P.INTEGRATIONS_PROWLARR_VIEW)
  get(@CurrentUser() u: AuthenticatedUser) {
    return this.prowlarr.get({ userId: u?.id });
  }

  @Patch()
  @RequirePermissions(P.INTEGRATIONS_PROWLARR_MANAGE)
  update(@Body() dto: UpdateProwlarrSettingsDto, @CurrentUser() u: AuthenticatedUser) {
    return this.prowlarr.update(dto, { userId: u?.id });
  }

  @Post('test')
  @RequirePermissions(P.INTEGRATIONS_PROWLARR_TEST)
  test(@Body() dto: TestProwlarrDto, @CurrentUser() u: AuthenticatedUser) {
    return this.prowlarr.testConnection(dto ?? {}, { userId: u?.id });
  }

  @Get('status')
  @RequirePermissions(P.INTEGRATIONS_PROWLARR_VIEW)
  status() {
    return this.prowlarr.status();
  }

  @Post('open')
  @RequirePermissions(P.INTEGRATIONS_PROWLARR_OPEN)
  open(@CurrentUser() u: AuthenticatedUser) {
    return this.prowlarr.open({ userId: u?.id });
  }
}
