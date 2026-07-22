import { WorkflowResumeService } from './workflow-resume.service';

describe('WorkflowResumeService', () => {
  it('retention prunes finished and (older) failed executions', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 3 });
    const prisma = { workflowExecution: { deleteMany } } as any;
    const executions = {} as any;
    await new WorkflowResumeService(prisma, executions).retention();

    expect(deleteMany).toHaveBeenCalledTimes(1);
    const where = deleteMany.mock.calls[0][0].where;
    // Two branches: finished statuses (7d) OR failed (30d).
    const [finished, failed] = where.OR;
    expect(finished.status.in).toEqual(expect.arrayContaining(['completed', 'cancelled']));
    expect(failed.status).toBe('failed');
    // Failed is retained longer, so its cutoff is older than the finished cutoff.
    expect(failed.createdAt.lt.getTime()).toBeLessThan(finished.createdAt.lt.getTime());
  });

  it('resume tick advances due delays and expires waits', async () => {
    const resume = jest.fn().mockResolvedValue(undefined);
    const findMany = jest.fn()
      .mockResolvedValueOnce([{ id: 'd1' }])                      // due delays
      .mockResolvedValueOnce([{ id: 'w1', status: 'waiting_for_approval' }]); // expired
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = { workflowExecution: { findMany }, workflowApproval: { updateMany } } as any;
    await new WorkflowResumeService(prisma, { resume } as any).tick();

    expect(resume).toHaveBeenCalledWith('d1', 'out');
    expect(updateMany).toHaveBeenCalled(); // pending approval expired
    expect(resume).toHaveBeenCalledWith('w1', 'timeout');
  });
});
