import { PERMISSIONS } from '@ultratorrent/shared';
import {
  ACTION_PERMISSION, ACTION_SEVERITY, TERMINAL_PLAN_STATUSES, canTransition,
  checkApproval, isExpired, isPlannable, requiresApproval, resolveDestination,
  resolveExpiry, PLAN_EXPIRY, type PlanStatus,
} from './plan-contract';

const NOW = new Date('2026-06-01T00:00:00Z');

describe('the plan state machine', () => {
  it('lets a pending plan be decided', () => {
    expect(canTransition('pending_approval', 'approved')).toBe(true);
    expect(canTransition('pending_approval', 'rejected')).toBe(true);
    expect(canTransition('pending_approval', 'cancelled')).toBe(true);
    expect(canTransition('pending_approval', 'expired')).toBe(true);
  });

  it('refuses to execute a plan nobody approved', () => {
    expect(canTransition('pending_approval', 'executing')).toBe(false);
    expect(canTransition('rejected', 'executing')).toBe(false);
    expect(canTransition('expired', 'executing')).toBe(false);
    expect(canTransition('approved', 'executing')).toBe(true);
  });

  // Approval is not a licence that outlives the evidence it was granted on.
  it('lets an approved plan still expire or be cancelled', () => {
    expect(canTransition('approved', 'expired')).toBe(true);
    expect(canTransition('approved', 'cancelled')).toBe(true);
  });

  it('never lets a decided plan be re-decided', () => {
    for (const s of TERMINAL_PLAN_STATUSES) {
      for (const to of ['approved', 'executing', 'pending_approval'] as PlanStatus[]) {
        expect(canTransition(s, to)).toBe(false);
      }
    }
  });

  it('cannot re-open a rejected plan by approving it', () => {
    expect(canTransition('rejected', 'approved')).toBe(false);
  });
});

describe('destination may be softened, never escalated', () => {
  it('defaults to the policy destination', () => {
    expect(resolveDestination('trash')).toBe('trash');
    expect(resolveDestination('quarantine')).toBe('quarantine');
  });

  it('allows a downgrade from trash to quarantine', () => {
    expect(resolveDestination('trash', 'quarantine')).toBe('quarantine');
  });

  // The whole point: a request body must not be able to out-destroy the document
  // an approver reviewed.
  it('refuses an escalation from quarantine to trash', () => {
    expect(resolveDestination('quarantine', 'trash')).toBeNull();
  });

  it('refuses a destination that is not a destination at all', () => {
    expect(resolveDestination('trash', 'permanent_delete')).toBeNull();
    expect(resolveDestination('trash', 'rm -rf')).toBeNull();
  });

  it('orders severity so permanent delete is the most severe', () => {
    expect(ACTION_SEVERITY.quarantine).toBeLessThan(ACTION_SEVERITY.trash);
    expect(ACTION_SEVERITY.trash).toBeLessThan(ACTION_SEVERITY.permanent_delete);
  });
});

describe('an approver needs the permission for THIS kind of removal', () => {
  it('maps each action to its own permission', () => {
    expect(ACTION_PERMISSION.trash).toBe(PERMISSIONS.LIBRARY_CLEANUP_TRASH);
    expect(ACTION_PERMISSION.permanent_delete).toBe(PERMISSIONS.LIBRARY_CLEANUP_PERMANENT_DELETE);
  });

  const base = {
    status: 'pending_approval' as PlanStatus,
    expiresAt: new Date('2026-06-02T00:00:00Z'),
    now: NOW,
    superAdmin: false,
    actionableCount: 3,
  };

  it('approves when everything holds', () => {
    const v = checkApproval({
      ...base, action: 'trash', holderPermissions: [PERMISSIONS.LIBRARY_CLEANUP_TRASH],
    });
    expect(v.allowed).toBe(true);
  });

  // A role that can wave through a quarantine must not thereby wave through a delete.
  it('refuses a permanent delete to someone who only holds trash', () => {
    const v = checkApproval({
      ...base, action: 'permanent_delete', holderPermissions: [PERMISSIONS.LIBRARY_CLEANUP_TRASH],
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('missing_permission');
    expect(v.missingPermission).toBe(PERMISSIONS.LIBRARY_CLEANUP_PERMANENT_DELETE);
  });

  it('lets a super admin through the granular check', () => {
    const v = checkApproval({ ...base, action: 'permanent_delete', holderPermissions: [], superAdmin: true });
    expect(v.allowed).toBe(true);
  });

  // The sweep is periodic; a plan must not be approvable in the gap.
  it('refuses an expired plan inline, without waiting for the sweep', () => {
    const v = checkApproval({
      ...base, action: 'trash', holderPermissions: [PERMISSIONS.LIBRARY_CLEANUP_TRASH],
      expiresAt: new Date('2026-05-31T23:59:00Z'),
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('expired');
  });

  it('refuses a plan with nothing left to act on', () => {
    const v = checkApproval({
      ...base, action: 'trash', holderPermissions: [PERMISSIONS.LIBRARY_CLEANUP_TRASH],
      actionableCount: 0,
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('nothing_to_do');
  });

  it('refuses anything that is not pending', () => {
    for (const status of ['approved', 'rejected', 'executing', 'expired'] as PlanStatus[]) {
      const v = checkApproval({
        ...base, status, action: 'trash', holderPermissions: [PERMISSIONS.LIBRARY_CLEANUP_TRASH],
      });
      expect(v.reason).toBe('wrong_status');
    }
  });

  // Ordering matters: a status refusal must not leak whether the plan expired.
  it('reports the status problem before the permission problem', () => {
    const v = checkApproval({ ...base, status: 'approved', action: 'trash', holderPermissions: [] });
    expect(v.reason).toBe('wrong_status');
  });
});

describe('expiry', () => {
  it('defaults to 72 hours', () => {
    expect(resolveExpiry(NOW).toISOString()).toBe('2026-06-04T00:00:00.000Z');
  });

  it('clamps a request to the supported window', () => {
    expect(resolveExpiry(NOW, 0).getTime()).toBe(NOW.getTime() + PLAN_EXPIRY.minHours * 3_600_000);
    expect(resolveExpiry(NOW, 99_999).getTime()).toBe(NOW.getTime() + PLAN_EXPIRY.maxHours * 3_600_000);
  });

  // A plan we cannot date is a plan we cannot vouch for.
  it('treats a missing expiry as expired, not as immortal', () => {
    expect(isExpired(null, NOW)).toBe(true);
    expect(isExpired(undefined, NOW)).toBe(true);
  });

  it('expires exactly on the boundary', () => {
    expect(isExpired(NOW, NOW)).toBe(true);
    expect(isExpired(new Date(NOW.getTime() + 1), NOW)).toBe(false);
  });
});

describe('policy modes', () => {
  it('refuses to plan from a report-only policy', () => {
    expect(isPlannable('report_only')).toBe(false);
    expect(isPlannable('approval_required')).toBe(true);
  });

  it('knows which modes decide without a human', () => {
    expect(requiresApproval('approval_required')).toBe(true);
    expect(requiresApproval('auto_trash')).toBe(false);
    expect(requiresApproval('auto_quarantine')).toBe(false);
  });
});
