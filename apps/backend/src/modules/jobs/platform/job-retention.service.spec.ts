import { JobRetentionService } from './job-retention.service';
import { JobRegistry } from './job-registry.service';
import type { JobExecutionContext } from './job.types';

describe('JobRetentionService', () => {
  function make() {
    const prisma = {
      platformJob: {
        deleteMany: jest.fn().mockResolvedValueOnce({ count: 3 }).mockResolvedValueOnce({ count: 1 }),
      },
    };
    const registry = new JobRegistry();
    const jobs = { runDetached: jest.fn().mockResolvedValue({ jobId: 'j1' }) };
    const svc = new JobRetentionService(prisma as never, registry, jobs as never);
    return { prisma, registry, jobs, svc };
  }

  it('registers the retention cleanup as an observable job type', () => {
    const { svc, registry } = make();
    svc.onModuleInit();
    expect(registry.has('jobs.retention_cleanup')).toBe(true);
    const def = registry.getDefinition('jobs.retention_cleanup');
    expect(def.moduleKey).toBe('jobs_center');
    expect(def.capabilities.cancellable).toBe(false);
  });

  it('the handler prunes finished (short) and failed (long-retention) jobs separately', async () => {
    const { svc, registry, prisma } = make();
    svc.onModuleInit();
    const metric = jest.fn();
    const out = await registry.get('jobs.retention_cleanup').handler.execute({}, { metric } as unknown as JobExecutionContext);
    expect(prisma.platformJob.deleteMany).toHaveBeenCalledTimes(2);
    // first call = finished statuses; second = failed
    expect((prisma.platformJob.deleteMany.mock.calls[0][0] as { where: { status: { in: string[] } } }).where.status.in).toContain('completed');
    expect((prisma.platformJob.deleteMany.mock.calls[1][0] as { where: { status: string } }).where.status).toBe('failed');
    expect((out as { result: unknown }).result).toEqual({ done: 3, failed: 1 });
    expect(metric).toHaveBeenCalledWith('prunedDone', 3);
  });

  it('the scheduler enqueues the cleanup as a single active (idempotent) job', async () => {
    const { svc, jobs } = make();
    await svc.scheduleCleanup();
    expect(jobs.runDetached).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'jobs.retention_cleanup', source: 'scheduled', idempotencyKey: 'jobs.retention_cleanup' }),
    );
  });
});
