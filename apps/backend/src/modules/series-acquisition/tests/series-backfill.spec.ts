import { SeriesBackfillService, type SeriesBackfillInput } from '../series-backfill.service';
import { JobCancelledError, JobPausedError, type JobExecutionContext } from '../../jobs/platform/job.types';

/**
 * The backfill job body and its enqueue guard. The job is only a driver over
 * MissingEpisodeSearchService.searchEpisode — these tests assert the driver's
 * contract: scope filtering, idempotent skipping, bounded concurrency, and
 * cooperative pause/cancel through the platform JobExecutionContext.
 */

function fakeCtx(over: Partial<JobExecutionContext> = {}): JobExecutionContext {
  const checkpoints: unknown[] = [];
  const ctx = {
    jobId: 'job1',
    rootJobId: 'job1',
    parentJobId: null,
    attempt: 1,
    correlationId: null,
    runAsUserId: 'u1',
    signal: { isCancelled: () => false, throwIfCancelled: () => {} },
    progress: jest.fn(async () => {}),
    setPhase: jest.fn(async () => {}),
    event: jest.fn(async () => {}),
    warn: jest.fn(async () => {}),
    heartbeat: jest.fn(async () => {}),
    saveCheckpoint: jest.fn(async (c: unknown) => void checkpoints.push(c)),
    loadCheckpoint: jest.fn(async () => undefined),
    metric: jest.fn(),
    isPauseRequested: () => false,
    ...over,
  } as unknown as JobExecutionContext;
  (ctx as any)._checkpoints = checkpoints;
  return ctx;
}

function harness(
  opts: {
    rows?: Array<{ id: string; seasonNumber?: number }>;
    freshStatus?: Record<string, string>; // per-id status at re-read time
    outcomes?: Record<string, string>; // per-id searchStatus
    activeJob?: { id: string } | null;
  } = {},
) {
  const wantedFindMany = jest.fn().mockResolvedValue(opts.rows ?? [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]);
  const prisma: any = {
    wantedEpisode: {
      findMany: wantedFindMany,
      findUnique: jest.fn(async ({ where }: any) => ({
        status: opts.freshStatus?.[where.id] ?? 'missing',
        excludedFromScope: false,
      })),
    },
    platformJob: { findFirst: jest.fn().mockResolvedValue(opts.activeJob ?? null) },
  };
  const registry: any = { has: jest.fn().mockReturnValue(false), register: jest.fn() };
  const platformJobs: any = {
    runDetached: jest.fn().mockResolvedValue({ jobId: 'new-job' }),
    requestPause: jest.fn(),
    resume: jest.fn(),
    requestCancel: jest.fn(),
  };
  const search: any = {
    searchEpisode: jest.fn(async (id: string) => ({
      wantedEpisodeId: id,
      searchStatus: opts.outcomes?.[id] ?? 'grabbed',
    })),
  };
  const realtime: any = { broadcast: jest.fn() };

  const svc = new SeriesBackfillService(prisma, registry, platformJobs, search, realtime);
  return { svc, prisma, search, platformJobs, wantedFindMany, realtime };
}

const input: SeriesBackfillInput = {
  watchlistItemId: 'wl1',
  seriesTconst: 'tt100',
  title: 'Show',
  seasons: null,
};

describe('SeriesBackfillService.execute', () => {
  it('searches every in-scope missing episode and tallies the outcomes', async () => {
    const { svc, search } = harness({
      rows: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }],
      outcomes: { e1: 'grabbed', e2: 'no_results', e3: 'pending_approval' },
    });
    const { result } = await svc.execute(input, fakeCtx());
    expect(search.searchEpisode).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ total: 3, grabbed: 1, noResults: 1, pendingApproval: 1, failed: 0 });
  });

  it('only selects missing, in-scope episodes (optionally season-filtered)', async () => {
    const { svc, wantedFindMany } = harness();
    await svc.execute({ ...input, seasons: [2, 3] }, fakeCtx());
    const where = wantedFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: 'missing', excludedFromScope: false, seasonNumber: { in: [2, 3] } });
  });

  it('skips an episode that is no longer missing (idempotent re-run)', async () => {
    const { svc, search } = harness({
      rows: [{ id: 'e1' }, { id: 'e2' }],
      freshStatus: { e2: 'grabbed' }, // already grabbed since the job started
    });
    const { result } = await svc.execute(input, fakeCtx());
    expect(search.searchEpisode).toHaveBeenCalledTimes(1);
    expect(search.searchEpisode).toHaveBeenCalledWith('e1', 'u1');
    expect(result).toMatchObject({ skipped: 1, grabbed: 1 });
  });

  it('resumes from a checkpoint, skipping already-done episodes', async () => {
    const { svc, search } = harness({ rows: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }] });
    const ctx = fakeCtx({ loadCheckpoint: jest.fn(async () => ({ doneIds: ['e1', 'e2'] })) as any });
    await svc.execute(input, ctx);
    expect(search.searchEpisode).toHaveBeenCalledTimes(1);
    expect(search.searchEpisode).toHaveBeenCalledWith('e3', 'u1');
  });

  it('pauses at a safe boundary: checkpoints then throws JobPausedError', async () => {
    const { svc } = harness({ rows: [{ id: 'e1' }, { id: 'e2' }] });
    const saveCheckpoint = jest.fn(async () => {});
    const ctx = fakeCtx({ isPauseRequested: () => true, saveCheckpoint: saveCheckpoint as any });
    await expect(svc.execute(input, ctx)).rejects.toBeInstanceOf(JobPausedError);
    expect(saveCheckpoint).toHaveBeenCalled();
  });

  it('cancels at a safe boundary: throws JobCancelledError', async () => {
    const { svc } = harness({ rows: [{ id: 'e1' }] });
    const ctx = fakeCtx({
      signal: {
        isCancelled: () => true,
        throwIfCancelled: () => {
          throw new JobCancelledError();
        },
      },
    });
    await expect(svc.execute(input, ctx)).rejects.toBeInstanceOf(JobCancelledError);
  });

  it('a thrown searchEpisode is counted as failed, not fatal', async () => {
    const { svc } = harness({ rows: [{ id: 'e1' }, { id: 'e2' }] });
    const { svc: _d, search } = harness();
    search.searchEpisode.mockRejectedValueOnce(new Error('indexer down'));
    const svc2 = new SeriesBackfillService(
      (svc as any).prisma,
      { has: () => false, register: () => {} } as any,
      { runDetached: jest.fn() } as any,
      search,
      { broadcast: jest.fn() } as any,
    );
    const { result, warnings } = await svc2.execute(input, fakeCtx());
    expect(result?.failed).toBe(1);
    expect(warnings).toBeDefined();
  });
});

describe('SeriesBackfillService.enqueue', () => {
  it('returns the in-flight job instead of starting a second flood', async () => {
    const { svc, platformJobs } = harness({ activeJob: { id: 'existing' } });
    const res = await svc.enqueue(input);
    expect(res.jobId).toBe('existing');
    expect(platformJobs.runDetached).not.toHaveBeenCalled();
  });

  it('starts a detached job when none is active', async () => {
    const { svc, platformJobs } = harness({ activeJob: null });
    const res = await svc.enqueue(input, 'u1');
    expect(res.jobId).toBe('new-job');
    expect(platformJobs.runDetached).toHaveBeenCalledTimes(1);
    const arg = platformJobs.runDetached.mock.calls[0][0];
    expect(arg.idempotencyKey).toBe('series-backfill:wl1');
  });
});
