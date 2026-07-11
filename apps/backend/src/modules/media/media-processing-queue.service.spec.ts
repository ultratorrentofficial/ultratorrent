import { MediaProcessingQueueService } from './media-processing-queue.service';

function build(updateManyResult = { count: 0 }) {
  const prisma = {
    mediaProcessingJob: {
      updateMany: jest.fn().mockResolvedValue(updateManyResult),
    },
  };
  const realtime = { broadcast: jest.fn(), emitTo: jest.fn() };
  const svc = new MediaProcessingQueueService(prisma as any, realtime as any);
  return { svc, prisma };
}

describe('MediaProcessingQueueService.onModuleInit — orphaned job reconciliation', () => {
  it('fails out jobs left queued/running by a previous process', async () => {
    // Job bodies run in-process, so a row still queued/running after a restart is
    // orphaned: its work died with the old process and can never resume.
    const { svc, prisma } = build({ count: 30 });

    await svc.onModuleInit();

    expect(prisma.mediaProcessingJob.updateMany).toHaveBeenCalledWith({
      where: { status: { in: ['queued', 'running'] } },
      data: expect.objectContaining({
        status: 'failed',
        error: 'Interrupted by a service restart',
        finishedAt: expect.any(Date),
      }),
    });
  });

  it('never blocks boot when the cleanup query fails', async () => {
    const { svc, prisma } = build();
    prisma.mediaProcessingJob.updateMany.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });

  it('is a no-op when there is nothing to reconcile', async () => {
    const { svc } = build({ count: 0 });
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });
});
