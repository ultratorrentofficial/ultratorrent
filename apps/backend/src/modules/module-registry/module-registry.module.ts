import { Global, Module } from '@nestjs/common';
import { ModuleRegistryService } from './module-registry.service';
import { ModuleRegistryController } from './module-registry.controller';
import { ModuleHealthService } from './module-health.service';
import { ModulePermissionSyncService } from './module-permission-sync.service';
import {
  CommunityLicenseProvider,
  LICENSE_PROVIDER,
} from './community-license.provider';

/**
 * Module registry. Tracks every module's manifest and computed enable/disable
 * state; the availability seam is bound to the single-tier
 * {@link CommunityLicenseProvider}.
 */
@Global()
@Module({
  providers: [
    { provide: LICENSE_PROVIDER, useClass: CommunityLicenseProvider },
    ModuleRegistryService,
    ModuleHealthService,
    ModulePermissionSyncService,
  ],
  controllers: [ModuleRegistryController],
  exports: [ModuleRegistryService, ModuleHealthService, LICENSE_PROVIDER],
})
export class ModuleRegistryModule {}
