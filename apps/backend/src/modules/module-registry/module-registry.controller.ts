import {
  Controller,
  Get,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { LicenseProvider, PERMISSIONS } from '@ultratorrent/shared';
import { ModuleRegistryService } from './module-registry.service';
import { ModuleHealthService } from './module-health.service';
import { LICENSE_PROVIDER } from './community-license.provider';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';

@ApiTags('modules')
@ApiBearerAuth()
@Controller('modules')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ModuleRegistryController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly health: ModuleHealthService,
    @Inject(LICENSE_PROVIDER) private readonly license: LicenseProvider,
  ) {}

  /** Enabled modules — needed by every client to build its nav (auth only). */
  @Get('enabled')
  enabled() {
    return this.registry.getEnabled();
  }

  /** Current license/edition status (auth only). */
  @Get('license')
  licenseStatus() {
    return this.license.getStatus();
  }

  @Get()
  @RequirePermissions(PERMISSIONS.MODULES_VIEW)
  list() {
    return this.registry.getStatuses();
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.MODULES_VIEW)
  get(@Param('id') id: string) {
    return this.registry.getManifest(id) && this.registry.getStatus(id);
  }

  @Get(':id/manifest')
  @RequirePermissions(PERMISSIONS.MODULES_VIEW)
  manifest(@Param('id') id: string) {
    return this.registry.getManifest(id);
  }

  @Get(':id/health')
  @RequirePermissions(PERMISSIONS.MODULES_VIEW)
  moduleHealth(@Param('id') id: string) {
    this.registry.getManifest(id); // 404 if unknown
    return this.health.get(id);
  }

  @Post(':id/enable')
  @RequirePermissions(PERMISSIONS.MODULES_MANAGE)
  enable(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.registry.enable(id, user.id);
  }

  @Post(':id/disable')
  @RequirePermissions(PERMISSIONS.MODULES_MANAGE)
  disable(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.registry.disable(id, user.id);
  }
}
