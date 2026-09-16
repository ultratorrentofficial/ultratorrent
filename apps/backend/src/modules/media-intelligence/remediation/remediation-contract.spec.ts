import {
  APPROVAL_PROOF_BLOCKERS,
  REMEDIATION_BLOCK_REASONS,
  REMEDIATION_FAILURE_CLASSES,
  REMEDIATION_PLAN_EXPIRY,
  REMEDIATION_PLAN_STATUSES,
  RETRYABLE_FAILURE_CLASSES,
  RISK_SEVERITY,
  TERMINAL_PLAN_STATUSES,
  canTransitionPlan,
  isActivePlan,
  isPlanExpired,
  isRetryable,
  resolvePlanExpiry,
  survivesApproval,
  type RemediationPlanStatus,
} from '@ultratorrent/shared';

/**
 * The Phase 6 lifecycle vocabulary.
 *
 * These are the claims the rest of the phase is allowed to rely on. The ones
 * worth pinning are the safety properties: that success is reachable only by
 * observing source truth, that a decided plan stays decided, that approval
 * supplies consent and never knowledge, and that only two failure classes may
 * be retried.
 */

const NOW = new Date('2026-09-16T00:00:00Z');

describe('the plan state machine', () => {
  it('cannot reach success without verifying source truth first', () => {
    // The whole point of Phase 6. An action returning 200 is not the drift
    // being gone, so nothing may jump straight to `succeeded`.
    for (const from of REMEDIATION_PLAN_STATUSES) {
      if (from === 'verifying') continue;
      expect(canTransitionPlan(from, 'succeeded')).toBe(false);
    }
    expect(canTransitionPlan('verifying', 'succeeded')).toBe(true);
  });

  it('lets verification conclude the intent was NOT met', () => {
    // A plan that ran every step and still did not satisfy the desired state
    // has failed. Reporting success with a caveat would be the lie.
    expect(canTransitionPlan('verifying', 'failed')).toBe(true);
  });

  it('refuses to execute a plan nobody cleared', () => {
    expect(canTransitionPlan('proposed', 'executing')).toBe(false);
    expect(canTransitionPlan('awaiting_approval', 'executing')).toBe(false);
    expect(canTransitionPlan('blocked', 'executing')).toBe(false);
    expect(canTransitionPlan('approved', 'executing')).toBe(true);
  });

  it('never re-decides a decided plan', () => {
    for (const from of TERMINAL_PLAN_STATUSES) {
      for (const to of ['approved', 'executing', 'awaiting_approval'] as RemediationPlanStatus[]) {
        expect(canTransitionPlan(from, to)).toBe(false);
      }
    }
  });

  it('lets an approved plan still be superseded', () => {
    // Approval is not a licence that outlives the evidence it was granted on:
    // if the drift resolved or the policy changed, the plan is obsolete.
    expect(canTransitionPlan('approved', 'superseded')).toBe(true);
    expect(canTransitionPlan('waiting', 'superseded')).toBe(true);
  });

  it('re-gates a plan from scratch after a block clears', () => {
    // `blocked` is not terminal — the blocker was a statement about the
    // present. But it returns to `proposed`, never straight to `executing`:
    // resuming would trust a safety check that predates the blocker.
    expect(canTransitionPlan('blocked', 'proposed')).toBe(true);
    expect(canTransitionPlan('blocked', 'approved')).toBe(false);
  });

  it('treats a self-transition as illegal, so a no-op cannot look like progress', () => {
    for (const s of REMEDIATION_PLAN_STATUSES) {
      expect(canTransitionPlan(s, s)).toBe(false);
    }
  });

  it('counts exactly the undecided states as active', () => {
    expect(isActivePlan('waiting')).toBe(true);
    expect(isActivePlan('blocked')).toBe(true);
    expect(isActivePlan('succeeded')).toBe(false);
    expect(isActivePlan('superseded')).toBe(false);
  });

  it('leaves every terminal state with nowhere to go', () => {
    for (const from of TERMINAL_PLAN_STATUSES) {
      const reachable = REMEDIATION_PLAN_STATUSES.filter((to) => canTransitionPlan(from, to));
      expect(reachable).toEqual([]);
    }
  });
});

describe('approval supplies consent, never knowledge', () => {
  it('keeps every unknowable fact a blocker even after a human approves', () => {
    // A person clicking Approve has not measured the file, resolved the
    // identity, or learned whether the payload is still seeding.
    expect(survivesApproval('quality_not_measured')).toBe(true);
    expect(survivesApproval('identity_uncertain')).toBe(true);
    expect(survivesApproval('seeding_state_unknown')).toBe(true);
    expect(survivesApproval('desired_state_unknown')).toBe(true);
    expect(survivesApproval('path_unsafe')).toBe(true);
  });

  it('lets approval clear the blockers that are genuinely about consent or timing', () => {
    // These say "nobody has said yes yet" or "not right now" — not "the
    // system does not know enough to act".
    expect(survivesApproval('budget_exhausted')).toBe(false);
    expect(survivesApproval('circuit_open')).toBe(false);
    expect(survivesApproval('policy_conflict')).toBe(false);
  });

  it('never lets a missing capability be approved into existence', () => {
    expect(survivesApproval('capability_unavailable')).toBe(true);
  });

  it('draws every proof blocker from the declared vocabulary', () => {
    for (const reason of APPROVAL_PROOF_BLOCKERS) {
      expect(REMEDIATION_BLOCK_REASONS).toContain(reason);
    }
  });
});

describe('retry classification', () => {
  it('retries only what could plausibly differ next time', () => {
    expect(isRetryable('transient')).toBe(true);
    expect(isRetryable('external_rate_limit')).toBe(true);
  });

  it('never retries a safety refusal, a changed world, or a lost permission', () => {
    // Retrying these is how a failing system becomes a storm, and how a
    // refusal gets worn down by repetition.
    expect(isRetryable('safety_block')).toBe(false);
    expect(isRetryable('precondition_changed')).toBe(false);
    expect(isRetryable('authorization')).toBe(false);
    expect(isRetryable('capability_unavailable')).toBe(false);
    expect(isRetryable('permanent')).toBe(false);
    expect(isRetryable('cancelled')).toBe(false);
  });

  it('keeps the retryable set a strict subset of the declared classes', () => {
    for (const c of RETRYABLE_FAILURE_CLASSES) {
      expect(REMEDIATION_FAILURE_CLASSES).toContain(c);
    }
    expect(RETRYABLE_FAILURE_CLASSES.size).toBeLessThan(REMEDIATION_FAILURE_CLASSES.length);
  });
});

describe('risk is ordered, and independent of who authorized it', () => {
  it('ranks irreversible above destructive above the rest', () => {
    expect(RISK_SEVERITY.low).toBeLessThan(RISK_SEVERITY.moderate);
    expect(RISK_SEVERITY.moderate).toBeLessThan(RISK_SEVERITY.destructive);
    expect(RISK_SEVERITY.destructive).toBeLessThan(RISK_SEVERITY.irreversible);
  });
});

describe('expiry is a safety property', () => {
  it('treats an undated plan as expired rather than immortal', () => {
    // A plan we cannot date is a plan we cannot vouch for.
    expect(isPlanExpired(null, NOW)).toBe(true);
    expect(isPlanExpired(undefined, NOW)).toBe(true);
  });

  it('accepts an ISO string as well as a Date, since DTOs carry strings', () => {
    const future = new Date(NOW.getTime() + 3_600_000).toISOString();
    expect(isPlanExpired(future, NOW)).toBe(false);
  });

  it('expires on the boundary, not after it', () => {
    expect(isPlanExpired(NOW, NOW)).toBe(true);
  });

  it('defaults tighter than a candidate verification stays fresh', () => {
    // A plan pins an indexer candidate, and Phase 4 already established that
    // a verification stops meaning anything after 12 hours.
    expect(REMEDIATION_PLAN_EXPIRY.defaultHours).toBeLessThanOrEqual(12);
  });

  it('clamps a caller who asks for something absurd', () => {
    const tooLong = resolvePlanExpiry(NOW, 10_000);
    const tooShort = resolvePlanExpiry(NOW, 0);
    expect(tooLong.getTime()).toBe(NOW.getTime() + REMEDIATION_PLAN_EXPIRY.maxHours * 3_600_000);
    expect(tooShort.getTime()).toBe(NOW.getTime() + REMEDIATION_PLAN_EXPIRY.minHours * 3_600_000);
  });
});
