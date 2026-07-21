import { PlatformJobsQueryService } from './platform-jobs-query.service';
import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';

function user(p: Partial<AuthenticatedUser>): AuthenticatedUser {
  return { id: 'u1', username: 'u', roles: [], permissions: [], ...p };
}

describe('PlatformJobsQueryService — RBAC visibility', () => {
  const svc = new PlatformJobsQueryService({} as never);

  it('super-admin sees everything (no visibility filter)', () => {
    expect(svc.visibilityWhere(user({ roles: [SystemRole.SUPER_ADMIN] }))).toEqual({});
  });

  it('jobs.view_all sees everything', () => {
    expect(svc.visibilityWhere(user({ permissions: [PERMISSIONS.JOBS_VIEW_ALL] }))).toEqual({});
  });

  it('a normal viewer is scoped to public / own / no-perm / held-perm jobs', () => {
    const where = svc.visibilityWhere(user({ permissions: [PERMISSIONS.MEDIA_MANAGER_VIEW] }));
    expect(where.OR).toEqual([
      { visibilityScope: 'public' },
      { createdById: 'u1' },
      { requiredPermission: null },
      { requiredPermission: { in: [PERMISSIONS.MEDIA_MANAGER_VIEW] } },
    ]);
  });

  it('a viewer with no permissions still sees only public / own / ungated jobs', () => {
    const where = svc.visibilityWhere(user({}));
    expect(where.OR).toEqual([
      { visibilityScope: 'public' },
      { createdById: 'u1' },
      { requiredPermission: null },
      { requiredPermission: { in: [] } },
    ]);
  });
});
