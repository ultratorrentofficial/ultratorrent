import { Global, Module } from '@nestjs/common';
import { ModuleRegistryService } from './module-registry.service';
import { ModuleRegistryController } from './module-registry.controller';
import { ModuleHealthService } from './module-health.service';
import { ModulePermissionSyncService } from './module-permission-sync.service';
import { ModuleGuard } from './module-license.guard';
import {
  CommunityLicenseProvider,
  LICENSE_PROVIDER,
} from './community-license.provider';

/**
 * Public Core module registry. The active LicenseProvider is bound to the
 * default CommunityLicenseProvider; the private Enterprise overlay rebinds
 * {@link LICENSE_PROVIDER} (and calls registry.registerExternal) to add tiers.
 */
@Global()
@Module({
  providers: [
    { provide: LICENSE_PROVIDER, useClass: CommunityLicenseProvider },
    ModuleRegistryService,
    ModuleHealthService,
    ModulePermissionSyncService,
    ModuleGuard,
  ],
  controllers: [ModuleRegistryController],
  exports: [ModuleRegistryService, ModuleHealthService, ModuleGuard, LICENSE_PROVIDER],
})
export class ModuleRegistryModule {}
