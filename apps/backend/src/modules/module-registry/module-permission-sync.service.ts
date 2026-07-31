import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ROLE_PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ModuleRegistryService } from './module-registry.service';

/**
 * Keeps the RBAC tables in step with what the loaded module manifests declare.
 *
 * Two jobs, and the difference between them matters:
 *
 * 1. Every permission a manifest declares exists in the catalog, so RBAC can
 *    assign it — including permissions contributed by externally-injected
 *    modules that the shared `PERMISSIONS` constant knows nothing about.
 *
 * 2. Permissions that are BRAND NEW to this database are granted to the system
 *    roles that `ROLE_PERMISSIONS` says should hold them.
 *
 * Job 2 exists because the deployed container runs `prisma migrate deploy` and
 * never the seed, and the seed is otherwise the only thing that writes
 * `role_permissions`. Without it, shipping a feature that adds a permission
 * gives every non-SUPER_ADMIN a 403 on the new routes forever — SUPER_ADMIN
 * bypasses the guard entirely, so the gap is invisible to whoever deployed it.
 *
 * WHY ONLY NEW PERMISSIONS. Re-asserting the full `ROLE_PERMISSIONS` map on
 * every boot would silently revert an operator who deliberately revoked
 * something in the RBAC UI. A key that did not exist in the database a moment
 * ago cannot have been revoked by anyone, so granting exactly those is the only
 * change that is unambiguously an upgrade rather than an opinion. The tradeoff
 * is the mirror case: removing a permission from `ROLE_PERMISSIONS` in code
 * does NOT revoke it here. That is deliberate — this service never takes a
 * permission away, and revocation stays a human decision. The seed still does
 * the authoritative full reset for a fresh install.
 */
@Injectable()
export class ModulePermissionSyncService implements OnModuleInit {
  private readonly logger = new Logger(ModulePermissionSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    const declared = new Set<string>();
    for (const m of this.registry.allManifests()) {
      for (const p of m.permissions) declared.add(p);
    }

    const existing = await this.prisma.permission.findMany({
      where: { key: { in: [...declared] } },
      select: { key: true },
    });
    const known = new Set(existing.map((p) => p.key));
    const fresh = [...declared].filter((k) => !known.has(k));

    if (fresh.length === 0) {
      this.logger.log(`Permission catalog in sync (${declared.size} declared)`);
      return;
    }

    // createMany + skipDuplicates rather than upsert: two instances booting at
    // once would otherwise race, and the loser of that race must not throw and
    // take the process down over a row the winner already wrote.
    await this.prisma.permission.createMany({
      data: fresh.map((key) => ({ key, description: `${key} (module-declared)` })),
      skipDuplicates: true,
    });
    this.logger.log(`Added ${fresh.length} permission(s): ${fresh.join(', ')}`);

    await this.grantFreshPermissions(fresh);
  }

  /**
   * Grant the just-created permissions to the system roles that should hold
   * them. Roles absent from the database are skipped rather than created — on a
   * database the seed has never touched there is nothing to grant to yet, and
   * inventing roles here would fork the definition of what a role is.
   */
  private async grantFreshPermissions(fresh: string[]): Promise<void> {
    const rows = await this.prisma.permission.findMany({
      where: { key: { in: fresh } },
      select: { id: true, key: true },
    });
    const idByKey = new Map(rows.map((p) => [p.key, p.id]));

    const roles = await this.prisma.role.findMany({
      where: { name: { in: Object.values(SystemRole) } },
      select: { id: true, name: true },
    });

    const grants: Array<{ roleId: string; permissionId: string }> = [];
    for (const role of roles) {
      // An externally-injected module can declare a permission the shared map
      // has never heard of; it stays catalog-only until RBAC assigns it.
      const wanted = ROLE_PERMISSIONS[role.name as SystemRole] ?? [];
      const wantedSet = new Set<string>(wanted);
      for (const key of fresh) {
        const permissionId = idByKey.get(key);
        if (permissionId && wantedSet.has(key)) {
          grants.push({ roleId: role.id, permissionId });
        }
      }
    }

    if (grants.length === 0) return;
    await this.prisma.rolePermission.createMany({ data: grants, skipDuplicates: true });
    this.logger.log(`Granted ${grants.length} new role permission(s)`);
  }
}
