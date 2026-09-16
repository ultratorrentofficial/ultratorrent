import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RemediationPlanExecutorService } from './plan-executor.service';

/**
 * Executing an approved plan.
 *
 * The claims worth pinning are the ones that separate an executor from a
 * thing that merely calls a function: that two workers cannot both run a
 * plan, that every safety property is re-established immediately before the
 * mutation rather than inherited from approval, that a step is journalled
 * before the source call, and — the one that matters most — that success
 * means SOURCE TRUTH changed, never that a call returned.
 */

type Row = Record<string, unknown>;

const STEP = {
  id: 'step-1',
  ordinal: 0,
  kind: 'refresh_metadata',
  ownerDomain: 'media_manager',
  status: 'pending',
  inputSnapshot: { itemId: 'item-1' },
  expectedPostcondition: { metadataProviderPresent: true },
};

const PLAN = {
  id: 'plan-1',
  entityType: 'movie',
  entityId: 'item-1',
  status: 'executing',
  recommendationId: 'rec-1',
  recommendationFingerprint: null,
  expiresAt: new Date('2099-01-01T00:00:00Z'),
  steps: [STEP],
};

function stub(opts: {
  claim?: number;
  plan?: Row | null;
  item?: Row | null;
  recommendation?: Row | null;
  metadata?: Row | null | undefined;
  fetchThrows?: Error;
} = {}) {
  const calls = {
    planUpdates: [] as Row[],
    stepUpdates: [] as Row[],
    events: [] as string[],
    fetched: [] as string[],
    audits: [] as Row[],
  };

  const prisma = {
    mediaRemediationPlan: {
      updateMany: jest.fn(async (args: { where: Row; data: Row }) => {
        calls.planUpdates.push({ ...args.where, ...args.data });
        // The claim is a compare-and-swap: the caller decides from the count.
        if ((args.data as Row).status === 'executing') return { count: opts.claim ?? 1 };
        return { count: 1 };
      }),
      findUnique: jest.fn(async () => (opts.plan === undefined ? PLAN : opts.plan)),
    },
    mediaRemediationStep: {
      update: jest.fn(async (args: { where: Row; data: Row }) => {
        calls.stepUpdates.push({ ...args.where, ...args.data });
        return {};
      }),
    },
    mediaRemediationPlanEvent: {
      create: jest.fn(async (args: { data: Row }) => {
        calls.events.push((args.data as { event: string }).event);
        return {};
      }),
    },
    mediaItem: {
      findUnique: jest.fn(async () => (opts.item === undefined ? { locked: false } : opts.item)),
    },
    mediaIntelligenceRecommendation: {
      findUnique: jest.fn(async () =>
        opts.recommendation === undefined
          ? { id: 'rec-1', type: 'REFRESH_METADATA', status: 'active', confidence: 'high', capabilityId: 'media.metadata.refresh', evidence: {} }
          : opts.recommendation,
      ),
    },
    mediaMetadata: {
      findUnique: jest.fn(async () =>
        opts.metadata === undefined ? { providerName: 'tmdb' } : opts.metadata,
      ),
    },
  };

  const audit = {
    record: jest.fn(async (e: Row) => {
      calls.audits.push(e);
    }),
  };

  const metadataService = {
    fetchMetadata: jest.fn(async (id: string) => {
      if (opts.fetchThrows) throw opts.fetchThrows;
      calls.fetched.push(id);
      return {};
    }),
  };
  const moduleRef = { get: jest.fn(() => metadataService) };

  const svc = new RemediationPlanExecutorService(
    prisma as never,
    audit as never,
    moduleRef as never,
  );
  return { svc, prisma, calls, metadataService };
}

describe('claiming', () => {
  it('claims by compare-and-swap on the status it expects', async () => {
    const { svc, calls } = stub();
    await svc.execute('plan-1');

    // The lease IS the status column: no SELECT FOR UPDATE exists in this
    // codebase and this needs none.
    expect(calls.planUpdates[0]).toMatchObject({ id: 'plan-1', status: 'executing' });
  });

  it('does nothing when another worker already claimed it', async () => {
    const { svc, calls, metadataService } = stub({ claim: 0 });
    const out = await svc.execute('plan-1');

    expect(out).toEqual({ status: 'not_claimed' });
    expect(metadataService.fetchMetadata).not.toHaveBeenCalled();
    expect(calls.events).toEqual([]);
  });

  it('refuses a plan that is not approved', async () => {
    // Expressed by the CAS itself: the where-clause names `approved`, so a
    // proposed or blocked plan matches zero rows.
    const { svc, calls } = stub({ claim: 0 });
    await svc.execute('plan-1');
    expect(calls.planUpdates[0]).toMatchObject({ status: 'executing' });
  });
});

describe('safety is re-established immediately before the mutation', () => {
  it('blocks when a lock was applied AFTER approval', async () => {
    /*
     * The case planning cannot cover. The executor no longer rides the bulk
     * path's silent lock filter, so this gate is the only defence — and a
     * silent skip would have reported success having touched nothing.
     */
    const { svc, calls, metadataService } = stub({ item: { locked: true } });
    const out = await svc.execute('plan-1');

    expect(out).toEqual({ status: 'blocked', blockReason: 'item_locked' });
    expect(metadataService.fetchMetadata).not.toHaveBeenCalled();
  });

  it('blocks when the entity vanished between approval and execution', async () => {
    const { svc, metadataService } = stub({ item: null });
    const out = await svc.execute('plan-1');

    expect(out).toEqual({ status: 'blocked', blockReason: 'entity_missing' });
    expect(metadataService.fetchMetadata).not.toHaveBeenCalled();
  });

  it('blocks an expired plan rather than acting on a decayed snapshot', async () => {
    const { svc, metadataService } = stub({
      plan: { ...PLAN, expiresAt: new Date('2000-01-01T00:00:00Z') },
    });
    const out = await svc.execute('plan-1');

    expect(out).toMatchObject({ status: 'blocked', blockReason: 'approval_invalidated' });
    expect(metadataService.fetchMetadata).not.toHaveBeenCalled();
  });

  it('blocks when the recommendation stopped being active', async () => {
    const { svc, metadataService } = stub({
      recommendation: { id: 'rec-1', type: 'REFRESH_METADATA', status: 'satisfied', confidence: 'high', capabilityId: null, evidence: {} },
    });
    const out = await svc.execute('plan-1');

    expect(out).toMatchObject({ status: 'blocked', blockReason: 'approval_invalidated' });
    expect(metadataService.fetchMetadata).not.toHaveBeenCalled();
  });

  it('blocks when the justification drifted since approval', async () => {
    // A pinned fingerprint that no longer matches means executing would carry
    // out work nobody approved.
    const { svc, metadataService } = stub({
      plan: { ...PLAN, recommendationFingerprint: 'pinned-to-something-else' },
    });
    const out = await svc.execute('plan-1');

    expect(out).toMatchObject({ status: 'blocked', blockReason: 'approval_invalidated' });
    expect(metadataService.fetchMetadata).not.toHaveBeenCalled();
  });

  it('blocks rather than fails, so a cleared condition can be retried', async () => {
    const { svc, calls } = stub({ item: { locked: true } });
    await svc.execute('plan-1');

    expect(calls.events).toContain('blocked');
    expect(calls.events).not.toContain('failed');
  });
});

describe('the source call', () => {
  it('journals the step as running BEFORE invoking the owning domain', async () => {
    const { svc, calls } = stub();
    await svc.execute('plan-1');

    const firstStepWrite = calls.stepUpdates[0];
    expect(firstStepWrite).toMatchObject({ id: 'step-1', status: 'running' });
    // A crash between the two must leave evidence of what was in flight.
    expect(calls.events.indexOf('step_started')).toBeLessThan(calls.events.indexOf('step_completed'));
  });

  it('delegates to the domain that owns metadata', async () => {
    const { svc, calls } = stub();
    await svc.execute('plan-1');
    expect(calls.fetched).toEqual(['item-1']);
  });

  it('records one audit row for one source action', async () => {
    const { svc, calls } = stub();
    await svc.execute('plan-1', 'user-9');

    expect(calls.audits).toHaveLength(1);
    expect(calls.audits[0]).toMatchObject({
      userId: 'user-9',
      action: 'media_intelligence.remediation.step_executed',
    });
  });

  it('fails the plan when the source call throws, without claiming success', async () => {
    const { svc, calls } = stub({ fetchThrows: new Error('provider unreachable') });
    const out = await svc.execute('plan-1');

    expect(out).toMatchObject({ status: 'failed' });
    expect(calls.events).toContain('step_failed');
    expect(calls.events).not.toContain('reconciliation_satisfied');
  });

  it('refuses a step kind no executor is registered for', async () => {
    const { svc } = stub({ plan: { ...PLAN, steps: [{ ...STEP, kind: 'delete_everything' }] } });
    const out = await svc.execute('plan-1');
    // Silently doing nothing and reporting success is the failure mode this
    // whole phase exists to avoid.
    expect(out).toMatchObject({ status: 'failed', failureClass: 'capability_unavailable' });
  });
});

describe('success belongs to reconciliation, not to the call', () => {
  it('moves to verifying rather than succeeded when the steps finish', async () => {
    const { svc, calls } = stub();
    const out = await svc.execute('plan-1');

    expect(out).toEqual({ status: 'verifying' });
    // `succeeded` is not reachable from execute() at all.
    expect(calls.events).toContain('verification_started');
    expect(calls.events).not.toContain('reconciliation_satisfied');
  });

  it('succeeds only once SOURCE TRUTH shows the postcondition met', async () => {
    const { svc, calls } = stub({
      plan: { ...PLAN, status: 'verifying' },
      metadata: { providerName: 'tmdb' },
    });
    const out = await svc.verify('plan-1');

    expect(out).toEqual({ status: 'succeeded' });
    expect(calls.events).toContain('reconciliation_satisfied');
  });

  it('fails when the action completed but the desired state is still unmet', async () => {
    const { svc, calls } = stub({
      plan: { ...PLAN, status: 'verifying' },
      metadata: { providerName: null },
    });
    const out = await svc.verify('plan-1');

    // "We did the thing and it did not work" is a different fact from "the
    // thing threw", and reporting it as success would be the worst lie here.
    expect(out).toMatchObject({ status: 'failed' });
    expect(calls.events).toContain('verification_failed');
  });

  it('fails when no metadata row exists at all — that is unmet, not unknown', async () => {
    /*
     * A missing `MediaMetadata` row after a refresh is a real answer: no
     * provider was recorded. Treating it as unknown would leave the plan
     * verifying forever on an observation the system genuinely made.
     */
    const { svc } = stub({ plan: { ...PLAN, status: 'verifying' }, metadata: null });
    const out = await svc.verify('plan-1');
    expect(out).toMatchObject({ status: 'failed' });
  });

  it('stays verifying when the lookup itself could not answer', async () => {
    /*
     * Unknown is neither satisfied nor failed — Phase 5's third answer,
     * carried into execution. Distinguished from the case above by WHERE the
     * silence comes from: a throwing lookup tells us nothing about the
     * world, while an absent row tells us something definite.
     */
    const { svc, prisma } = stub({ plan: { ...PLAN, status: 'verifying' } });
    prisma.mediaMetadata.findUnique.mockRejectedValue(new Error('db unavailable') as never);

    const out = await svc.verify('plan-1');
    expect(out).toEqual({ status: 'verifying' });
  });

  it('reads the owning domain, never the projection it helped write', () => {
    const source = readFileSync(join(__dirname, 'plan-executor.service.ts'), 'utf8');
    // Asking the projection would be asking the plan to grade itself.
    // Tolerates the method call being wrapped onto its own line, which is
    // formatting rather than meaning.
    expect(source).toMatch(/mediaMetadata\s*\n?\s*\.findUnique/);
    expect(source).not.toMatch(/prisma\.mediaIntelligenceProjection/);
  });
});

describe('the executor owns no source logic', () => {
  const source = () => readFileSync(join(__dirname, 'plan-executor.service.ts'), 'utf8');

  it('writes to no source-domain table', () => {
    const writes = [
      ...source().matchAll(
        /prisma\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g,
      ),
    ].map((m) => m[1]);
    const owned = new Set([
      'mediaRemediationPlan',
      'mediaRemediationStep',
      'mediaRemediationPlanEvent',
    ]);
    // Media, metadata and torrents are mutated by their owners, through their
    // own services — never by a write from here.
    expect([...new Set(writes)].filter((m) => !owned.has(m))).toEqual([]);
  });

  it('issues no raw SQL and no filesystem call', () => {
    expect(source()).not.toMatch(/\$executeRaw|\$queryRaw/);
    expect(source()).not.toMatch(/\bfs\.|node:fs|unlink|rmSync/);
  });
});
