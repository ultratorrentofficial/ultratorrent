import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ModuleRegistryService } from './module-registry.service';

/**
 * Ensures every permission declared by a loaded module manifest exists in the
 * permission catalog (DB), so RBAC can assign module-specific permissions —
 * including permissions contributed by externally-injected modules.
 */
@Injectable()
export class ModulePermissionSyncService implements OnModuleInit {
  private readonly logger = new Logger(ModulePermissionSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    const keys = new Set<string>();
    for (const m of this.registry.allManifests()) {
      for (const p of m.permissions) keys.add(p);
    }
    let created = 0;
    for (const key of keys) {
      const res = await this.prisma.permission.upsert({
        where: { key },
        update: {},
        create: { key, description: `${key} (module-declared)` },
      });
      if (res) created++;
    }
    this.logger.log(`Synced ${keys.size} module permission key(s)`);
  }
}
