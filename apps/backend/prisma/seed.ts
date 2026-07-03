import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  SystemRole,
} from '@ultratorrent/shared';

const prisma = new PrismaClient();

async function main() {
  // 1. Permissions
  for (const key of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, description: key },
    });
  }
  const permissionRows = await prisma.permission.findMany();
  const permByKey = new Map(permissionRows.map((p) => [p.key, p.id]));

  // 2. Roles + role->permission mappings
  for (const role of Object.values(SystemRole)) {
    const created = await prisma.role.upsert({
      where: { name: role },
      update: {},
      create: { name: role, description: `${role} (system role)`, isSystem: true },
    });

    const perms = ROLE_PERMISSIONS[role];
    await prisma.rolePermission.deleteMany({ where: { roleId: created.id } });
    await prisma.rolePermission.createMany({
      data: perms
        .map((key) => permByKey.get(key))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: created.id, permissionId })),
      skipDuplicates: true,
    });
  }

  // 3. Bootstrap super admin
  const adminUsername = process.env.ADMIN_USERNAME ?? 'admin';
  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@ultratorrent.local';
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'changeme123!';

  const superRole = await prisma.role.findUniqueOrThrow({
    where: { name: SystemRole.SUPER_ADMIN },
  });

  const passwordHash = await argon2.hash(adminPassword, { type: argon2.argon2id });
  const admin = await prisma.user.upsert({
    where: { username: adminUsername },
    update: {},
    create: {
      username: adminUsername,
      email: adminEmail,
      displayName: 'Administrator',
      passwordHash,
      isActive: true,
      isSystem: true,
    },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: superRole.id } },
    update: {},
    create: { userId: admin.id, roleId: superRole.id },
  });

  // 4. Default settings
  const defaults: Record<string, unknown> = {
    'general.productName': 'UltraTorrent',
    'general.theme': 'dark',
    'security.refreshTokenTtlDays': 30,
    'security.accessTokenTtlMinutes': 15,
    'engine.pollIntervalMs': 2000,
    // File-browser Default Root Path. Empty = use FILE_MANAGER_ROOTS (the env
    // hard boundary) as-is; an admin can narrow it to a subtree via the UI.
    'fileManager.defaultRootPath': '',
  };
  for (const [key, value] of Object.entries(defaults)) {
    await prisma.setting.upsert({
      where: { key },
      update: {},
      create: { key, value: value as object },
    });
  }

  console.log(`Seed complete. Super admin: ${adminUsername} / ${adminPassword}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
