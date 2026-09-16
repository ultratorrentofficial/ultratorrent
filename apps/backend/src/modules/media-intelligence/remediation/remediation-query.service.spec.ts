import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RemediationQueryService } from './remediation-query.service';

/**
 * The read side of the remediation queue.
 *
 * Two claims carry real weight here. The DTO is assembled field by field, so
 * the pinned fingerprints — internal machinery an operator cannot act on —
 * never reach a browser. And `blockSurvivesApproval` is computed on the
 * SERVER, because it decides whether an Approve button should exist at all:
 * a client that worked it out for itself would eventually offer one the
 * server refuses.
 */

type Row = Record<string, unknown>;

const STEP = {
  id: 'step-1',
  ordinal: 0,
  kind: 'refresh_metadata',
  ownerDomain: 'media_manager',
  capabilityId: 'media.metadata.refresh',
  requiredPermission: 'media_manager.edit_metadata',
  status: 'pending',
  inputSnapshot: { itemId: 'item-1' },
  expectedPostcondition: { metadataProviderPresent: true },
  attemptCount: 0,
  failureClass: null,
  failureMessage: null,
  skipReason: null,
  startedAt: null,
  completedAt: null,
};

const PLAN = {
  id: 'plan-1',
  entityType: 'movie',
  entityId: 'item-1',
  findingId: 'find-1',
  recommendationId: 'rec-1',
  policyId: null,
  type: 'REFRESH_METADATA',
  status: 'proposed',
  riskClass: 'low',
  blockReason: null,
  explanation: { intent: 'metadata_provider_present' },
  approvedById: null,
  approvedAt: null,
  approvedFingerprint: null,
  recommendationFingerprint: 'fp-abc',
  desiredStateFingerprint: 'fp-desired',
  verificationFingerprint: null,
  expiresAt: new Date('2099-01-01T00:00:00Z'),
  startedAt: null,
  completedAt: null,
  supersededAt: null,
  supersededReason: null,
  failureClass: null,
  failureMessage: null,
  createdAt: new Date('2026-09-16T00:00:00Z'),
  updatedAt: new Date('2026-09-16T00:00:00Z'),
  steps: [STEP],
};

function stub(opts: { plans?: Row[]; projections?: Row[]; grouped?: Row[] } = {}) {
  const prisma = {
    mediaRemediationPlan: {
      // Typed with its argument so a test may assert on the args it received.
      // An arg-less mock narrows `mock.calls` to an empty tuple, and indexing
      // it is a compile error rather than a runtime surprise.
      findMany: jest.fn(async (_args: Row) => opts.plans ?? [PLAN]),
      findUnique: jest.fn(async () => (opts.plans?.[0] ?? PLAN)),
      count: jest.fn(async () => (opts.plans ?? [PLAN]).length),
      groupBy: jest.fn(async () => opts.grouped ?? []),
    },
    mediaIntelligenceProjection: {
      findMany: jest.fn(async (_args: Row) =>
        opts.projections ?? [{ entityType: 'movie', entityId: 'item-1', title: 'Heat', year: 1995 }],
      ),
    },
  };
  return { svc: new RemediationQueryService(prisma as never), prisma };
}

describe('the DTO is deliberate, not the raw row', () => {
  it('never leaks the pinned fingerprints to a browser', async () => {
    const { svc } = stub();
    const page = await svc.list({});
    const serialized = JSON.stringify(page.items[0]);

    // Internal machinery: an operator cannot act on a hash, and the approval
    // pin in particular is what the executor compares against.
    expect(serialized).not.toContain('fp-abc');
    expect(serialized).not.toContain('fp-desired');
    expect(serialized).not.toMatch(/Fingerprint/);
  });

  it('carries the title from the projection, for rendering only', async () => {
    const { svc } = stub();
    const page = await svc.list({});
    expect(page.items[0]).toMatchObject({ title: 'Heat', year: 1995 });
  });

  it('renders a plan whose entity has no projection row rather than dropping it', async () => {
    // A plan outlives its inputs; a missing title must not hide the plan.
    const { svc } = stub({ projections: [] });
    const page = await svc.list({});
    expect(page.items[0].title).toBeNull();
    expect(page.total).toBe(1);
  });

  it('exposes each step with its owning domain and required permission', async () => {
    const { svc } = stub();
    const step = (await svc.list({})).items[0].steps[0];
    expect(step).toMatchObject({
      ownerDomain: 'media_manager',
      capabilityId: 'media.metadata.refresh',
      requiredPermission: 'media_manager.edit_metadata',
    });
  });
});

describe('blockSurvivesApproval is decided on the server', () => {
  it('is true for a blocker no signature can clear', async () => {
    const { svc } = stub({ plans: [{ ...PLAN, blockReason: 'quality_not_measured' }] });
    const plan = (await svc.list({})).items[0];
    // The UI reads this to decide whether an Approve button should exist.
    expect(plan.blockSurvivesApproval).toBe(true);
  });

  it('is false for a blocker that clears on its own', async () => {
    const { svc } = stub({ plans: [{ ...PLAN, blockReason: 'budget_exhausted' }] });
    expect((await svc.list({})).items[0].blockSurvivesApproval).toBe(false);
  });

  it('is false when nothing blocks the plan', async () => {
    const { svc } = stub();
    expect((await svc.list({})).items[0].blockSurvivesApproval).toBe(false);
  });
});

describe('the queue defaults to what still needs deciding', () => {
  it('excludes decided plans unless asked for explicitly', async () => {
    const { svc, prisma } = stub();
    await svc.list({});

    const where = (prisma.mediaRemediationPlan.findMany.mock.calls[0][0] as { where: Row }).where;
    // History does not belong in a queue of things to decide — but stays
    // readable by asking for it.
    expect((where.status as { notIn: string[] }).notIn).toEqual(
      expect.arrayContaining(['succeeded', 'failed', 'cancelled', 'superseded']),
    );
  });

  it('honours an explicit status filter', async () => {
    const { svc, prisma } = stub();
    await svc.list({ status: 'succeeded' });
    const where = (prisma.mediaRemediationPlan.findMany.mock.calls[0][0] as { where: Row }).where;
    expect(where.status).toBe('succeeded');
  });

  it('returns an empty page when a title search matches nothing', async () => {
    // Not an unfiltered page: silently widening a search is how an operator
    // acts on the wrong row.
    const { svc, prisma } = stub({ projections: [] });
    const page = await svc.list({ q: 'nothing matches this' });

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(prisma.mediaRemediationPlan.findMany).not.toHaveBeenCalled();
  });
});

describe('reading starts nothing', () => {
  it('contains no write call anywhere in its source', () => {
    /*
     * Structural, over the source — the same form the plan service and the
     * executor use. A behavioural version could only prove the paths a test
     * happens to exercise, and asserting the shape of a stub written in this
     * file would prove nothing at all, since fixture and assertion move
     * together.
     */
    const source = readFileSync(join(__dirname, 'remediation-query.service.ts'), 'utf8');
    const writes = [
      ...source.matchAll(
        /prisma\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g,
      ),
    ].map((m) => m[1]);

    // Opening a queue must never claim, execute or reconcile anything.
    expect(writes).toEqual([]);
    expect(source).not.toMatch(/\$executeRaw|\$queryRaw/);
  });

  it('reads without starting work', async () => {
    const { svc } = stub();
    await svc.list({});
    await svc.summary();
    await svc.detail('plan-1');
    // No throw: every delegate the read paths touch is a read delegate.
  });

  it('counts every status bucket from one grouped query', async () => {
    const { svc } = stub({
      grouped: [
        { status: 'proposed', _count: { _all: 3 } },
        { status: 'approved', _count: { _all: 1 } },
        { status: 'blocked', _count: { _all: 2 } },
      ],
    });
    const summary = await svc.summary();

    expect(summary).toMatchObject({ awaitingApproval: 3, approved: 1, blocked: 2 });
  });
});
