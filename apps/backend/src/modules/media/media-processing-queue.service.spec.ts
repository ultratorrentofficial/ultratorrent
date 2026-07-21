import { WS_EVENTS } from '@ultratorrent/shared';
import { MediaProcessingQueueService, JobCancelledError } from './media-processing-queue.service';
import type { JobExecutionContext } from '../jobs/platform/job.types';

function build(updateManyResult = { count: 0 }) {
  const prisma = {
    mediaProcessingJob: { updateMany: jest.fn().mockResolvedValue(updateManyResult) },
  };
  const realtime = { broadcast: jest.fn(), emitToPermission: jest.fn() };
  const registry = { has: jest.fn().mockReturnValue(false), register: jest.fn() };
  // A platformJobs stub whose run/runDetached invoke the adapter's inline executor with a fake ctx.
  const platformJobs = {
    run: jest.fn(async (input: { input: unknown }, executor: (i: unknown, ctx: JobExecutionContext) => Promise<{ result?: unknown }>) => {
      const out = await executor(input.input, fakeCtx());
      return { jobId: 'job-1', result: out.result };
    }),
    runDetached: jest.fn(async (input: { input: unknown }, executor: (i: unknown, ctx: JobExecutionContext) => Promise<unknown>) => {
      await executor(input.input, fakeCtx());
      return { jobId: 'job-1' };
    }),
    requestCancel: jest.fn().mockResolvedValue(true),
  };
  const svc = new MediaProcessingQueueService(prisma as never, realtime as never, platformJobs as never, registry as never);
  return { svc, prisma, realtime, registry, platformJobs };
}

let cancelFlag = false;
function fakeCtx(): JobExecutionContext {
  return {
    jobId: 'job-1',
    rootJobId: 'job-1',
    parentJobId: null,
    attempt: 1,
    correlationId: null,
    runAsUserId: null,
    signal: { isCancelled: () => cancelFlag, throwIfCancelled: () => { if (cancelFlag) throw new Error('x'); } },
    progress: async () => undefined,
    setPhase: async () => undefined,
    event: async () => undefined,
    warn: async () => undefined,
    heartbeat: async () => undefined,
    saveCheckpoint: async () => undefined,
    loadCheckpoint: async () => undefined,
    metric: () => undefined,
    isPauseRequested: () => false,
  };
}

describe('MediaProcessingQueueService.onModuleInit', () => {
  beforeEach(() => { cancelFlag = false; });

  it('registers a platform definition per media job type and reconciles legacy rows', async () => {
    const { svc, prisma, registry } = build({ count: 30 });
    await svc.onModuleInit();
    expect(registry.register).toHaveBeenCalledTimes(10); // one per MediaJobType
    expect(registry.register.mock.calls[0][0].type).toMatch(/^media\./);
    expect(prisma.mediaProcessingJob.updateMany).toHaveBeenCalledWith({
      where: { status: { in: ['queued', 'running'] } },
      data: expect.objectContaining({ status: 'failed', error: 'Interrupted by a service restart', finishedAt: expect.any(Date) }),
    });
  });

  it('never blocks boot when the cleanup query fails', async () => {
    const { svc, prisma } = build();
    prisma.mediaProcessingJob.updateMany.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });

  it('skips re-registering an already-registered type', async () => {
    const { svc, registry } = build();
    registry.has.mockReturnValue(true);
    await svc.onModuleInit();
    expect(registry.register).not.toHaveBeenCalled();
  });
});

describe('MediaProcessingQueueService adapter', () => {
  beforeEach(() => { cancelFlag = false; });

  it('run delegates to the platform engine and emits the legacy started/progress/completed WS events', async () => {
    const { svc, realtime, platformJobs } = build();
    const result = await svc.run('library_scan', { libraryId: 'lib1' }, async (report) => {
      await report(50, 'scanning');
      return 'done';
    });
    expect(result).toBe('done');
    expect(platformJobs.run).toHaveBeenCalledTimes(1);
    expect(platformJobs.run.mock.calls[0][0]).toMatchObject({ type: 'media.library_scan', name: 'library_scan', libraryId: 'lib1' });
    const events = realtime.broadcast.mock.calls.map((c: unknown[]) => c[0]);
    expect(events).toEqual([WS_EVENTS.MEDIA_JOB_STARTED, WS_EVENTS.MEDIA_JOB_PROGRESS, WS_EVENTS.MEDIA_JOB_COMPLETED]);
  });

  it('runDetached returns the platform job id', async () => {
    const { svc } = build();
    const out = await svc.runDetached('duplicate_detect', {}, async () => ({}));
    expect(out).toEqual({ jobId: 'job-1' });
  });

  it('emits the legacy FAILED event and rethrows on a job body error', async () => {
    const { svc, realtime } = build();
    await expect(svc.run('metadata_fetch', { itemId: 'i1' }, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const events = realtime.broadcast.mock.calls.map((c: unknown[]) => c[0]);
    expect(events).toContain(WS_EVENTS.MEDIA_JOB_FAILED);
  });

  it('translates a cooperative cancel: legacy FAILED emitted, platform cancellation raised', async () => {
    const { svc, realtime } = build();
    cancelFlag = true;
    await expect(
      svc.run('duplicate_detect', {}, async (_r, signal) => { signal.throwIfCancelled(); return 'x'; }),
    ).rejects.toBeDefined();
    const failed = realtime.broadcast.mock.calls.find((c: unknown[]) => c[0] === WS_EVENTS.MEDIA_JOB_FAILED);
    expect(failed?.[1]).toMatchObject({ status: 'cancelled', error: 'Cancelled by the operator' });
  });

  it('requestCancel delegates to the platform engine', async () => {
    const { svc, platformJobs } = build();
    await expect(svc.requestCancel('job-1')).resolves.toBe(true);
    expect(platformJobs.requestCancel).toHaveBeenCalledWith('job-1');
  });

  it('still exports JobCancelledError with the expected name', () => {
    expect(new JobCancelledError().name).toBe('JobCancelledError');
  });
});
