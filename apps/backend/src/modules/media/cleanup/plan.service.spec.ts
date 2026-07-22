import {
  BadRequestException, ForbiddenException, NotFoundException, UnprocessableEntityException,
} from '@nestjs/common';
import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { PlanService } from './plan.service';

/**
 * A plan is the only object an execution may act on, so what is tested here is
 * everything that decides whether one may exist and whether it may be approved.
 */

const approver = {
  id: 'u-approver', username: 'approver', roles: [SystemRole.ADMINISTRATOR],
  permissions: [PERMISSIONS.LIBRARY_CLEANUP_APPROVE, PERMISSIONS.LIBRARY_CLEANUP_TRASH],
} as never;

const document = {
  schemaVersion: 1,
  scope: {},
  conditions: { type: 'all', children: [] },
  exclusions: { protected: true, locked: true, activePlayback: true, incompleteDownload: true, inFlightOperation: true },
  action: { mode: 'approval_required', destination: 'trash', retentionDays: 30 },
};

const candidate = (id: string, over: Record<string, unknown> = {}) => ({
  id, runId: 'r1', status: 'candidate', path: `/media/Movies/${id}/a.mkv`,
  mediaItemId: `${id}-item`, mediaFileId: `${id}-file`, mediaLibraryId: 'lib1',
  fingerprint: `fp-${id}`, fileSizeBytes: 1024n, estimatedReclaimBytes: 1024n,
  ...over,
});

function makeService(over: {
  run?: Record<string, unknown> | null;
  version?: Record<string, unknown> | null;
  candidates?: Array<Record<string, unknown>>;
  plan?: Record<string, unknown> | null;
  openActions?: Array<Record<string, unknown>>;
  pendingActions?: Array<Record<string, unknown>>;
  protectedPaths?: string[];
  legalHoldPaths?: string[];
  pendingCount?: number;
} = {}) {
  const planUpdates: Record<string, unknown>[] = [];
  const actionUpdates: Record<string, unknown>[] = [];
  let created: Record<string, unknown> | null = null;
  let createdActions: Array<Record<string, unknown>> = [];
  let planRow: Record<string, unknown> | null =
    over.plan === undefined
      ? { id: 'p1', status: 'pending_approval', action: 'trash', createdById: 'u-other',
          expiresAt: new Date('2099-01-01T00:00:00Z'), runId: 'r1', candidateCount: 2 }
      : over.plan;

  const protectedSet = new Set(over.protectedPaths ?? []);
  const holdSet = new Set(over.legalHoldPaths ?? []);

  const prisma: Record<string, any> = {
    mediaCleanupRun: {
      findUnique: jest.fn(async () =>
        over.run === undefined ? { id: 'r1', status: 'completed', simulate: false, policyVersionId: 'v1' } : over.run),
    },
    mediaCleanupPolicyVersion: {
      findUnique: jest.fn(async () => over.version === undefined ? { id: 'v1', document } : over.version),
    },
    mediaCleanupCandidate: {
      findMany: jest.fn(async () => over.candidates ?? [candidate('c1'), candidate('c2')]),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    mediaCleanupAction: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.candidateId ? (over.openActions ?? []) : (over.pendingActions ?? [])),
      createMany: jest.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        createdActions = data; return { count: data.length };
      }),
      count: jest.fn(async () => over.pendingCount ?? 2),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        actionUpdates.push(data); return data;
      }),
      groupBy: jest.fn(async () => [{ status: 'pending', _count: { _all: 2 } }]),
    },
    mediaCleanupPlan: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created = { id: 'p-new', ...data }; return created;
      }),
      findUnique: jest.fn(async () => planRow),
      findMany: jest.fn(async () => []),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        planUpdates.push(data);
        planRow = { ...(planRow ?? {}), ...data };
        return planRow;
      }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };

  const audit = { record: jest.fn(async (_e: { action: string }) => undefined) };
  const protections = {
    evaluate: jest.fn(async ({ path }: { path: string }) => ({
      isProtected: protectedSet.has(path) || holdSet.has(path),
      hasLegalHold: holdSet.has(path),
      matches: [],
    })),
  };
  const eventBus = { emit: jest.fn() };

  const service = new PlanService(prisma as never, audit as never, protections as never, eventBus as never);
  return {
    service, prisma, audit, eventBus, planUpdates, actionUpdates,
    get created() { return created; },
    get createdActions() { return createdActions; },
    get planRow() { return planRow; },
  };
}

describe('createPlan — what may become a plan at all', () => {
  it('builds a plan from candidate ids and pins each fingerprint', async () => {
    const h = makeService();
    const plan = await h.service.createPlan('r1', { candidateIds: ['c1', 'c2'] }, approver);
    expect(plan.status).toBe('pending_approval');
    expect(plan.candidateCount).toBe(2);
    expect(h.createdActions.map((a) => a.pinnedFingerprint)).toEqual(['fp-c1', 'fp-c2']);
    // Paths come from the run's own snapshot, never from the request.
    expect(h.createdActions.map((a) => a.sourcePath)).toEqual([
      '/media/Movies/c1/a.mkv', '/media/Movies/c2/a.mkv',
    ]);
  });

  // Planning from a simulation would turn "what would happen" into "what will".
  it('refuses to plan from a simulation', async () => {
    const h = makeService({ run: { id: 'r1', status: 'completed', simulate: true, policyVersionId: 'v1' } });
    await expect(h.service.createPlan('r1', { candidateIds: ['c1'] }, approver))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to plan from a run that has not finished', async () => {
    const h = makeService({ run: { id: 'r1', status: 'running', simulate: false, policyVersionId: 'v1' } });
    await expect(h.service.createPlan('r1', { candidateIds: ['c1'] }, approver))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a report-only policy', async () => {
    const h = makeService({
      version: { id: 'v1', document: { ...document, action: { mode: 'report_only', destination: 'trash' } } },
    });
    await expect(h.service.createPlan('r1', { candidateIds: ['c1'] }, approver))
      .rejects.toThrow(/report-only/);
  });

  it('404s on an unknown run', async () => {
    const h = makeService({ run: null });
    await expect(h.service.createPlan('nope', { candidateIds: ['c1'] }, approver))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses candidate ids that belong to another run', async () => {
    const h = makeService({ candidates: [candidate('c1')] });
    await expect(h.service.createPlan('r1', { candidateIds: ['c1', 'c-elsewhere'] }, approver))
      .rejects.toThrow(/do not belong to this run/);
  });

  it('refuses a candidate that was already excluded', async () => {
    const h = makeService({ candidates: [candidate('c1', { status: 'excluded_protected' })] });
    await expect(h.service.createPlan('r1', { candidateIds: ['c1'] }, approver))
      .rejects.toThrow(/not actionable/);
  });

  // Two plans over one file would each believe they may remove it.
  it('refuses a candidate already held by an open plan', async () => {
    const h = makeService({ openActions: [{ candidateId: 'c1', planId: 'p-open' }] });
    await expect(h.service.createPlan('r1', { candidateIds: ['c1', 'c2'] }, approver))
      .rejects.toThrow(/already in an open plan/);
  });
});

describe('createPlan — the destination cannot be escalated', () => {
  it('accepts a downgrade to quarantine', async () => {
    const h = makeService();
    const plan = await h.service.createPlan('r1', { candidateIds: ['c1'], destination: 'quarantine' }, approver);
    expect(plan.action).toBe('quarantine');
  });

  it('refuses an escalation past the policy', async () => {
    const h = makeService({
      version: { id: 'v1', document: { ...document, action: { mode: 'approval_required', destination: 'quarantine' } } },
    });
    await expect(h.service.createPlan('r1', { candidateIds: ['c1'], destination: 'trash' }, approver))
      .rejects.toThrow(/Cannot escalate/);
  });
});

describe('createPlan — protection is re-checked before anything is planned', () => {
  it('records a newly protected candidate as skipped rather than dropping it', async () => {
    const h = makeService({ protectedPaths: ['/media/Movies/c1/a.mkv'] });
    const plan = await h.service.createPlan('r1', { candidateIds: ['c1', 'c2'] }, approver);
    // The plan shows the whole intent, including what was refused and why.
    expect(h.createdActions).toHaveLength(2);
    expect(h.createdActions[0]).toMatchObject({ status: 'skipped', skipReason: 'protected' });
    expect(h.createdActions[1]).toMatchObject({ status: 'pending' });
    expect(plan.candidateCount).toBe(1);
    expect(plan.skippedProtected).toBe(1);
  });

  it('refuses outright when everything selected is now protected', async () => {
    const h = makeService({ protectedPaths: ['/media/Movies/c1/a.mkv', '/media/Movies/c2/a.mkv'] });
    await expect(h.service.createPlan('r1', { candidateIds: ['c1', 'c2'] }, approver))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe('createPlan — the policy caps bind the plan', () => {
  it('refuses more files than the policy allows per run', async () => {
    const h = makeService({
      version: { id: 'v1', document: { ...document, action: { ...document.action, maxItemsPerRun: 1 } } },
    });
    await expect(h.service.createPlan('r1', { candidateIds: ['c1', 'c2'] }, approver))
      .rejects.toThrow(/caps a run at 1/);
  });

  it('refuses more bytes than the policy allows per run', async () => {
    const h = makeService({
      version: { id: 'v1', document: { ...document, action: { ...document.action, maxReclaimBytesPerRun: 100 } } },
    });
    await expect(h.service.createPlan('r1', { candidateIds: ['c1', 'c2'] }, approver))
      .rejects.toThrow(/caps a run at 100/);
  });
});

describe('approve', () => {
  it('approves and records who did it', async () => {
    const h = makeService();
    const plan = await h.service.approve('p1', approver);
    expect(plan.status).toBe('approved');
    expect(h.planUpdates.at(-1)).toMatchObject({ status: 'approved', approvedById: 'u-approver' });
    expect(h.eventBus.emit).toHaveBeenCalled();
  });

  // Most installs have one operator; a workflow nobody can complete is worse than
  // one recorded honestly. It gets its own audit action so a reviewer can find it.
  it('permits self-approval but audits it distinctly', async () => {
    const h = makeService({
      plan: { id: 'p1', status: 'pending_approval', action: 'trash', createdById: 'u-approver',
              expiresAt: new Date('2099-01-01T00:00:00Z'), runId: 'r1', candidateCount: 2 },
    });
    await h.service.approve('p1', approver);
    const actions = h.audit.record.mock.calls.map((c) => c[0].action);
    expect(actions).toContain('library_cleanup.plan.self_approved');
    expect(actions).not.toContain('library_cleanup.plan.approved');
  });

  it('refuses a permanent delete to an approver who only holds trash', async () => {
    const h = makeService({
      plan: { id: 'p1', status: 'pending_approval', action: 'permanent_delete', createdById: 'u-other',
              expiresAt: new Date('2099-01-01T00:00:00Z'), runId: 'r1', candidateCount: 1 },
    });
    await expect(h.service.approve('p1', approver)).rejects.toBeInstanceOf(ForbiddenException);
    // A refusal is itself auditable.
    const actions = h.audit.record.mock.calls.map((c) => c[0].action);
    expect(actions).toContain('library_cleanup.plan.approve_refused');
  });

  it('refuses an expired plan without waiting for the sweep', async () => {
    const h = makeService({
      plan: { id: 'p1', status: 'pending_approval', action: 'trash', createdById: 'u-other',
              expiresAt: new Date('2020-01-01T00:00:00Z'), runId: 'r1', candidateCount: 1 },
    });
    await expect(h.service.approve('p1', approver)).rejects.toThrow(/expired/);
  });

  it('refuses to approve twice', async () => {
    const h = makeService({
      plan: { id: 'p1', status: 'approved', action: 'trash', createdById: 'u-other',
              expiresAt: new Date('2099-01-01T00:00:00Z'), runId: 'r1', candidateCount: 1 },
    });
    await expect(h.service.approve('p1', approver)).rejects.toBeInstanceOf(BadRequestException);
  });

  // A plan may have waited days. What became protected must not ride into execution.
  it('skips anything protected since the plan was built', async () => {
    const h = makeService({
      pendingActions: [{ id: 'a1', mediaItemId: 'i1', mediaFileId: 'f1', sourcePath: '/media/Movies/c1/a.mkv' }],
      legalHoldPaths: ['/media/Movies/c1/a.mkv'],
      pendingCount: 1,
    });
    const plan = await h.service.approve('p1', approver);
    expect(h.actionUpdates).toContainEqual({ status: 'skipped', skipReason: 'legal_hold' });
    expect(plan.newlyProtected).toBe(1);
  });

  it('refuses when nothing is left to act on', async () => {
    const h = makeService({ pendingCount: 0 });
    await expect(h.service.approve('p1', approver)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe('reject and cancel', () => {
  it('rejects with the reason recorded', async () => {
    const h = makeService();
    const plan = await h.service.reject('p1', { reason: 'wrong season pack' }, approver);
    expect(plan.status).toBe('rejected');
    expect(h.planUpdates.at(-1)).toMatchObject({ rejectionReason: 'wrong season pack' });
  });

  it('cannot reject an already-approved plan', async () => {
    const h = makeService({
      plan: { id: 'p1', status: 'approved', action: 'trash', createdById: 'u1',
              expiresAt: new Date('2099-01-01T00:00:00Z'), runId: 'r1', candidateCount: 1 },
    });
    await expect(h.service.reject('p1', { reason: 'no' }, approver)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cancels an approved plan that has not executed', async () => {
    const h = makeService({
      plan: { id: 'p1', status: 'approved', action: 'trash', createdById: 'u1',
              expiresAt: new Date('2099-01-01T00:00:00Z'), runId: 'r1', candidateCount: 1 },
    });
    const plan = await h.service.cancel('p1', { reason: 'changed my mind' }, approver);
    expect(plan.status).toBe('cancelled');
  });

  it('cannot cancel a plan that already executed', async () => {
    const h = makeService({
      plan: { id: 'p1', status: 'completed', action: 'trash', createdById: 'u1',
              expiresAt: new Date('2099-01-01T00:00:00Z'), runId: 'r1', candidateCount: 1 },
    });
    await expect(h.service.cancel('p1', {}, approver)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('expiry sweep', () => {
  it('expires a plan whose snapshot is too old, approved or not', async () => {
    const h = makeService({ plan: { id: 'p1', status: 'approved' } });
    h.prisma.mediaCleanupPlan.findMany.mockResolvedValueOnce([
      { id: 'p1', status: 'approved', runId: 'r1', candidateCount: 3 },
    ] as never);
    await h.service.sweepExpiry();
    expect(h.planUpdates.at(-1)).toMatchObject({ status: 'expired' });
  });

  it('never throws out of the scheduler', async () => {
    const h = makeService();
    h.prisma.mediaCleanupPlan.findMany.mockRejectedValueOnce(new Error('db gone'));
    await expect(h.service.sweepExpiry()).resolves.toBeUndefined();
  });
});
