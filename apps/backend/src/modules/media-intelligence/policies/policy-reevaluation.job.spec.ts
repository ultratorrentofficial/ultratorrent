import { PERMISSIONS } from '@ultratorrent/shared';

import { PolicyReevaluationJob, POLICY_REEVALUATE_JOB_TYPE } from './policy-reevaluation.job';
import { ACTIVE_STATUSES } from '../../jobs/platform/job-status';

/**
 * Re-evaluating the library after operator intent changed.
 *
 * The claims worth pinning: one sweep is one sweep no matter how fast an
 * operator edits, the job never competes with the scheduled reconcile, and it
 * asks for the permission that means "make this system do work" rather than
 * the one that means "author intent".
 */

type Row = Record<string, unknown>;

function stub(options: { active?: Row | null; rebuilding?: boolean; summary?: Row } = {}) {
  const registered: Array<{ definition: Row; handler: Row }> = [];
  const detached: Row[] = [];

  const prisma = {
    // Typed with its argument so a test may assert on the WHERE it was given;
    // an arg-less mock narrows `mock.calls` to an empty tuple.
    platformJob: { findFirst: jest.fn(async (_args: Row) => options.active ?? null) },
  };
  const registry = {
    has: jest.fn(() => false),
    register: jest.fn((definition: Row, handler: Row) => {
      registered.push({ definition, handler });
    }),
  };
  const jobs = {
    runDetached: jest.fn(async (spec: Row) => {
      detached.push(spec);
      return { jobId: 'job-new' };
    }),
  };
  const projections = {
    isRebuilding: jest.fn(() => options.rebuilding ?? false),
    rebuildAll: jest.fn(async () => options.summary ?? { movies: 12, series: 3, failed: 0, skipped: false }),
  };

  const job = new PolicyReevaluationJob(
    prisma as never,
    registry as never,
    jobs as never,
    projections as never,
  );
  return { job, prisma, registry, jobs, projections, registered, detached };
}

/** A job execution context that records what the handler reported. */
function ctx() {
  const calls = { phases: [] as string[], warnings: [] as string[], progress: [] as Row[] };
  return {
    calls,
    context: {
      setPhase: jest.fn(async (phase: string) => {
        calls.phases.push(phase);
      }),
      progress: jest.fn(async (p: Row) => {
        calls.progress.push(p);
      }),
      warn: jest.fn(async (w: string) => {
        calls.warnings.push(w);
      }),
      heartbeat: jest.fn(async () => {}),
      signal: { throwIfCancelled: jest.fn() },
    },
  };
}

describe('PolicyReevaluationJob — registration', () => {
  it('registers the job type once', () => {
    const { job, registered } = stub();
    job.onModuleInit();
    expect(registered).toHaveLength(1);
    expect(registered[0].definition.type).toBe(POLICY_REEVALUATE_JOB_TYPE);
  });

  it('does not re-register a type the registry already has', () => {
    const { job, registry } = stub();
    registry.has.mockReturnValue(true);
    job.onModuleInit();
    expect(registry.register).not.toHaveBeenCalled();
  });

  it('asks for scan, not the policy-authoring permission', () => {
    const { job, registered } = stub();
    job.onModuleInit();
    // The job changes no intent — it recomputes from what is already stored.
    expect(registered[0].definition.requiredPermission).toBe(PERMISSIONS.MEDIA_MANAGER_SCAN);
    expect(registered[0].definition.requiredPermission).not.toBe(
      PERMISSIONS.MEDIA_LIFECYCLE_POLICY_MANAGE,
    );
  });

  it('is cancellable but never automatically retried', () => {
    const { job, registered } = stub();
    job.onModuleInit();
    // An automatic retry would restart a full library sweep nobody asked for.
    expect(registered[0].definition.capabilities).toEqual({
      cancellable: true,
      retryable: false,
      pausable: false,
      resumable: false,
    });
    expect(registered[0].definition.defaultMaxAttempts).toBe(1);
  });

  it('summarizes its input without inventing a reason', () => {
    const { job, registered } = stub();
    job.onModuleInit();
    const summarize = registered[0].definition.summarizeInput as (i: unknown) => Row;
    expect(summarize({})).toEqual({ policyId: null, policyName: null, reason: 'updated' });
  });
});

describe('PolicyReevaluationJob.request — idempotency', () => {
  it('returns the in-flight sweep instead of starting a second one', async () => {
    const { job, jobs } = stub({ active: { id: 'job-running' } });

    const out = await job.request({ policyId: 'p1', policyName: 'A', reason: 'updated' });

    // Editing three policies in quick succession must not start three
    // traversals of the library.
    expect(out).toEqual({ jobId: 'job-running' });
    expect(jobs.runDetached).not.toHaveBeenCalled();
  });

  it('matches an in-flight sweep on ACTIVE statuses only', async () => {
    const { job, prisma } = stub();
    await job.request({ policyId: 'p1', policyName: 'A', reason: 'created' });

    const where = prisma.platformJob.findFirst.mock.calls[0][0] as { where: Row };
    expect(where.where).toEqual({
      idempotencyKey: 'media-intelligence:policy-reevaluate',
      status: { in: [...ACTIVE_STATUSES] },
    });
  });

  it('starts a sweep when none is running, under a stable idempotency key', async () => {
    const { job, detached } = stub();
    const out = await job.request({ policyId: 'p1', policyName: 'TV Standard', reason: 'created' });

    expect(out).toEqual({ jobId: 'job-new' });
    expect(detached[0]).toMatchObject({
      type: POLICY_REEVALUATE_JOB_TYPE,
      source: 'manual',
      resourceType: 'media_lifecycle_policy',
      resourceId: 'p1',
      idempotencyKey: 'media-intelligence:policy-reevaluate',
    });
  });

  it('names the sweep after the policy that triggered it', async () => {
    const { job, detached } = stub();
    await job.request({ policyId: 'p1', policyName: 'TV Standard', reason: 'updated' });
    expect(detached[0].name).toBe('Re-evaluate policies: TV Standard');
  });

  it('falls back to a generic name when no policy is named', async () => {
    const { job, detached } = stub();
    await job.request({ policyId: null, policyName: null, reason: 'deleted' });
    expect(detached[0].name).toBe('Re-evaluate lifecycle policies');
    expect(detached[0].resourceId).toBe('all');
  });
});

describe('PolicyReevaluationJob — execution', () => {
  async function run(job: PolicyReevaluationJob, input: Row, registered: Array<{ handler: Row }>) {
    job.onModuleInit();
    const c = ctx();
    const handler = registered[0].handler as { execute: (i: unknown, x: unknown) => Promise<Row> };
    const result = await handler.execute(input, c.context);
    return { result, c };
  }

  it('does the sweep and reports what it covered', async () => {
    const { job, registered, projections } = stub();
    const { result, c } = await run(job, { policyId: 'p1', policyName: 'A', reason: 'updated' }, registered);

    expect(projections.rebuildAll).toHaveBeenCalledTimes(1);
    expect(result.resultSummary).toMatchObject({ movies: 12, series: 3, failed: 0, reason: 'updated' });
    expect(c.calls.phases).toEqual(['evaluating']);
  });

  it('refuses to overlap the scheduled reconcile, and says so', async () => {
    const { job, registered, projections } = stub({ rebuilding: true });
    const { result, c } = await run(job, { policyId: null, policyName: null, reason: 'updated' }, registered);

    // Reporting honestly beats a job that "succeeded" having done nothing.
    expect(projections.rebuildAll).not.toHaveBeenCalled();
    expect(c.calls.warnings).toEqual(['jobs.policyReevaluate.alreadyRunning']);
    expect(result.resultSummary).toMatchObject({ skipped: true, reason: 'reconciliation_already_running' });
  });

  it('reports indeterminate progress rather than inventing a total', async () => {
    const { job, registered } = stub();
    const { c } = await run(job, { policyId: null, policyName: null, reason: 'created' }, registered);
    // The sweep discovers entities as it pages; a fake total would tick wrong.
    expect(c.calls.progress[0]).toMatchObject({ indeterminate: true });
  });

  it('checks for cancellation before starting the traversal', async () => {
    const { job, registered } = stub();
    const { c } = await run(job, { policyId: null, policyName: null, reason: 'created' }, registered);
    expect(c.context.signal.throwIfCancelled).toHaveBeenCalled();
  });

  it('surfaces a skipped rebuild rather than reporting success', async () => {
    const { job, registered } = stub({
      summary: { movies: 0, series: 0, failed: 0, skipped: true },
    });
    const { result } = await run(job, { policyId: null, policyName: null, reason: 'deleted' }, registered);
    expect((result.resultSummary as Row).skipped).toBe(true);
  });
});
