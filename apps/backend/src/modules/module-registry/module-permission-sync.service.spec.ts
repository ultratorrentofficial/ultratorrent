import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { ModulePermissionSyncService } from './module-permission-sync.service';

// --- mocks ---------------------------------------------------------------

/**
 * An in-memory stand-in for the two RBAC tables. It records writes rather than
 * just accepting them, because every assertion here is about what was written
 * and — more importantly — what was left alone.
 */
function makePrisma(opts: {
  permissions?: string[];
  roles?: string[];
  grants?: Array<{ roleId: string; permissionId: string }>;
} = {}) {
  const permissions = new Map<string, { id: string; key: string }>(
    (opts.permissions ?? []).map((k) => [k, { id: `perm-${k}`, key: k }]),
  );
  const roles = (opts.roles ?? Object.values(SystemRole)).map((name) => ({
    id: `role-${name}`,
    name,
  }));
  const grants = [...(opts.grants ?? [])];

  return {
    permissions,
    roles,
    grants,
    permission: {
      findMany: async ({ where }: any) => {
        const wanted: string[] = where.key.in;
        return wanted.filter((k) => permissions.has(k)).map((k) => permissions.get(k));
      },
      createMany: async ({ data }: any) => {
        for (const row of data) {
          if (!permissions.has(row.key)) {
            permissions.set(row.key, { id: `perm-${row.key}`, key: row.key });
          }
        }
      },
    },
    role: {
      findMany: async ({ where }: any) =>
        roles.filter((r) => where.name.in.includes(r.name)),
    },
    rolePermission: {
      createMany: async ({ data }: any) => grants.push(...data),
    },
  } as any;
}

const registryWith = (perms: string[]) =>
  ({ allManifests: () => [{ id: 'm', permissions: perms }] }) as any;

const grantsFor = (prisma: any, role: SystemRole) =>
  prisma.grants
    .filter((g: any) => g.roleId === `role-${role}`)
    .map((g: any) => g.permissionId.replace(/^perm-/, ''));

// --- tests ---------------------------------------------------------------

describe('ModulePermissionSyncService', () => {
  const NEW = PERMISSIONS.MEDIA_INTAKE_VIEW;

  it('creates permissions the catalog is missing', async () => {
    const prisma = makePrisma({ permissions: [] });
    await new ModulePermissionSyncService(prisma, registryWith([NEW])).onModuleInit();

    expect(prisma.permissions.has(NEW)).toBe(true);
  });

  it('GRANTS a brand-new permission to the roles that should hold it', async () => {
    /*
     * The failure this exists to prevent: the deployed container runs
     * `prisma migrate deploy` and never the seed, so before this, shipping a
     * feature that added a permission gave every ADMINISTRATOR a permanent 403
     * on its routes. SUPER_ADMIN bypasses the guard, so nobody deploying it
     * would ever see the problem.
     */
    const prisma = makePrisma({ permissions: [] });
    await new ModulePermissionSyncService(prisma, registryWith([NEW])).onModuleInit();

    expect(grantsFor(prisma, SystemRole.ADMINISTRATOR)).toContain(NEW);
  });

  it('does NOT re-grant a permission that already existed', async () => {
    /*
     * The whole point of keying off "new to the database". An operator who
     * revoked a permission in the RBAC UI must not have it silently restored on
     * the next restart — and a revocation is indistinguishable from a
     * never-granted permission unless we look at whether the KEY is new.
     */
    const prisma = makePrisma({ permissions: [NEW], grants: [] });
    await new ModulePermissionSyncService(prisma, registryWith([NEW])).onModuleInit();

    expect(prisma.grants).toHaveLength(0);
  });

  it('never revokes, even when the role map no longer wants the permission', async () => {
    // Mirror of the case above: this service adds, it does not take away.
    const stale = { roleId: `role-${SystemRole.USER}`, permissionId: `perm-${NEW}` };
    const prisma = makePrisma({ permissions: [NEW], grants: [stale] });
    await new ModulePermissionSyncService(prisma, registryWith([NEW])).onModuleInit();

    expect(prisma.grants).toContain(stale);
  });

  it('respects the role map rather than granting to everyone', async () => {
    const prisma = makePrisma({ permissions: [] });
    await new ModulePermissionSyncService(prisma, registryWith([NEW])).onModuleInit();

    // READ_ONLY has no business operating an import pipeline.
    expect(grantsFor(prisma, SystemRole.READ_ONLY)).not.toContain(NEW);
  });

  it('catalogs a module-declared permission the shared map has never heard of', async () => {
    /*
     * Externally-injected modules can declare their own keys. Those must reach
     * the catalog so RBAC can assign them, but must NOT be auto-granted — there
     * is no role map entry saying who should hold them.
     */
    const foreign = 'thirdparty.widget.manage';
    const prisma = makePrisma({ permissions: [] });
    await new ModulePermissionSyncService(prisma, registryWith([foreign])).onModuleInit();

    expect(prisma.permissions.has(foreign)).toBe(true);
    expect(prisma.grants).toHaveLength(0);
  });

  it('skips roles the database does not have yet', async () => {
    // A database the seed has never touched has no roles to grant to; that must
    // not throw and take the whole boot down.
    const prisma = makePrisma({ permissions: [], roles: [] });
    await expect(
      new ModulePermissionSyncService(prisma, registryWith([NEW])).onModuleInit(),
    ).resolves.not.toThrow();
    expect(prisma.grants).toHaveLength(0);
  });
});
