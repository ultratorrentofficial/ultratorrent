import { CleanupJobBridge } from './cleanup-job.bridge';

/**
 * The mirror is observability, not authority. What matters here is that nothing it
 * does can propagate into the cleanup path — a Jobs Center problem must not be able
 * to abort a scan half-way, and certainly not leave a plan mid-execution.
 */

function makeBridge(over: {
  has?: boolean;
  registerThrows?: boolean;
  enqueueThrows?: boolean;
  transitionThrows?: boolean;
} = {}) {
  const registered: Array<{ type: string; capabilities: Record<string, boolean> }> = [];
  const transitions: Array<{ jobId: string; to: string }> = [];

  const registry = {
    has: jest.fn(() => over.has ?? false),
    register: jest.fn((def: { type: string; capabilities: Record<string, boolean> }) => {
      if (over.registerThrows) throw new Error('duplicate job type');
      registered.push(def);
    }),
  };
  const jobs = {
    enqueue: jest.fn(async () => {
      if (over.enqueueThrows) throw new Error('queue unavailable');
      return { id: 'job-1' };
    }),
    transition: jest.fn(async (jobId: string, to: string) => {
      if (over.transitionThrows) throw new Error('invalid transition');
      transitions.push({ jobId, to });
    }),
  };

  const bridge = new CleanupJobBridge(registry as never, jobs as never);
  return { bridge, registry, jobs, registered, transitions };
}

describe('job definitions', () => {
  it('registers both cleanup job types', () => {
    const h = makeBridge();
    h.bridge.onModuleInit();
    expect(h.registered.map((d) => d.type)).toEqual([
      'library_cleanup.run', 'library_cleanup.execution',
    ]);
  });

  /**
   * The single most important line in this file. A generic Jobs Center retry of a
   * plan execution would remove files under an approval that was granted for a
   * different moment — the exact thing the whole feature exists to prevent.
   */
  it('makes a plan execution neither retryable nor resumable', () => {
    const h = makeBridge();
    h.bridge.onModuleInit();
    const exec = h.registered.find((d) => d.type === 'library_cleanup.execution')!;
    expect(exec.capabilities.retryable).toBe(false);
    expect(exec.capabilities.resumable).toBe(false);
    expect(exec.capabilities.pausable).toBe(false);
  });

  it('does not re-register when the type is already known', () => {
    const h = makeBridge({ has: true });
    h.bridge.onModuleInit();
    expect(h.registry.register).not.toHaveBeenCalled();
  });

  it('never crashes boot when registration fails', () => {
    const h = makeBridge({ registerThrows: true });
    expect(() => h.bridge.onModuleInit()).not.toThrow();
  });
});

describe('the mirror never propagates a failure', () => {
  it('returns null instead of throwing when a job cannot be enqueued', async () => {
    const h = makeBridge({ enqueueThrows: true });
    await expect(h.bridge.startRunJob('r1', 'p1', 'Nightly')).resolves.toBeNull();
    await expect(h.bridge.startExecutionJob('plan1', 'Plan')).resolves.toBeNull();
  });

  it('swallows a bad transition', async () => {
    const h = makeBridge({ transitionThrows: true });
    await expect(h.bridge.finish('job-1', 'completed')).resolves.toBeUndefined();
  });

  it('does nothing at all when there is no job to mirror to', async () => {
    const h = makeBridge();
    await h.bridge.finish(null, 'completed');
    expect(h.jobs.transition).not.toHaveBeenCalled();
  });
});

describe('terminal states', () => {
  it.each([
    ['completed', ['completed']],
    // A partial run left files alone on purpose — "finished, but look at it".
    ['partial', ['completed_with_warnings']],
    ['failed', ['failed']],
    ['cancelled', ['cancelling', 'cancelled']],
  ])('maps %s', async (status, expected) => {
    const h = makeBridge();
    await h.bridge.finish('job-1', status);
    expect(h.transitions.map((t) => t.to)).toEqual(expected);
  });

  it('ignores a status that is not terminal', async () => {
    const h = makeBridge();
    await h.bridge.finish('job-1', 'running');
    expect(h.transitions).toEqual([]);
  });
});
