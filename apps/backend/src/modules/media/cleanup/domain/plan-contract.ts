import { PERMISSIONS, type Permission } from '@ultratorrent/shared';
import type { PolicyDestination, PolicyMode } from './policy-document';

/**
 * The plan contract — what a plan may become, who may decide it, and what a
 * decision is allowed to change.
 *
 * A plan is the ONLY thing an execution endpoint accepts. It pins a policy
 * version, a candidate set, and each candidate's fingerprint, so what an operator
 * approved is exactly what runs — not "whatever matches when it runs". Everything
 * here is pure, so the rules are tested directly rather than through HTTP.
 */

/** Every action a plan row can carry. `permanent_delete` is the retention purge, never a policy destination. */
export type PlanAction = 'quarantine' | 'trash' | 'permanent_delete';

export type PlanStatus =
  | 'draft' | 'pending_approval' | 'approved' | 'rejected'
  | 'executing' | 'completed' | 'partial' | 'failed'
  | 'expired' | 'cancelled';

/**
 * How destructive each destination is. A plan may be created with a destination
 * NO MORE severe than the policy's own — an operator can downgrade a trash policy
 * to quarantine, never upgrade a quarantine policy to a delete. Without this, a
 * request body would be able to escalate past the document an approver reviewed.
 */
export const ACTION_SEVERITY: Record<PlanAction, number> = {
  quarantine: 0,
  trash: 1,
  permanent_delete: 2,
};

/**
 * The permission an approver must hold ON TOP of `library_cleanup.approve`.
 * Approving is one gate; being allowed to perform *this* kind of removal is another,
 * and a role that can wave through a quarantine must not thereby be able to wave
 * through an irreversible delete.
 */
export const ACTION_PERMISSION: Record<PlanAction, Permission> = {
  // Quarantine is a reversible removal, so it rides the same permission as Trash.
  quarantine: PERMISSIONS.LIBRARY_CLEANUP_TRASH,
  trash: PERMISSIONS.LIBRARY_CLEANUP_TRASH,
  permanent_delete: PERMISSIONS.LIBRARY_CLEANUP_PERMANENT_DELETE,
};

/** Terminal states. Nothing leaves these — a decided plan stays decided. */
export const TERMINAL_PLAN_STATUSES: ReadonlySet<PlanStatus> = new Set<PlanStatus>([
  'completed', 'partial', 'failed', 'rejected', 'expired', 'cancelled',
]);

const TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'expired', 'cancelled'],
  // An approved plan may still expire: its fingerprints go stale while it waits.
  approved: ['executing', 'expired', 'cancelled'],
  executing: ['completed', 'partial', 'failed'],
  completed: [], partial: [], failed: [],
  rejected: [], expired: [], cancelled: [],
};

export function canTransition(from: PlanStatus, to: PlanStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Statuses a plan can still be executed from, once approved. */
export const EXECUTABLE_PLAN_STATUS: PlanStatus = 'approved';

/** Modes that decide without a human. Phase 7 exposes only the human path. */
const AUTOMATIC_MODES: ReadonlySet<string> = new Set(['auto_quarantine', 'auto_trash']);

export function requiresApproval(mode: PolicyMode | string): boolean {
  return !AUTOMATIC_MODES.has(mode);
}

/** A report-only policy exists to be read, never to remove anything. */
export function isPlannable(mode: PolicyMode | string): boolean {
  return mode !== 'report_only';
}

export interface PlanExpiryBounds {
  defaultHours: number;
  minHours: number;
  maxHours: number;
}

/**
 * A plan expires because its fingerprints decay: the longer it waits, the less its
 * snapshot describes what is on disk. Expiry is a safety property, not a chore.
 */
export const PLAN_EXPIRY: PlanExpiryBounds = {
  defaultHours: 72,
  minHours: 1,
  maxHours: 720, // 30 days
};

export function resolveExpiry(now: Date, hours?: number): Date {
  const h = hours ?? PLAN_EXPIRY.defaultHours;
  const clamped = Math.min(Math.max(Math.round(h), PLAN_EXPIRY.minHours), PLAN_EXPIRY.maxHours);
  return new Date(now.getTime() + clamped * 3_600_000);
}

export function isExpired(expiresAt: Date | null | undefined, now: Date): boolean {
  // No expiry recorded is treated as expired, not as immortal: a plan we cannot
  // date is a plan we cannot vouch for.
  if (!expiresAt) return true;
  return expiresAt.getTime() <= now.getTime();
}

export interface DecisionCheck {
  allowed: boolean;
  /** Machine-readable refusal, for the API message and the audit row. */
  reason?: 'wrong_status' | 'expired' | 'missing_permission' | 'nothing_to_do';
  missingPermission?: Permission;
}

/**
 * Everything that must hold for an approval to be legitimate, in one place so the
 * service cannot check three of the four.
 */
export function checkApproval(input: {
  status: PlanStatus;
  action: PlanAction;
  expiresAt: Date | null;
  now: Date;
  holderPermissions: readonly string[];
  superAdmin: boolean;
  actionableCount: number;
}): DecisionCheck {
  if (input.status !== 'pending_approval') return { allowed: false, reason: 'wrong_status' };
  // Checked inline, not left to the sweep: the sweep runs periodically, and a plan
  // must not be approvable in the gap between expiring and being swept.
  if (isExpired(input.expiresAt, input.now)) return { allowed: false, reason: 'expired' };
  if (input.actionableCount <= 0) return { allowed: false, reason: 'nothing_to_do' };

  const required = ACTION_PERMISSION[input.action];
  if (!input.superAdmin && !input.holderPermissions.includes(required)) {
    return { allowed: false, reason: 'missing_permission', missingPermission: required };
  }
  return { allowed: true };
}

/**
 * A plan may not be more destructive than the policy an approver reviewed.
 * Returns the destination to use, or null if the request tried to escalate.
 */
export function resolveDestination(
  policyDestination: PolicyDestination,
  requested?: string,
): PlanAction | null {
  if (!requested) return policyDestination;
  if (!(requested in ACTION_SEVERITY)) return null;
  const req = requested as PlanAction;
  return ACTION_SEVERITY[req] <= ACTION_SEVERITY[policyDestination] ? req : null;
}
