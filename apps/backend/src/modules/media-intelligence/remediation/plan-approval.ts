import { PERMISSIONS, type Permission } from '@ultratorrent/shared';
import {
  isPlanExpired,
  survivesApproval,
  type RemediationBlockReason,
  type RemediationPlanStatus,
  type RemediationRiskClass,
} from '@ultratorrent/shared';

/**
 * Everything that must hold for an approval to be legitimate, in one place.
 *
 * Gathered into a single pure function for the same reason Library Cleanup
 * did it: a service that checks these inline will eventually check three of
 * the four. Pure, so the rules are tested directly rather than through HTTP.
 *
 * The Phase 6 addition to that precedent is {@link survivesApproval}. Cleanup
 * asks "may this person authorise this?" — a question about consent. A
 * lifecycle plan must also ask "does the system know enough to act?", and
 * those are different. A person clicking Approve supplies consent; they do
 * not thereby measure an unprobed file, resolve an ambiguous identity, or
 * learn whether a payload is still seeding. Blockers of that second kind
 * survive approval, and refusing them here is what stops a signature from
 * being mistaken for knowledge.
 */

/** Machine-readable refusal, for the API message and the audit row. */
export type ApprovalRefusal =
  | 'wrong_status'
  | 'expired'
  | 'missing_permission'
  | 'blocked'
  | 'unknowable'
  | 'approval_invalidated'
  | 'nothing_to_do';

export interface ApprovalCheck {
  allowed: boolean;
  reason?: ApprovalRefusal;
  missingPermission?: Permission;
  /** Set for `blocked`/`unknowable`, so the refusal can name the blocker. */
  blockReason?: RemediationBlockReason;
}

/**
 * The permission approving a plan requires, by how dangerous it is.
 *
 * A single map rather than a conditional, so adding a risk class forces a
 * decision about who may wave it through. Phase 6 executes nothing
 * destructive or irreversible — those rows exist so the table is total, and
 * they deliberately point at a permission no role holds by inheritance, which
 * means such a plan cannot be approved until someone designs that grant.
 */
export const RISK_APPROVAL_PERMISSION: Record<RemediationRiskClass, Permission> = {
  low: PERMISSIONS.MEDIA_REMEDIATION_APPROVE,
  moderate: PERMISSIONS.MEDIA_REMEDIATION_APPROVE,
  // Not reachable in Phase 6. Left pointing at the strongest existing grant
  // rather than at the ordinary approve key, so a future destructive type
  // cannot inherit approval authority by accident.
  destructive: PERMISSIONS.LIBRARY_CLEANUP_PERMANENT_DELETE,
  irreversible: PERMISSIONS.LIBRARY_CLEANUP_PERMANENT_DELETE,
};

export interface PlanApprovalInput {
  status: RemediationPlanStatus;
  riskClass: RemediationRiskClass;
  /** Set when the plan is blocked; null when nothing blocks it. */
  blockReason: RemediationBlockReason | null;
  expiresAt: Date | string | null;
  now: Date;
  holderPermissions: readonly string[];
  superAdmin: boolean;
  /** Steps still to run. A plan with nothing left to do is not approvable. */
  actionableSteps: number;
  /**
   * True when a pinned input moved since the plan was built. Approving a plan
   * whose justification has changed would authorise work nobody reviewed.
   */
  inputsDrifted: boolean;
}

export function checkPlanApproval(input: PlanApprovalInput): ApprovalCheck {
  if (input.status !== 'proposed' && input.status !== 'awaiting_approval') {
    return { allowed: false, reason: 'wrong_status' };
  }

  /*
   * Checked inline rather than left to the expiry sweep. The sweep runs
   * periodically, and a plan must not be approvable in the gap between
   * expiring and being swept — the whole reason expiry exists is that the
   * fingerprints stopped describing the world.
   */
  if (isPlanExpired(input.expiresAt, input.now)) return { allowed: false, reason: 'expired' };

  // Drift beats everything below: there is no point asking who may approve a
  // plan that no longer describes what would happen.
  if (input.inputsDrifted) return { allowed: false, reason: 'approval_invalidated' };

  if (input.blockReason) {
    /*
     * The distinction Phase 6 must not lose. A blocker about consent or
     * timing (a budget, a circuit breaker) is exactly what approval is for.
     * A blocker about KNOWLEDGE is not: no signature measures a file.
     */
    return {
      allowed: false,
      reason: survivesApproval(input.blockReason) ? 'unknowable' : 'blocked',
      blockReason: input.blockReason,
    };
  }

  if (input.actionableSteps <= 0) return { allowed: false, reason: 'nothing_to_do' };

  const required = RISK_APPROVAL_PERMISSION[input.riskClass];
  if (!input.superAdmin && !input.holderPermissions.includes(required)) {
    return { allowed: false, reason: 'missing_permission', missingPermission: required };
  }

  return { allowed: true };
}
