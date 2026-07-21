import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { JobsService } from './jobs.service';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

function user(partial: Partial<AuthenticatedUser>): AuthenticatedUser {
  return { id: 'u1', username: 'u', roles: [], permissions: [], ...partial };
}

const D = (iso: string) => new Date(iso);

function makePrisma() {
  return {
    mediaProcessingJob: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'm1', type: 'library_scan', status: 'running', progress: 40, libraryId: 'lib1', itemId: null, error: null, createdAt: D('2026-07-21T10:00:00Z'), updatedAt: D('2026-07-21T10:01:00Z') },
        { id: 'm2', type: 'metadata_fetch', status: 'completed', progress: 100, libraryId: null, itemId: 'item9', error: null, createdAt: D('2026-07-21T09:00:00Z'), updatedAt: D('2026-07-21T09:05:00Z') },
      ]),
    },
    subtitleJob: {
      findMany: jest.fn().mockResolvedValue([
        { id: 's1', type: 'download', status: 'failed', progress: 0, libraryId: null, itemId: 'item3', provider: 'osdb', language: 'en', error: 'nope', createdAt: D('2026-07-21T11:00:00Z'), updatedAt: D('2026-07-21T11:00:30Z') },
      ]),
    },
    mediaRenameJob: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'r1', mode: 'execute', status: 'preview', sourcePath: '/downloads/Movies/Foo.mkv', completedAt: null, createdAt: D('2026-07-21T08:00:00Z') },
      ]),
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
  it('visibleSubsystems: super-admin sees every subsystem', () => {
    const svc = new JobsService(makePrisma() as never);
    expect(svc.visibleSubsystems(user({ roles: [SystemRole.SUPER_ADMIN] })).sort()).toEqual(
      ['analytics_import', 'media', 'notification', 'rename', 'subtitle'],
    );
  });

  it('visibleSubsystems: a media-only user sees media + rename (both gated by media_manager.view)', () => {
    const svc = new JobsService(makePrisma() as never);
    expect(svc.visibleSubsystems(user({ permissions: [PERMISSIONS.MEDIA_MANAGER_VIEW] })).sort()).toEqual(
      ['media', 'rename'],
    );
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
    expect(prisma.mediaProcessingJob.findMany).not.toHaveBeenCalled();
  });

  it('aggregates only the caller’s subsystems and sorts newest-first', async () => {
    const svc = new JobsService(makePrisma() as never);
    const { jobs } = await svc.list(user({ permissions: [PERMISSIONS.MEDIA_MANAGER_VIEW] }));
    // media (m1, m2) + rename (r1) only — no subtitle/analytics/notification.
    expect(jobs.map((j) => j.id)).toEqual(['m1', 'm2', 'r1']);
    expect(jobs.every((j) => j.subsystem === 'media' || j.subsystem === 'rename')).toBe(true);
  });

  it('normalizes cross-subsystem status (preview→running, pending/leased→running/queued)', async () => {
    const svc = new JobsService(makePrisma() as never);
    const { jobs } = await svc.list(user({ roles: [SystemRole.SUPER_ADMIN] }));
    const byId = Object.fromEntries(jobs.map((j) => [j.id, j.status]));
    expect(byId.r1).toBe('running'); // rename 'preview'
    expect(byId.a1).toBe('queued'); // analytics 'pending', not leased
    expect(byId.n1).toBe('running'); // notification leased
    expect(byId.n2).toBe('queued'); // notification not leased
    expect(byId.s1).toBe('failed');
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
