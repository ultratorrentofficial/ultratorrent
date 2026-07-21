import { PlatformJobService } from './platform-job.service';
import { JobRegistry } from './job-registry.service';
import { InvalidJobTransitionError } from './job-status';
import { REDACTED } from './job-redaction';
import { JobNonRetryableError, JobPausedError, type JobDefinition, type JobHandler } from './job.types';

/** Instant backoff so retry tests don't sleep. */
class TestJobService extends PlatformJobService {
  protected delay(): Promise<void> {
    return Promise.resolve();
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A minimal in-memory Prisma double covering exactly what the service calls. */
function fakePrisma() {
  const jobs = new Map<string, Record<string, unknown>>();
  const events: Record<string, unknown>[] = [];
  let jobSeq = 0;
  let evSeq = 0;

  const applyData = (row: Record<string, unknown>, data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in (v as object)) {
        row[k] = ((row[k] as number) ?? 0) + (v as { increment: number }).increment;
      } else if (v !== undefined) {
        row[k] = v;
      }
    }
  };

  return {
    _jobs: jobs,
    _events: events,
    platformJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `job-${++jobSeq}`;
        const row = { id, status: 'queued', attempt: 1, progressPercent: 0, rootJobId: null, ...data };
        jobs.set(id, row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = jobs.get(where.id);
        if (!row) throw new Error('not found');
        applyData(row, data);
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: { status: { in: string[] } }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of jobs.values()) {
          if (where.status.in.includes(row.status as string)) {
            applyData(row, data);
            count++;
          }
        }
        return { count };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = jobs.get(where.id);
        return row ? { ...row } : null;
      },
      findFirst: async ({ where }: { where: { idempotencyKey?: string; status?: { in: string[] } } }) => {
        for (const row of jobs.values()) {
          if (where.idempotencyKey && row.idempotencyKey === where.idempotencyKey && where.status?.in.includes(row.status as string)) {
            return { ...row };
          }
        }
        return null;
      },
    },
    platformJobEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `ev-${++evSeq}`, ...data };
        events.push(row);
        return { ...row };
      },
      findFirst: async ({ where }: { where: { jobId: string } }) => {
        const forJob = events.filter((e) => e.jobId === where.jobId);
        if (!forJob.length) return null;
        return forJob.reduce((a, b) => ((a.sequence as number) > (b.sequence as number) ? a : b));
      },
    },
  };
}

const stubRealtime = { emitToPermission: () => undefined } as never;

function makeService() {
  const registry = new JobRegistry();
  const prisma = fakePrisma();
  const eventBus = { emit: jest.fn() };
  const svc = new TestJobService(prisma as never, registry, stubRealtime, eventBus as never);
  return { registry, prisma, svc, eventBus };
}

const baseDef = (over: Partial<JobDefinition> = {}): JobDefinition => ({
  type: 'test.job',
  moduleKey: 'test',
  workspaceKey: 'system',
  labelKey: 'jobs.type.test',
  requiredPermission: 'test.view',
  capabilities: { cancellable: true, retryable: false, pausable: false, resumable: false },
  validateInput: (i) => i,
  summarizeInput: (i) => ({ ...(i as object) }),
  ...over,
});
const okHandler: JobHandler = { execute: async () => ({ result: 'done', resultSummary: { ok: true } }) };

function eventsFor(prisma: ReturnType<typeof fakePrisma>, jobId: string): string[] {
  return prisma._events.filter((e) => e.jobId === jobId).map((e) => e.eventType as string);
}

describe('PlatformJobService', () => {
  it('enqueue creates a queued, self-rooted job with created+queued events and a redacted input summary', async () => {
    const { registry, prisma, svc } = makeService();
    registry.register(baseDef(), okHandler);
    const job = await svc.enqueue({ type: 'test.job', input: { path: '/x', apiKey: 'secret' }, createdById: 'u1' });
    const stored = prisma._jobs.get(job.id)!;
    expect(stored.status).toBe('queued');
    expect(stored.rootJobId).toBe(job.id); // self-root
    expect(stored.cancellable).toBe(true);
    expect((stored.inputSummary as Record<string, unknown>).apiKey).toBe(REDACTED);
    expect(eventsFor(prisma, job.id)).toEqual(['created', 'queued']);
  });

  it('run drives a job to completed with started+completed events and returns the result', async () => {
    const { registry, prisma, svc } = makeService();
    registry.register(baseDef(), okHandler);
    const { jobId, result } = await svc.run({ type: 'test.job', input: {} });
    expect(result).toBe('done');
    const stored = prisma._jobs.get(jobId)!;
    expect(stored.status).toBe('completed');
    expect(stored.progressPercent).toBe(100);
    expect(eventsFor(prisma, jobId)).toEqual(['created', 'queued', 'started', 'completed']);
  });

  it('collects ctx.warn into completed_with_warnings', async () => {
    const { registry, prisma, svc } = makeService();
    registry.register(baseDef(), {
      execute: async (_i, ctx) => {
        await ctx.warn('jobs.warn.partial');
        return { result: 1 };
      },
    });
    const { jobId } = await svc.run({ type: 'test.job', input: {} });
    expect(prisma._jobs.get(jobId)!.status).toBe('completed_with_warnings');
    expect(eventsFor(prisma, jobId)).toContain('warning');
  });

  it('records a sanitized error on failure, rethrows, and emits a job.failed bus event', async () => {
    const { registry, prisma, svc, eventBus } = makeService();
    registry.register(baseDef(), { execute: async () => { throw Object.assign(new Error('boom token=abc'), { code: 'E_X' }); } });
    await expect(svc.run({ type: 'test.job', input: {} })).rejects.toThrow('boom');
    const stored = [...prisma._jobs.values()][0];
    expect(stored.status).toBe('failed');
    expect(stored.errorCode).toBe('E_X');
    expect(stored.errorMessage).toContain('token=' + REDACTED);
    expect(JSON.stringify(stored)).not.toContain('abc');
    // Notification/Automation integration: a job.failed domain event is published.
    const failedEvent = eventBus.emit.mock.calls.find((c) => (c[1] as { event?: string })?.event === 'job.failed');
    expect(failedEvent).toBeDefined();
  });

  it('cancels a still-queued job immediately', async () => {
    const { registry, prisma, svc } = makeService();
    registry.register(baseDef(), okHandler);
    const job = await svc.enqueue({ type: 'test.job', input: {} });
    expect(await svc.requestCancel(job.id)).toBe(true);
    expect(prisma._jobs.get(job.id)!.status).toBe('cancelled');
  });

  it('cooperatively cancels a running job (cancelled, not failed)', async () => {
    const { registry, prisma, svc } = makeService();
    registry.register(baseDef(), {
      execute: async (_i, ctx) => {
        // Simulate an operator cancelling mid-run, then a safe-boundary check.
        await svc.requestCancel(ctx.jobId);
        ctx.signal.throwIfCancelled();
        return {};
      },
    });
    await expect(svc.run({ type: 'test.job', input: {} })).rejects.toBeDefined();
    const stored = [...prisma._jobs.values()][0];
    expect(stored.status).toBe('cancelled');
    expect(eventsFor(prisma, stored.id as string)).toContain('cancelled');
  });

  it('enforces the state machine on transition()', async () => {
    const { registry, svc } = makeService();
    registry.register(baseDef(), okHandler);
    const { jobId } = await svc.run({ type: 'test.job', input: {} }); // now completed
    await expect(svc.transition(jobId, 'running')).rejects.toThrow(InvalidJobTransitionError);
  });

  it('idempotencyKey returns the existing active job instead of duplicating', async () => {
    const { registry, svc } = makeService();
    registry.register(baseDef(), okHandler);
    const a = await svc.enqueue({ type: 'test.job', input: {}, idempotencyKey: 'k1' });
    const b = await svc.enqueue({ type: 'test.job', input: {}, idempotencyKey: 'k1' });
    expect(b.id).toBe(a.id);
  });

  it('runs an inline executor (adapter path) instead of the registered handler', async () => {
    const { registry, prisma, svc } = makeService();
    registry.register(baseDef(), { execute: async () => { throw new Error('registered handler should not run'); } });
    const { jobId } = await svc.run({ type: 'test.job', input: {} }, async () => ({ result: 'inline' }));
    expect(prisma._jobs.get(jobId)!.status).toBe('completed');
  });

  it('retries a retryable failure with backoff and eventually completes', async () => {
    const { registry, prisma, svc } = makeService();
    let calls = 0;
    registry.register(baseDef({ capabilities: { cancellable: true, retryable: true, pausable: false, resumable: false } }), {
      execute: async () => {
        calls += 1;
        if (calls < 3) throw new Error('transient');
        return { result: 'ok' };
      },
    });
    const { jobId } = await svc.run({ type: 'test.job', input: {}, maxAttempts: 3 });
    expect(calls).toBe(3);
    const stored = prisma._jobs.get(jobId)!;
    expect(stored.status).toBe('completed');
    expect(stored.attempt).toBe(3);
    expect(eventsFor(prisma, jobId)).toContain('retry_scheduled');
  });

  it('does not retry a JobNonRetryableError even with attempts remaining', async () => {
    const { registry, prisma, svc } = makeService();
    let calls = 0;
    registry.register(baseDef({ capabilities: { cancellable: true, retryable: true, pausable: false, resumable: false } }), {
      execute: async () => { calls += 1; throw new JobNonRetryableError('unsafe'); },
    });
    await expect(svc.run({ type: 'test.job', input: {}, maxAttempts: 5 })).rejects.toThrow('unsafe');
    expect(calls).toBe(1);
    expect([...prisma._jobs.values()][0].status).toBe('failed');
  });

  it('does not auto-retry a non-retryable job type even on a retryable error', async () => {
    const { registry, prisma, svc } = makeService();
    let calls = 0;
    // retryable:false on the definition → job.retryable false
    registry.register(baseDef(), { execute: async () => { calls += 1; throw new Error('boom'); } });
    await expect(svc.run({ type: 'test.job', input: {}, maxAttempts: 5 })).rejects.toThrow('boom');
    expect(calls).toBe(1);
    expect([...prisma._jobs.values()][0].status).toBe('failed');
  });

  it('rerun creates a new linked job from the persisted input', async () => {
    const { registry, prisma, svc } = makeService();
    registry.register(baseDef(), { execute: async () => ({ result: 'r' }) });
    const first = await svc.run({ type: 'test.job', input: { libraryId: 'lib1' } });
    const rerun = await svc.rerun(first.jobId, 'u2');
    await flush();
    expect(rerun.jobId).not.toBe(first.jobId);
    const stored = prisma._jobs.get(rerun.jobId)!;
    expect(stored.status).toBe('completed');
    expect((stored.metadata as Record<string, unknown>).rerunOfJobId).toBe(first.jobId);
    expect(stored.createdById).toBe('u2');
  });

  it('pauses a pausable job (paused, not failed) and persists a checkpoint', async () => {
    const { registry, prisma, svc } = makeService();
    registry.register(baseDef({ capabilities: { cancellable: true, retryable: false, pausable: true, resumable: true } }), {
      execute: async (_i, ctx) => {
        (svc as unknown as { pauseRequested: Set<string> }).pauseRequested.add(ctx.jobId);
        if (ctx.isPauseRequested()) {
          await ctx.saveCheckpoint({ step: 1 });
          throw new JobPausedError();
        }
        return {};
      },
    });
    // run() resolves (paused is not a rejection)
    const { jobId } = await svc.run({ type: 'test.job', input: {} });
    const stored = prisma._jobs.get(jobId)!;
    expect(stored.status).toBe('paused');
    expect((stored.checkpoint as Record<string, unknown>).step).toBe(1);
    expect(eventsFor(prisma, jobId)).toContain('paused');
  });
});
