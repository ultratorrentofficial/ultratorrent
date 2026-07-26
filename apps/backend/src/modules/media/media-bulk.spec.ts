import { BadRequestException } from '@nestjs/common';
import { MAX_BULK_IDS, MediaBulkService } from './media-bulk.service';

/**
 * Bulk over an explicit selection.
 *
 * The ids are supplied by a client and are the entire input to operations that
 * write rows and touch disk, so what is tested here is mostly what the service
 * refuses to take on trust.
 */
describe('MediaBulkService', () => {
  const build = (rows: Array<{ id: string; locked?: boolean }> = []) => {
    const store = rows.map((r) => ({ locked: false, ...r }));
    const audits: any[] = [];
    const jobBodies: any[] = [];

    const prisma: any = {
      mediaItem: {
        findMany: jest.fn(async ({ where }: any) =>
          store
            .filter((r) => where.id.in.includes(r.id))
            .filter((r) => (where.locked === false ? !r.locked : true))
            .map((r) => ({ id: r.id })),
        ),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const hit = store.filter((r) => where.id.in.includes(r.id));
          hit.forEach((r) => Object.assign(r, data));
          return { count: hit.length };
        }),
      },
    };
    const jobs: any = {
      runDetached: jest.fn(async (_type: string, opts: any, fn: any) => {
        jobBodies.push({ opts, fn });
        return { jobId: 'job-1' };
      }),
    };
    const audit: any = { record: jest.fn(async (e: any) => { audits.push(e); }) };

    return { svc: new MediaBulkService(prisma, jobs, audit), store, audits, jobs, jobBodies };
  };

  const ctx = { userId: 'u1', ipAddress: '10.0.0.1', userAgent: 'jest' };

  /* ------------------------------------------------------------- validation */

  it('refuses an empty selection rather than running over everything', async () => {
    const { svc } = build();
    await expect(svc.setLocked([], true, ctx)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a selection larger than the cap', async () => {
    // A library-wide operation is a scope, not a list of 500,000 ids.
    const { svc } = build();
    const tooMany = Array.from({ length: MAX_BULK_IDS + 1 }, (_, i) => `i${i}`);
    await expect(svc.setLocked(tooMany, true, ctx)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('collapses duplicate ids so a double-click cannot process an item twice', async () => {
    const { svc, jobs } = build([{ id: 'a' }]);
    await svc.refreshMetadata(['a', 'a', 'a'], ctx, async () => {});
    expect(jobs.runDetached.mock.calls[0][1].payload.itemIds).toEqual(['a']);
  });

  it('reports ids that resolved to nothing instead of silently dropping them', async () => {
    // Acting on fewer items than asked, silently, is how an operator believes
    // work happened that did not.
    const { svc } = build([{ id: 'a' }]);
    const out = await svc.setLocked(['a', 'ghost'], true, ctx);
    expect(out.accepted).toBe(1);
    expect(out.missing).toEqual(['ghost']);
  });

  /* ------------------------------------------------------------------ locks */

  it('skips locked items silently, as every other bulk path does', async () => {
    const { svc, jobs } = build([{ id: 'a' }, { id: 'b', locked: true }]);
    const out = await svc.refreshMetadata(['a', 'b'], ctx, async () => {});
    expect(jobs.runDetached.mock.calls[0][1].payload.itemIds).toEqual(['a']);
    expect(out.accepted).toBe(1);
    // A lock is a state, not a failure — it is not reported as missing.
    expect(out.missing).toEqual([]);
  });

  it('still locks and unlocks an already-locked item', async () => {
    // Setting the flag is the one operation a lock must not exclude, or an
    // item could never be unlocked in bulk.
    const { svc, store } = build([{ id: 'a', locked: true }]);
    await svc.setLocked(['a'], false, ctx);
    expect(store[0].locked).toBe(false);
  });

  /* ------------------------------------------------------------------ audit */

  it('writes ONE audit row for one operator action', async () => {
    const { svc, audits } = build([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    await svc.setLocked(['a', 'b', 'c'], true, ctx);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: 'u1', action: 'media.bulk.lock', objectType: 'media_item',
    });
    // The set is on the row: "who ran this, over what" is the question.
    expect(audits[0].metadata.itemIds).toEqual(['a', 'b', 'c']);
    expect(audits[0].metadata.count).toBe(3);
  });

  it('distinguishes lock from unlock in the trail', async () => {
    const { svc, audits } = build([{ id: 'a' }]);
    await svc.setLocked(['a'], false, ctx);
    expect(audits[0].action).toBe('media.bulk.unlock');
  });

  /* ------------------------------------------------------------------- jobs */

  it('returns a job id immediately rather than holding the request open', async () => {
    const { svc } = build([{ id: 'a' }]);
    const out = await svc.refreshMetadata(['a'], ctx, async () => {});
    expect(out.jobId).toBe('job-1');
  });

  it('does not create a job for a flag flip', async () => {
    // Making an operator watch a job for one indexed updateMany is ceremony.
    const { svc, jobs } = build([{ id: 'a' }]);
    await svc.setLocked(['a'], true, ctx);
    expect(jobs.runDetached).not.toHaveBeenCalled();
  });

  it('continues past a failure instead of abandoning the selection', async () => {
    const { svc, jobBodies } = build([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    await svc.refreshMetadata(['a', 'b', 'c'], ctx, async (id) => {
      if (id === 'b') throw new Error('provider miss');
    });
    const report = jest.fn();
    const summary: any = await jobBodies[0].fn(report, { isCancelled: () => false });
    expect(summary).toEqual({ total: 3, completed: 3, failed: 1 });
  });

  it('stops between items when the job is cancelled', async () => {
    const { svc, jobBodies } = build([{ id: 'a' }, { id: 'b' }]);
    await svc.refreshMetadata(['a', 'b'], ctx, async () => {});
    const summary: any = await jobBodies[0].fn(jest.fn(), { isCancelled: () => true });
    // Cooperative: this writes rows, so it must not stop mid-write.
    expect(summary.completed).toBe(0);
  });

  it('reports progress as it goes', async () => {
    const { svc, jobBodies } = build([{ id: 'a' }, { id: 'b' }]);
    await svc.refreshMetadata(['a', 'b'], ctx, async () => {});
    const report = jest.fn();
    await jobBodies[0].fn(report, { isCancelled: () => false });
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith(100, '2/2');
  });

  it('does not divide by zero when every item was locked out', async () => {
    const { svc, jobBodies } = build([{ id: 'a', locked: true }]);
    await svc.refreshMetadata(['a'], ctx, async () => {});
    const summary: any = await jobBodies[0].fn(jest.fn(), { isCancelled: () => false });
    expect(summary).toEqual({ total: 0, completed: 0, failed: 0 });
  });
});
