import { PERMISSIONS } from '@ultratorrent/shared';

import { RISK_APPROVAL_PERMISSION, checkPlanApproval, type PlanApprovalInput } from './plan-approval';

/**
 * Who may approve a plan, and what approval cannot buy.
 *
 * The claim this file exists to defend: **approval supplies consent, never
 * knowledge.** A person clicking Approve has not measured an unprobed file,
 * resolved an ambiguous identity, or learned whether a payload is still
 * seeding. Blockers of that kind must survive a signature, or Phase 6 becomes
 * a way to launder uncertainty into permission.
 */

const NOW = new Date('2026-09-16T12:00:00Z');
const LATER = new Date('2026-09-16T18:00:00Z').toISOString();

const input = (over: Partial<PlanApprovalInput> = {}): PlanApprovalInput => ({
  status: 'awaiting_approval',
  riskClass: 'low',
  blockReason: null,
  expiresAt: LATER,
  now: NOW,
  holderPermissions: [PERMISSIONS.MEDIA_REMEDIATION_APPROVE],
  superAdmin: false,
  actionableSteps: 2,
  inputsDrifted: false,
  ...over,
});

describe('checkPlanApproval — the happy path', () => {
  it('allows an authorised approver to clear a fresh, unblocked plan', () => {
    expect(checkPlanApproval(input())).toEqual({ allowed: true });
  });

  it('accepts a plan still in `proposed`, not only one awaiting approval', () => {
    // An operator may approve straight from the list without the plan having
    // been formally routed for approval first.
    expect(checkPlanApproval(input({ status: 'proposed' })).allowed).toBe(true);
  });
});

describe('checkPlanApproval — status and freshness', () => {
  it('refuses a plan that has already been decided', () => {
    for (const status of ['succeeded', 'failed', 'cancelled', 'superseded'] as const) {
      expect(checkPlanApproval(input({ status })).reason).toBe('wrong_status');
    }
  });

  it('refuses a plan that is already executing', () => {
    expect(checkPlanApproval(input({ status: 'executing' })).reason).toBe('wrong_status');
  });

  it('refuses an expired plan inline, not on the sweep’s schedule', () => {
    // A plan must not be approvable in the gap between expiring and being
    // swept: the fingerprints have stopped describing the world.
    const expired = checkPlanApproval(input({ expiresAt: '2026-09-16T06:00:00Z' }));
    expect(expired.reason).toBe('expired');
  });

  it('refuses a plan with no expiry at all', () => {
    // One we cannot date is one we cannot vouch for.
    expect(checkPlanApproval(input({ expiresAt: null })).reason).toBe('expired');
  });
});

describe('checkPlanApproval — a changed plan is not the approved plan', () => {
  it('refuses when a pinned input drifted', () => {
    expect(checkPlanApproval(input({ inputsDrifted: true })).reason).toBe('approval_invalidated');
  });

  it('reports drift ahead of any permission question', () => {
    // There is no point asking who may approve a plan that no longer
    // describes what would happen.
    const r = checkPlanApproval(input({ inputsDrifted: true, holderPermissions: [] }));
    expect(r.reason).toBe('approval_invalidated');
  });
});

describe('checkPlanApproval — consent versus knowledge', () => {
  it('refuses a knowledge blocker as UNKNOWABLE, which approval cannot clear', () => {
    for (const blockReason of [
      'quality_not_measured',
      'identity_uncertain',
      'seeding_state_unknown',
      'desired_state_unknown',
      'path_unsafe',
      'capability_unavailable',
      // A lock is an operator's standing "automation off" for this title.
      // Approving a different decision does not revoke it — and the owning
      // domain skips locked items anyway, so a plan approved past one would
      // run, touch nothing, and still claim success.
      'item_locked',
    ] as const) {
      const r = checkPlanApproval(input({ blockReason }));
      expect(r.allowed).toBe(false);
      // Distinct from `blocked`: the UI must be able to say "no signature
      // fixes this" rather than offering an Approve button that will fail.
      expect(r.reason).toBe('unknowable');
      expect(r.blockReason).toBe(blockReason);
    }
  });

  it('reports a consent/timing blocker as BLOCKED, which can clear on its own', () => {
    for (const blockReason of ['budget_exhausted', 'circuit_open', 'policy_conflict'] as const) {
      const r = checkPlanApproval(input({ blockReason }));
      expect(r.reason).toBe('blocked');
      expect(r.blockReason).toBe(blockReason);
    }
  });

  it('does not let a super-admin approve past an unknowable blocker either', () => {
    // SUPER_ADMIN short-circuits PERMISSIONS, not physics. The file is still
    // unmeasured.
    const r = checkPlanApproval(input({ blockReason: 'quality_not_measured', superAdmin: true }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('unknowable');
  });
});

describe('checkPlanApproval — authority', () => {
  it('refuses an approver who lacks the approve permission', () => {
    const r = checkPlanApproval(input({ holderPermissions: [] }));
    expect(r.reason).toBe('missing_permission');
    expect(r.missingPermission).toBe(PERMISSIONS.MEDIA_REMEDIATION_APPROVE);
  });

  it('lets a super-admin through the permission gate', () => {
    expect(checkPlanApproval(input({ holderPermissions: [], superAdmin: true })).allowed).toBe(true);
  });

  it('demands a stronger grant for a destructive plan than for a low-risk one', () => {
    /*
     * Risk and consent are separate inputs, and the stricter wins. Someone who
     * may wave through a metadata refresh must not thereby be able to wave
     * through something that destroys data.
     */
    const r = checkPlanApproval(input({ riskClass: 'destructive' }));
    expect(r.reason).toBe('missing_permission');
    expect(r.missingPermission).toBe(PERMISSIONS.LIBRARY_CLEANUP_PERMANENT_DELETE);
  });

  it('points destructive and irreversible risk at a never-inherited permission', () => {
    // Phase 6 executes nothing destructive. These rows exist so the table is
    // total, and they must fail closed rather than inherit approval authority.
    expect(RISK_APPROVAL_PERMISSION.destructive).toBe(PERMISSIONS.LIBRARY_CLEANUP_PERMANENT_DELETE);
    expect(RISK_APPROVAL_PERMISSION.irreversible).toBe(PERMISSIONS.LIBRARY_CLEANUP_PERMANENT_DELETE);
  });
});

describe('checkPlanApproval — nothing to do', () => {
  it('refuses a plan with no steps left to run', () => {
    expect(checkPlanApproval(input({ actionableSteps: 0 })).reason).toBe('nothing_to_do');
  });
});
