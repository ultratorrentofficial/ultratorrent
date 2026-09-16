import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MEDIA_RECOMMENDATION_TYPES as T } from '@ultratorrent/shared';

import { RemediationPlanService } from './remediation-plan.service';

/**
 * Persisting and reconciling plans.
 *
 * The claims worth pinning are the ones a later refactor would quietly
 * break: that a sweep never touches work already in flight, that nothing is
 * ever deleted, that an approval cannot survive its justification changing,
 * and that history records transitions rather than observations.
 */

type Row = Record<string, unknown>;

const NOW = new Date('2026-09-16T12:00:00Z');

function stub(opts: { recommendations?: Row[]; plans?: Row[]; item?: Row | null } = {}) {
  const calls = {
    created: [] as Row[],
    updated: [] as Row[],
    history: [] as Row[],
    deleted: 0,
  };

  const prisma = {
    mediaIntelligenceRecommendation: {
      findMany: jest.fn(async () => opts.recommendations ?? []),
    },
    mediaRemediationPlan: {
      findMany: jest.fn(async () => opts.plans ?? []),
      create: jest.fn(async (args: { data: Row }) => {
        calls.created.push(args.data);
        return { id: 'plan-new' };
      }),
      update: jest.fn(async (args: { where: Row; data: Row }) => {
        calls.updated.push({ ...args.where, ...args.data });
        return {};
      }),
      // Present so a stray delete would be caught rather than throwing an
      // unhelpful "not a function".
      delete: jest.fn(async () => {
        calls.deleted += 1;
        return {};
      }),
      deleteMany: jest.fn(async () => {
        calls.deleted += 1;
        return { count: 0 };
      }),
    },
    mediaRemediationPlanEvent: {
      createMany: jest.fn(async (args: { data: Row[] }) => {
        calls.history.push(...args.data);
        return { count: args.data.length };
      }),
    },
    mediaItem: {
      findUnique: jest.fn(async () => (opts.item === undefined ? { locked: false } : opts.item)),
    },
  };

  return { svc: new RemediationPlanService(prisma as never), prisma, calls };
}

const rec = (over: Row = {}): Row => ({
  id: 'rec-1',
  findingId: 'find-1',
  type: T.REFRESH_METADATA,
  status: 'active',
  evidence: { provider: null },
  confidence: 'high',
  capabilityId: 'media.metadata.refresh',
  ...over,
});

const plan = (over: Row = {}): Row => ({
  id: 'plan-1',
  recommendationId: 'rec-1',
  status: 'proposed',
  blockReason: null,
  desiredStateFingerprint: null,
  recommendationFingerprint: null,
  verificationFingerprint: null,
  approvedFingerprint: null,
  ...over,
});

describe('creating plans', () => {
  it('creates a plan for an active, supported recommendation', async () => {
    const { svc, calls } = stub({ recommendations: [rec()] });
    await svc.reconcile('movie', 'item-1', NOW);

    expect(calls.created).toHaveLength(1);
    expect(calls.created[0]).toMatchObject({
      entityType: 'movie',
      entityId: 'item-1',
      recommendationId: 'rec-1',
      type: T.REFRESH_METADATA,
      // Nothing is asked of anyone until a person opens the queue.
      status: 'proposed',
    });
  });

  it('creates the plan and its steps together', async () => {
    const { svc, calls } = stub({ recommendations: [rec()] });
    await svc.reconcile('movie', 'item-1', NOW);

    const steps = (calls.created[0].steps as { create: Row[] }).create;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'refresh_metadata', ownerDomain: 'media_manager' });
  });

  it('creates nothing for a recommendation the classification refuses', async () => {
    const { svc, calls } = stub({ recommendations: [rec({ type: T.SEARCH_SUBTITLES })] });
    await svc.reconcile('movie', 'item-1', NOW);
    expect(calls.created).toHaveLength(0);
  });

  it('records a blocked plan rather than skipping it, so the reason is visible', async () => {
    const { svc, calls } = stub({ recommendations: [rec()], item: { locked: true } });
    await svc.reconcile('movie', 'item-1', NOW);

    expect(calls.created[0]).toMatchObject({ blockReason: 'item_locked' });
    // A blocked plan carries no steps: nothing should look queued.
    expect((calls.created[0].steps as { create: Row[] }).create).toEqual([]);
  });

  it('blocks when the entity has vanished', async () => {
    const { svc, calls } = stub({ recommendations: [rec()], item: null });
    await svc.reconcile('movie', 'item-1', NOW);
    expect(calls.created[0]).toMatchObject({ blockReason: 'entity_missing' });
  });
});

describe('work already in flight belongs to the executor', () => {
  it.each(['executing', 'waiting', 'verifying'])(
    'leaves a %s plan completely untouched',
    async (status) => {
      const { svc, calls } = stub({
        recommendations: [rec()],
        plans: [plan({ status, recommendationFingerprint: 'stale' })],
      });
      await svc.reconcile('movie', 'item-1', NOW);

      // Rewriting it would change what a running step believes it is doing.
      expect(calls.updated).toHaveLength(0);
      expect(calls.created).toHaveLength(0);
    },
  );

  it('does not supersede an in-flight plan whose recommendation vanished', async () => {
    const { svc, calls } = stub({
      recommendations: [],
      plans: [plan({ status: 'executing' })],
    });
    await svc.reconcile('movie', 'item-1', NOW);
    expect(calls.updated).toHaveLength(0);
  });
});

describe('nothing is ever deleted', () => {
  it('supersedes a plan whose recommendation resolved, with the reason', async () => {
    const { svc, calls } = stub({
      recommendations: [rec({ status: 'satisfied' })],
      plans: [plan()],
    });
    await svc.reconcile('movie', 'item-1', NOW);

    expect(calls.deleted).toBe(0);
    expect(calls.updated[0]).toMatchObject({
      id: 'plan-1',
      status: 'superseded',
      supersededReason: 'drift_resolved',
    });
  });

  it('distinguishes a withdrawn recommendation from a resolved one', async () => {
    // The recommendation row is gone entirely — a capability went away, or
    // the evidence stopped supporting a plan.
    const { svc, calls } = stub({ recommendations: [], plans: [plan()] });
    await svc.reconcile('movie', 'item-1', NOW);

    expect(calls.updated[0]).toMatchObject({ supersededReason: 'recommendation_withdrawn' });
  });
});

describe('an approval cannot outlive its justification', () => {
  it('invalidates approval when a pinned input drifted', async () => {
    const { svc, calls } = stub({
      recommendations: [rec()],
      plans: [
        plan({
          status: 'approved',
          recommendationFingerprint: 'no-longer-matches',
          approvedFingerprint: 'no-longer-matches',
        }),
      ],
    });
    await svc.reconcile('movie', 'item-1', NOW);

    const update = calls.updated[0];
    expect(update).toMatchObject({ approvedById: null, approvedAt: null, approvedFingerprint: null });
    expect(calls.history.some((h) => h.event === 'approval_invalidated')).toBe(true);
  });

  it('records drift on an unapproved plan without inventing an invalidation', async () => {
    const { svc, calls } = stub({
      recommendations: [rec()],
      plans: [plan({ recommendationFingerprint: 'no-longer-matches' })],
    });
    await svc.reconcile('movie', 'item-1', NOW);

    expect(calls.history.some((h) => h.event === 'inputs_changed')).toBe(true);
    expect(calls.history.some((h) => h.event === 'approval_invalidated')).toBe(false);
  });

  it('hashes confidence, so a weakened recommendation is material', async () => {
    /*
     * The placeholder this replaced would have hashed every recommendation
     * identically on these fields — a confidence collapse from high to low
     * would have passed as "unchanged" and kept an approval alive.
     */
    const { svc, calls } = stub({ recommendations: [rec()] });
    await svc.reconcile('movie', 'item-1', NOW);
    const first = calls.created[0].recommendationFingerprint;

    const weaker = stub({ recommendations: [rec({ confidence: 'low' })] });
    await weaker.svc.reconcile('movie', 'item-1', NOW);
    expect(weaker.calls.created[0].recommendationFingerprint).not.toBe(first);
  });
});

describe('history records transitions, not observations', () => {
  it('writes nothing when a steady-state sweep changed nothing', async () => {
    const { svc, calls, prisma } = stub({ recommendations: [], plans: [] });
    await svc.reconcile('movie', 'item-1', NOW);

    expect(prisma.mediaRemediationPlanEvent.createMany).not.toHaveBeenCalled();
    expect(calls.history).toEqual([]);
  });

  it('batches every transition into one write', async () => {
    const { svc, prisma } = stub({
      recommendations: [rec(), rec({ id: 'rec-2', findingId: 'find-2' })],
    });
    await svc.reconcile('movie', 'item-1', NOW);

    // Two creations, one createMany.
    expect(prisma.mediaRemediationPlanEvent.createMany).toHaveBeenCalledTimes(1);
  });
});

describe('the sweep touches nothing it does not own', () => {
  /*
   * Structural, over the SOURCE.
   *
   * A behavioural version of this claim can only prove the paths a test
   * happens to exercise — and asserting the shape of a stub written in this
   * same file proves nothing at all, since the fixture and the assertion
   * would move together. Anchored on the prisma call itself, so `Set.delete`
   * is not mistaken for a database write: a check that cannot tell them
   * apart is one someone eventually disables.
   */
  const source = () =>
    readFileSync(join(__dirname, 'remediation-plan.service.ts'), 'utf8');

  it('writes only to the plan tables it owns', () => {
    const writes = [
      ...source().matchAll(
        /prisma\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g,
      ),
    ].map((m) => m[1]);

    // Findings, recommendations and the projection are settled by other
    // passes. A failure here must never be able to corrupt finding truth or
    // an operator's disposition.
    const owned = new Set(['mediaRemediationPlan', 'mediaRemediationPlanEvent']);
    expect([...new Set(writes)].filter((m) => !owned.has(m))).toEqual([]);
  });

  it('issues no raw SQL', () => {
    expect(source()).not.toMatch(/\$executeRaw|\$queryRaw/);
  });

  it('never deletes a plan — obsolete work is superseded', () => {
    // A plan records what UltraTorrent intended and did. Deleting one erases
    // the answer to "why did this happen".
    expect(source()).not.toMatch(/mediaRemediationPlan\.delete(Many)?\b/);
  });
});
