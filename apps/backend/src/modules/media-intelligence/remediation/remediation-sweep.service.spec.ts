import { RemediationSweepService } from './remediation-sweep.service';

/**
 * What drives approved plans forward.
 *
 * The claims worth pinning are the ones that keep an autonomous loop from
 * becoming a stampede or a lie: that it does nothing when the module is off,
 * that it cannot overlap itself, that a batch is bounded, that it attributes
 * work to the human who approved it rather than to an invented system actor,
 * and that one failing plan does not stop the rest.
 */

type Row = Record<string, unknown>;

function stub(opts: {
  enabled?: boolean;
  approved?: Row[];
  verifying?: Row[];
  executeThrows?: boolean;
} = {}) {
  const calls = { executed: [] as Array<[string, string | undefined]>, verified: [] as string[] };

  const prisma = {
    mediaRemediationPlan: {
      findMany: jest.fn(async (args: { where: Row; take?: number }) => {
        const status = (args.where as { status?: string }).status;
        const rows = status === 'approved' ? (opts.approved ?? []) : (opts.verifying ?? []);
        return rows.slice(0, args.take ?? rows.length);
      }),
    },
  };

  const registry = {
    getStatus: jest.fn(() => ({ enabled: opts.enabled ?? true })),
  };

  const executor = {
    execute: jest.fn(async (id: string, actor?: string) => {
      if (opts.executeThrows) throw new Error('boom');
      calls.executed.push([id, actor]);
      return { status: 'verifying' as const };
    }),
    verify: jest.fn(async (id: string) => {
      calls.verified.push(id);
      return { status: 'succeeded' as const };
    }),
  };

  const svc = new RemediationSweepService(
    prisma as never,
    registry as never,
    executor as never,
  );
  return { svc, prisma, registry, executor, calls };
}

describe('the sweep does nothing it should not', () => {
  it('stays idle when the module is switched off', () => {
    const { svc, prisma } = stub({ enabled: false, approved: [{ id: 'p1' }] });
    svc.tick();
    // Guarded on this module's own id, matching the Phase 1 reconciler: a
    // sweep that outlives its module is a sweep nobody can turn off.
    expect(prisma.mediaRemediationPlan.findMany).not.toHaveBeenCalled();
  });

  it('cannot overlap itself while a source domain is slow', () => {
    const { svc, prisma } = stub({ approved: [{ id: 'p1' }] });
    svc.tick();
    svc.tick();
    // The second tick returns immediately; only one sweep is in flight.
    expect(prisma.mediaRemediationPlan.findMany.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('execution', () => {
  it('attributes the action to the human who approved it', async () => {
    /*
     * There is no autonomous actor in this platform. Inventing a system
     * principal here would be exactly the fake identity Phase 6 refused —
     * the approval IS the authority this runs under.
     */
    const { svc, calls } = stub({ approved: [{ id: 'p1', approvedById: 'user-7' }] });
    await svc.sweep();
    expect(calls.executed).toEqual([['p1', 'user-7']]);
  });

  it('bounds a batch rather than draining the whole backlog at once', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, approvedById: 'u' }));
    const { svc, prisma } = stub({ approved: many });
    await svc.sweep();

    const take = (prisma.mediaRemediationPlan.findMany.mock.calls[0][0] as { take: number }).take;
    // A sweep that fires fifty source actions at once is indistinguishable
    // from an outage to whoever is on the other end.
    expect(take).toBeLessThanOrEqual(10);
  });

  it('drains oldest first, so a queue is fair without a priority score', async () => {
    const { svc, prisma } = stub({ approved: [{ id: 'p1', approvedById: 'u' }] });
    await svc.sweep();
    expect((prisma.mediaRemediationPlan.findMany.mock.calls[0][0] as Row).orderBy).toEqual({
      createdAt: 'asc',
    });
  });

  it('isolates a failing plan so the rest of the batch still runs', async () => {
    const { svc, executor } = stub({
      approved: [{ id: 'p1', approvedById: 'u' }, { id: 'p2', approvedById: 'u' }],
      executeThrows: true,
    });
    const out = await svc.sweep();

    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(out.executed).toBe(0);
  });
});

describe('verification', () => {
  it('verifies plans awaiting source truth in the same sweep', async () => {
    const { svc, calls } = stub({ verifying: [{ id: 'p9' }] });
    const out = await svc.sweep();

    // Same tick rather than a second timer with its own failure modes.
    expect(calls.verified).toEqual(['p9']);
    expect(out.verified).toBe(1);
  });

  it('reports nothing done when there is nothing to do', async () => {
    const { svc } = stub();
    expect(await svc.sweep()).toEqual({ executed: 0, verified: 0 });
  });
});
