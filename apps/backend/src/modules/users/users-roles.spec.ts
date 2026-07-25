import { ForbiddenException } from '@nestjs/common';
import { SystemRole } from '@ultratorrent/shared';
import { UsersService } from './users.module';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

const admin: AuthenticatedUser = {
  id: 'admin-1',
  username: 'admin',
  roles: [SystemRole.ADMINISTRATOR],
  permissions: [],
};
const superAdmin: AuthenticatedUser = {
  id: 'super-1',
  username: 'root',
  roles: [SystemRole.SUPER_ADMIN],
  permissions: [],
};

function makeService(overrides: Record<string, unknown> = {}) {
  const prisma = {
    role: { findMany: jest.fn().mockResolvedValue([{ id: 'r1' }]) },
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 'target', isSystem: false }),
      create: jest.fn().mockResolvedValue({ id: 'new', roles: [] }),
      update: jest.fn().mockResolvedValue({ id: 'target', roles: [] }),
    },
    userRole: {
      deleteMany: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
  // ModuleRef is used only to reach RecipientProvisioningService at call time; a stub
  // that throws exercises the intended path — recipient sync is best-effort and must
  // never fail a user write.
  const moduleRef = { get: () => { throw new Error('not available in unit test'); } };
  return { svc: new UsersService(prisma as any, moduleRef as any), prisma };
}

describe('UsersService role-assignment guard (privilege escalation)', () => {
  it('rejects a non-super admin granting SUPER_ADMIN on create', async () => {
    const { svc, prisma } = makeService();
    await expect(
      svc.create({ username: 'x', password: 'x', roleNames: [SystemRole.SUPER_ADMIN] } as any, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rejects a non-super admin granting SUPER_ADMIN on update', async () => {
    const { svc } = makeService();
    await expect(
      svc.update('target', { roleNames: [SystemRole.SUPER_ADMIN] } as any, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('forbids a caller from editing their own roles', async () => {
    const { svc, prisma } = makeService({
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: admin.id, isSystem: false }),
        update: jest.fn(),
      },
    });
    await expect(
      svc.update(admin.id, { roleNames: [SystemRole.USER] } as any, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('allows a SUPER_ADMIN to grant SUPER_ADMIN', async () => {
    const { svc, prisma } = makeService();
    await expect(
      svc.create({ username: 'x', password: 'x', roleNames: [SystemRole.SUPER_ADMIN] } as any, superAdmin),
    ).resolves.toBeTruthy();
    expect(prisma.user.create).toHaveBeenCalled();
  });
});
