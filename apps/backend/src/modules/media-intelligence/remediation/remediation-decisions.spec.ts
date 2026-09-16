import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { PERMISSIONS } from '@ultratorrent/shared';

import { RemediationPlanService } from './remediation-plan.service';

/**
 * Approving and cancelling a plan.
 *
 * The claims worth pinning are the ones that decide whether this is a real
 * authorisation boundary or a rubber stamp: that a refusal is AUDITED rather
 * than only thrown, that approval pins exactly what was approved, that an
 * unknowable blocker cannot be signed past — by anyone, including a
 * super-admin — and that cancelling promises nothing about work already
 * issued to another domain.
 */

type Row = Record<string, unknown>;

const PLAN = {
  id: 'plan-1',
  status: 'proposed',
  riskClass: 'low',
  blockReason: null,
  expiresAt: new Date('2099-01-01T00:00:00Z'),
  type: 'REFRESH_METADATA',
  createdById: null,
  recommendationFingerprint: 'fp-abc',
};

const USER = { id: 'user-1', permissions: [PERMISSIONS.MEDIA_REMEDIATION_APPROVE], roles: [] };

function stub(opts: { plan?: Row | null; steps?: number; casCount?: number } = {}) {
  const calls = { updated: [] as Row[], audits: [] as Row[], history: [] as Row[] };

  const prisma = {
    mediaRemediationPlan: {
      findUnique: jest.fn(async () => (opts.plan === undefined ? PLAN : opts.plan)),
      updateMany: jest.fn(async (args: { where: Row; data: Row }) => {
        calls.updated.push({ ...args.where, ...args.data });
        return { count: opts.casCount ?? 1 };
      }),
    },
    mediaRemediationStep: { count: jest.fn(async () => opts.steps ?? 1) },
    mediaRemediationPlanEvent: {
      createMany: jest.fn(async (args: { data: Row[] }) => {
        calls.history.push(...args.data);
        return { count: args.data.length };
      }),
    },
  };
  const audit = {
    record: jest.fn(async (e: Row) => {
      calls.audits.push(e);
    }),
  };

  return { svc: new RemediationPlanService(prisma as never, audit as never), prisma, calls };
}

describe('approve', () => {
  it('pins exactly what was approved', async () => {
    const { svc, calls } = stub();
    await svc.approve('plan-1', USER);

    const update = calls.updated[0];
    expect(update).toMatchObject({ status: 'approved', approvedById: 'user-1' });
    /*
     * The fingerprint the approver saw. The executor compares against this
     * immediately before the source call, so a later change cannot execute
     * under an older signature.
     */
    expect(update.approvedFingerprint).toBe('fp-abc');
  });

  it('records the approval under its own audit verb', async () => {
    const { svc, calls } = stub();
    await svc.approve('plan-1', USER);

    expect(calls.audits[0]).toMatchObject({
      userId: 'user-1',
      action: 'media_intelligence.remediation.approved',
    });
  });

  it('audits self-approval separately, so a reviewer can find it', async () => {
    // Permitted — most installations have one operator, and a workflow
    // nobody can complete is worse than one recorded honestly.
    const { svc, calls } = stub({ plan: { ...PLAN, createdById: 'user-1' } });
    await svc.approve('plan-1', USER);

    expect(calls.audits[0]).toMatchObject({
      action: 'media_intelligence.remediation.self_approved',
    });
  });

  it('writes a history row for the transition', async () => {
    const { svc, calls } = stub();
    await svc.approve('plan-1', USER);
    expect(calls.history.some((h) => h.event === 'approved')).toBe(true);
  });
});

describe('approve — refusals are audited, not merely thrown', () => {
  it('records a refusal when the approver lacks the permission', async () => {
    const { svc, calls } = stub();
    await expect(
      svc.approve('plan-1', { id: 'user-2', permissions: [], roles: [] }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // "Who tried to approve what, and why were they refused" is exactly the
    // question an audit trail exists for; a 403 leaving no trace answers it
    // badly.
    expect(calls.audits[0]).toMatchObject({
      action: 'media_intelligence.remediation.approve_refused',
      result: 'failure',
    });
    expect((calls.audits[0].metadata as Row).missingPermission).toBe(
      PERMISSIONS.MEDIA_REMEDIATION_APPROVE,
    );
  });

  it('refuses an unknowable blocker as unprocessable, not as forbidden', async () => {
    const { svc } = stub({ plan: { ...PLAN, blockReason: 'quality_not_measured' } });
    // Not "you may not" — "the system does not know enough". The distinction
    // is the whole point of the phase.
    await expect(svc.approve('plan-1', USER)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('will not let a super-admin sign past an unknowable blocker', async () => {
    const { svc } = stub({ plan: { ...PLAN, blockReason: 'item_locked' } });
    const superAdmin = { id: 'root', permissions: [], roles: ['SUPER_ADMIN'] };
    // SUPER_ADMIN short-circuits permissions, not physics.
    await expect(svc.approve('plan-1', superAdmin)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('refuses a plan with nothing left to run', async () => {
    const { svc } = stub({ steps: 0 });
    await expect(svc.approve('plan-1', USER)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('refuses an expired plan rather than acting on a decayed snapshot', async () => {
    const { svc } = stub({ plan: { ...PLAN, expiresAt: new Date('2000-01-01T00:00:00Z') } });
    await expect(svc.approve('plan-1', USER)).rejects.toThrow(/expired/i);
  });

  it('loses a concurrent decision rather than applying both', async () => {
    // The CAS names the status it read; a count of zero means somebody else
    // decided first.
    const { svc } = stub({ casCount: 0 });
    await expect(svc.approve('plan-1', USER)).rejects.toThrow(/cannot be approved/i);
  });
});

describe('cancel', () => {
  it('stops a plan and records the previous status', async () => {
    const { svc, calls } = stub();
    await svc.cancel('plan-1', 'changed my mind', USER);

    expect(calls.updated[0]).toMatchObject({ status: 'cancelled' });
    expect(calls.audits[0]).toMatchObject({
      action: 'media_intelligence.remediation.cancelled',
    });
    expect((calls.audits[0].metadata as Row).previousStatus).toBe('proposed');
  });

  it('accepts no reason, because cancelling is often just housekeeping', async () => {
    const { svc, calls } = stub();
    await svc.cancel('plan-1', undefined, USER);
    expect((calls.audits[0].metadata as Row).reason).toBeNull();
  });

  it('promises nothing about work already issued', async () => {
    /*
     * Cancellation means "start nothing more". A source action already sent
     * to another domain belongs to that domain now, and this phase
     * implements no rollback it could honestly offer — so cancel writes a
     * status and never touches a step.
     */
    const { svc, prisma } = stub();
    await svc.cancel('plan-1', undefined, USER);
    expect(prisma.mediaRemediationStep.count).not.toHaveBeenCalled();
  });
});
