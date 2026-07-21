import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { JobsService } from './jobs.service';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

function user(partial: Partial<AuthenticatedUser>): AuthenticatedUser {
  return { id: 'u1', username: 'u', roles: [], permissions: [], ...partial };
}

const D = (iso: string) => new Date(iso);

function makePrisma() {
  return {
    // Media & subtitle now come from platform_jobs (Phase 7), filtered by moduleKey.
    platformJob: {
      findMany: jest.fn((args: { where?: { moduleKey?: string } }) => {
        if (args?.where?.moduleKey === 'media_manager') {
          return Promise.resolve([
            { id: 'm1', type: 'media.library_scan', status: 'running', progressPercent: 40, name: 'library_scan', libraryId: 'lib1', mediaItemId: null, errorMessage: null, createdAt: D('2026-07-21T10:00:00Z'), updatedAt: D('2026-07-21T10:01:00Z') },
            { id: 'm2', type: 'media.metadata_fetch', status: 'completed', progressPercent: 100, name: 'metadata_fetch', libraryId: null, mediaItemId: 'item9', errorMessage: null, createdAt: D('2026-07-21T09:00:00Z'), updatedAt: D('2026-07-21T09:05:00Z') },
          ]);
        }
        if (args?.where?.moduleKey === 'subtitle_intelligence') {
          return Promise.resolve([
            { id: 's1', type: 'subtitle.download', status: 'failed', progressPercent: 0, name: 'download', libraryId: null, mediaItemId: 'item3', errorMessage: 'nope', createdAt: D('2026-07-21T11:00:00Z'), updatedAt: D('2026-07-21T11:00:30Z') },
          ]);
        }
        return Promise.resolve([]);
      }),
    },
    mediaAnalyticsImportJob: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'a1', mode: 'one_time', status: 'pending', progress: 0, sourceId: 'src1', createdAt: D('2026-07-21T07:00:00Z'), updatedAt: D('2026-07-21T07:00:00Z') },
      ]),
    },
    notificationQueue: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'n1', deliveryId: 'del1', leasedAt: D('2026-07-21T12:00:00Z'), createdAt: D('2026-07-21T12:00:00Z') },
        { id: 'n2', deliveryId: 'del2', leasedAt: null, createdAt: D('2026-07-21T06:00:00Z') },
      ]),
    },
  };
}

describe('JobsService', () => {
  it('visibleSubsystems: super-admin sees every subsystem (rename dropped)', () => {
    const svc = new JobsService(makePrisma() as never);
    expect(svc.visibleSubsystems(user({ roles: [SystemRole.SUPER_ADMIN] })).sort()).toEqual(
      ['analytics_import', 'media', 'notification', 'subtitle'],
    );
  });

  it('visibleSubsystems: a media-only user sees just media', () => {
    const svc = new JobsService(makePrisma() as never);
    expect(svc.visibleSubsystems(user({ permissions: [PERMISSIONS.MEDIA_MANAGER_VIEW] })).sort()).toEqual(['media']);
  });

  it('visibleSubsystems: no permissions → nothing', () => {
    const svc = new JobsService(makePrisma() as never);
    expect(svc.visibleSubsystems(user({}))).toEqual([]);
  });

  it('returns an empty list (and queries nothing) for a user who can view no subsystem', async () => {
    const prisma = makePrisma();
    const svc = new JobsService(prisma as never);
    const { jobs } = await svc.list(user({}));
    expect(jobs).toEqual([]);
    expect(prisma.platformJob.findMany).not.toHaveBeenCalled();
  });

  it('aggregates only the caller’s subsystems and sorts newest-first', async () => {
    const svc = new JobsService(makePrisma() as never);
    const { jobs } = await svc.list(user({ permissions: [PERMISSIONS.MEDIA_MANAGER_VIEW] }));
    expect(jobs.map((j) => j.id)).toEqual(['m1', 'm2']); // media platform jobs only
    expect(jobs.every((j) => j.subsystem === 'media')).toBe(true);
  });

  it('normalizes statuses across platform and legacy subsystems', async () => {
    const svc = new JobsService(makePrisma() as never);
    const { jobs } = await svc.list(user({ roles: [SystemRole.SUPER_ADMIN] }));
    const byId = Object.fromEntries(jobs.map((j) => [j.id, j.status]));
    expect(byId.m1).toBe('running');
    expect(byId.m2).toBe('completed');
    expect(byId.s1).toBe('failed');
    expect(byId.a1).toBe('queued'); // analytics 'pending', not leased
    expect(byId.n1).toBe('running'); // notification leased
    expect(byId.n2).toBe('queued'); // notification not leased
  });

  it('filters to active (queued/running) jobs', async () => {
    const svc = new JobsService(makePrisma() as never);
    const { jobs } = await svc.list(user({ roles: [SystemRole.SUPER_ADMIN] }), { active: true });
    expect(jobs.some((j) => j.status === 'completed' || j.status === 'failed')).toBe(false);
    expect(jobs.length).toBeGreaterThan(0);
  });

  it('filters by an explicit subsystem and status', async () => {
    const svc = new JobsService(makePrisma() as never);
    const { jobs } = await svc.list(user({ roles: [SystemRole.SUPER_ADMIN] }), { subsystem: 'media', status: 'completed' });
    expect(jobs.map((j) => j.id)).toEqual(['m2']);
  });

  it('caps results at the requested limit', async () => {
    const svc = new JobsService(makePrisma() as never);
    const { jobs } = await svc.list(user({ roles: [SystemRole.SUPER_ADMIN] }), { limit: 2 });
    expect(jobs).toHaveLength(2);
  });
});
