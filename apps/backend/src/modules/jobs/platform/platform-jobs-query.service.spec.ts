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

/*
 * `completedAt` is set only when a job SUCCEEDS. A failure records failedAt and
 * a cancellation cancelledAt, so a screen built on completedAt alone shows an
 * empty "finished" cell for exactly the jobs an administrator is investigating.
 * `finishedAt` answers "when did it stop", whatever stopped it, once — here —
 * rather than in every client that has to display it.
 */
describe('PlatformJobsQueryService — when a job finished', () => {
  const svc = new PlatformJobsQueryService({} as never);

  const row = (over: Record<string, unknown> = {}) =>
    ({
      id: 'j1', type: 't', name: null, moduleKey: 'm', workspaceKey: null,
      status: 'completed', phase: null, progressPercent: 100, sourceType: 'manual',
      resourceType: null, resourceId: null, priority: 0, attempt: 1, maxAttempts: 1,
      createdById: null, workerId: null, queuedAt: new Date('2026-08-26T01:00:00Z'),
      startedAt: new Date('2026-08-26T01:01:00Z'),
      completedAt: null, failedAt: null, cancelledAt: null,
      cancellable: false, pausable: false, resumable: false, retryable: false,
      ...over,
    }) as never;

  it('uses completedAt when the job succeeded', () => {
    const at = new Date('2026-08-26T01:05:00Z');
    expect(svc.toListItem(row({ completedAt: at })).finishedAt).toEqual(at);
  });

  it('uses failedAt when the job failed — the case a screen would otherwise leave blank', () => {
    const at = new Date('2026-08-26T01:06:00Z');
    expect(svc.toListItem(row({ status: 'failed', failedAt: at })).finishedAt).toEqual(at);
  });

  it('uses cancelledAt when the job was cancelled', () => {
    const at = new Date('2026-08-26T01:07:00Z');
    expect(svc.toListItem(row({ status: 'cancelled', cancelledAt: at })).finishedAt).toEqual(at);
  });

  it('is null while the job is still running', () => {
    expect(svc.toListItem(row({ status: 'running' })).finishedAt).toBeNull();
  });

  it('prefers completedAt when more than one end timestamp is set', () => {
    // A retried job can carry an older failedAt alongside a newer completedAt;
    // the successful ending is the one that describes its current state.
    const failed = new Date('2026-08-26T01:02:00Z');
    const completed = new Date('2026-08-26T01:09:00Z');
    expect(svc.toListItem(row({ completedAt: completed, failedAt: failed })).finishedAt).toEqual(completed);
  });

  it('still reports completedAt itself, so nothing that used it breaks', () => {
    const at = new Date('2026-08-26T01:05:00Z');
    expect(svc.toListItem(row({ completedAt: at })).completedAt).toEqual(at);
  });
});
