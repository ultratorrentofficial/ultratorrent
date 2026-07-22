import { BadRequestException } from '@nestjs/common';
import { PlanExecutorService } from './plan-executor.service';

/**
 * This is the only code in the subsystem that touches the filesystem, so what is
 * tested here is exclusively what stops it: every one of the five checks that run
 * immediately before a file is removed, and the guarantee that a failed check
 * SKIPS rather than proceeds.
 */

jest.mock('../../files/file-fs.util', () => ({
  pathExists: jest.fn(async () => true),
  statSafe: jest.fn(async () => ({ size: 2048, isDirectory: () => false })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fsUtil = require('../../files/file-fs.util') as {
  pathExists: jest.Mock; statSafe: jest.Mock;
};

const user = { id: 'u1', username: 'op', roles: [], permissions: [] } as never;

const ACTION = {
  id: 'a1', candidateId: 'c1', sourcePath: '/media/Movies/Film/film.mkv',
  pinnedFingerprint: 'fp-approved', actionType: 'trash',
  mediaItemId: 'i1', mediaFileId: 'f1', fileSizeBytes: 2048n, status: 'pending',
};

function makeService(over: {
  plan?: Record<string, unknown> | null;
  actions?: Array<Record<string, unknown>>;
  isProtected?: boolean;
  hasLegalHold?: boolean;
  locked?: boolean;
  activeJobs?: number;
  fingerprintNow?: string | null;
  exists?: boolean;
  withinRoots?: boolean;
  removeThrows?: Error;
} = {}) {
  const actionUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const planUpdates: Record<string, unknown>[] = [];
  let planRow: Record<string, unknown> | null =
    over.plan === undefined
      ? { id: 'p1', status: 'approved', action: 'trash', runId: 'r1', policyVersionId: 'v1',
          retentionDays: 30, expiresAt: new Date('2099-01-01T00:00:00Z') }
      : over.plan;

  fsUtil.pathExists.mockImplementation(async () => over.exists ?? true);
  fsUtil.statSafe.mockImplementation(async () => ({ size: 2048, isDirectory: () => false }));

  const prisma = {
    mediaCleanupPlan: {
      findUnique: jest.fn(async () => planRow),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        planUpdates.push(data); planRow = { ...(planRow ?? {}), ...data }; return planRow;
      }),
    },
    mediaCleanupAction: {
      findMany: jest.fn(async () => over.actions ?? [ACTION]),
      findUnique: jest.fn(async () => ({ candidateId: 'c1' })),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        actionUpdates.push({ id: where.id, data }); return data;
      }),
    },
    mediaCleanupCandidate: { updateMany: jest.fn(async () => ({ count: 1 })) },
    mediaItem: { findUnique: jest.fn(async () => ({ locked: over.locked ?? false })) },
    platformJob: { count: jest.fn(async () => over.activeJobs ?? 0) },
  };

  const audit = { record: jest.fn(async () => undefined) };
  const protections = {
    evaluate: jest.fn(async () => ({
      isProtected: over.isProtected ?? false,
      hasLegalHold: over.hasLegalHold ?? false,
      matches: [],
    })),
  };
  const quarantine = {
    quarantine: jest.fn(async () => ({ id: 'q1', quarantinePath: '/media/.ultratorrent-quarantine/q1__film.mkv', bytes: 2048 })),
  };
  const discovery = {
    fingerprintNow: jest.fn(async () =>
      over.fingerprintNow === null ? null : { fingerprint: over.fingerprintNow ?? 'fp-approved', facts: {}, factKeys: [] }),
  };
  const files = {
    remove: jest.fn(async (_dto: { path: string; permanent?: boolean }, _ctx: unknown, _scope: string) => {
      if (over.removeThrows) throw over.removeThrows;
      return { operation: 'delete', ok: true, path: '/Movies/Film/film.mkv', bytes: 2048 };
    }),
  };
  const paths = {
    assertWithinHardRoots: jest.fn((p: string) => {
      if (over.withinRoots === false) throw new Error('outside');
      return p;
    }),
    storageSafety: {
      assertDeletable: jest.fn(),
      toRelative: jest.fn(() => '/Movies/Film/film.mkv'),
    },
  };
  const eventBus = { emit: jest.fn() };
  // The Jobs Center mirror is observability, never authority — see the bridge tests.
  const jobBridge = {
    startExecutionJob: jest.fn(async () => 'job-1'),
    finish: jest.fn(async () => undefined),
  };

  const service = new PlanExecutorService(
    prisma as never, audit as never, protections as never, quarantine as never,
    discovery as never, files as never, paths as never, jobBridge as never, eventBus as never,
  );
  return {
    service, prisma, audit, files, quarantine, protections, jobBridge, actionUpdates, planUpdates,
    get planRow() { return planRow; },
    skipReason() { return actionUpdates.find((u) => u.data.status === 'skipped')?.data.skipReason; },
  };
}

afterEach(() => jest.clearAllMocks());

describe('what may be executed at all', () => {
  it('executes an approved plan', async () => {
    const h = makeService();
    const result = await h.service.execute('p1', user);
    expect(result.completed).toBe(1);
    expect(h.files.remove).toHaveBeenCalled();
    expect(h.planRow!.status).toBe('completed');
  });

  it('refuses a plan nobody approved', async () => {
    const h = makeService({
      plan: { id: 'p1', status: 'pending_approval', action: 'trash', runId: 'r1', policyVersionId: 'v1',
              retentionDays: null, expiresAt: new Date('2099-01-01T00:00:00Z') },
    });
    await expect(h.service.execute('p1', user)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.files.remove).not.toHaveBeenCalled();
  });

  it('refuses to run the same plan twice', async () => {
    const h = makeService({
      plan: { id: 'p1', status: 'completed', action: 'trash', runId: 'r1', policyVersionId: 'v1',
              retentionDays: null, expiresAt: new Date('2099-01-01T00:00:00Z') },
    });
    await expect(h.service.execute('p1', user)).rejects.toBeInstanceOf(BadRequestException);
  });

  // A plan can expire between being approved and being run.
  it('expires a plan that timed out after approval, and touches nothing', async () => {
    const h = makeService({
      plan: { id: 'p1', status: 'approved', action: 'trash', runId: 'r1', policyVersionId: 'v1',
              retentionDays: null, expiresAt: new Date('2020-01-01T00:00:00Z') },
    });
    await expect(h.service.execute('p1', user)).rejects.toThrow(/expired/);
    expect(h.planRow!.status).toBe('expired');
    expect(h.files.remove).not.toHaveBeenCalled();
  });
});

describe('the five checks that run immediately before a file is touched', () => {
  it('1. skips a path that is no longer inside the storage roots', async () => {
    const h = makeService({ withinRoots: false });
    await h.service.execute('p1', user);
    expect(h.skipReason()).toBe('outside_roots');
    expect(h.files.remove).not.toHaveBeenCalled();
  });

  it('2. skips a file that vanished between approval and execution', async () => {
    const h = makeService({ exists: false });
    await h.service.execute('p1', user);
    expect(h.skipReason()).toBe('vanished');
    expect(h.files.remove).not.toHaveBeenCalled();
  });

  // The mandatory one: a protection placed after approval exists precisely to stop this.
  it('3. skips a file protected since approval', async () => {
    const h = makeService({ isProtected: true });
    await h.service.execute('p1', user);
    expect(h.skipReason()).toBe('protected');
    expect(h.files.remove).not.toHaveBeenCalled();
  });

  it('3b. reports a legal hold distinctly from ordinary protection', async () => {
    const h = makeService({ isProtected: true, hasLegalHold: true });
    await h.service.execute('p1', user);
    expect(h.skipReason()).toBe('legal_hold');
  });

  it('4. skips an item locked since approval', async () => {
    const h = makeService({ locked: true });
    await h.service.execute('p1', user);
    expect(h.skipReason()).toBe('locked');
    expect(h.files.remove).not.toHaveBeenCalled();
  });

  it('4b. skips an item with work in flight', async () => {
    const h = makeService({ activeJobs: 2 });
    await h.service.execute('p1', user);
    expect(h.skipReason()).toBe('active_job');
    expect(h.files.remove).not.toHaveBeenCalled();
  });

  it('5. skips a file whose fingerprint no longer matches what was approved', async () => {
    const h = makeService({ fingerprintNow: 'fp-something-else' });
    await h.service.execute('p1', user);
    expect(h.skipReason()).toBe('fingerprint_drift');
    expect(h.files.remove).not.toHaveBeenCalled();
  });

  // Fail closed: not being able to verify is not the same as verifying.
  it('5b. skips when the fingerprint cannot be recomputed at all', async () => {
    const h = makeService({ fingerprintNow: null });
    await h.service.execute('p1', user);
    expect(h.skipReason()).toBe('fingerprint_drift');
    expect(h.files.remove).not.toHaveBeenCalled();
  });

  it('5c. skips an action that records no media file to verify against', async () => {
    const h = makeService({ actions: [{ ...ACTION, mediaFileId: null }] });
    await h.service.execute('p1', user);
    expect(h.skipReason()).toBe('fingerprint_drift');
    expect(h.files.remove).not.toHaveBeenCalled();
  });
});

describe('how the work is actually done', () => {
  it('removes through the platform seam in STORAGE scope, never by itself', async () => {
    const h = makeService();
    await h.service.execute('p1', user);
    expect(h.files.remove).toHaveBeenCalledWith(
      { path: '/Movies/Film/film.mkv', permanent: false },
      { userId: 'u1' },
      'storage',
    );
  });

  // Trash, not delete: the whole point of the default destination.
  it('never asks for a permanent removal', async () => {
    const h = makeService();
    await h.service.execute('p1', user);
    expect(h.files.remove.mock.calls[0]![0]).toMatchObject({ permanent: false });
  });

  it('routes a quarantine plan to the quarantine store', async () => {
    const h = makeService({
      plan: { id: 'p1', status: 'approved', action: 'quarantine', runId: 'r1', policyVersionId: 'v1',
              retentionDays: 14, expiresAt: new Date('2099-01-01T00:00:00Z') },
      actions: [{ ...ACTION, actionType: 'quarantine' }],
    });
    await h.service.execute('p1', user);
    expect(h.quarantine.quarantine).toHaveBeenCalledWith(expect.objectContaining({ retentionDays: 14 }));
    expect(h.files.remove).not.toHaveBeenCalled();
  });

  it('refuses a permanent delete even if a row somehow asks for one', async () => {
    const h = makeService({ actions: [{ ...ACTION, actionType: 'permanent_delete' }] });
    const result = await h.service.execute('p1', user);
    expect(result.failed).toBe(1);
    expect(h.files.remove).not.toHaveBeenCalled();
  });

  // A crash mid-execution must leave evidence of what was in flight.
  it('journals running BEFORE the filesystem call', async () => {
    const h = makeService();
    await h.service.execute('p1', user);
    const statuses = h.actionUpdates.map((u) => u.data.status);
    expect(statuses).toEqual(['running', 'completed']);
    // And the journal write really did precede the removal.
    const journalOrder = h.prisma.mediaCleanupAction.update.mock.invocationCallOrder[0]!;
    expect(journalOrder).toBeLessThan(h.files.remove.mock.invocationCallOrder[0]!);
  });

  it('records a failure on the action instead of aborting the plan', async () => {
    const h = makeService({ removeThrows: new Error('device busy') });
    const result = await h.service.execute('p1', user);
    expect(result.failed).toBe(1);
    expect(h.actionUpdates.at(-1)!.data).toMatchObject({ status: 'failed', errorMessage: 'device busy' });
    expect(h.planRow!.status).toBe('partial');
  });

  // A plan that left files alone is not a clean success, and saying so is the point.
  it('reports partial when anything was skipped', async () => {
    const h = makeService({ isProtected: true });
    const result = await h.service.execute('p1', user);
    expect(result.skipped).toBe(1);
    expect(h.planRow!.status).toBe('partial');
  });

  it('sums only what was really reclaimed', async () => {
    const h = makeService({
      actions: [ACTION, { ...ACTION, id: 'a2', candidateId: 'c2', mediaFileId: 'f2' }],
    });
    const result = await h.service.execute('p1', user);
    expect(result.completed).toBe(2);
    expect(h.planRow!.actualReclaimBytes).toBe(4096n);
  });
});
