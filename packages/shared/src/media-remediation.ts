/**
 * Remediation plans — the Phase 6 vocabulary.
 *
 * Phase 5 said what the operator wants and where reality differs. It stopped
 * there on purpose: there was no executor, so an `automatic` mode would have
 * been a lie. Phase 6 adds the execution layer, and this file is the part of
 * it that has no behaviour — the words the rest of the phase is built from.
 *
 * The rule this phase adds:
 *
 *   **A RECOMMENDATION IS NOT A PLAN.**
 *
 * "Upgrade this title to preferred quality" is a proposed response. The plan
 * is the ordered, safety-gated description of how that response is actually
 * carried out — verify the candidate is still superior, grab it through the
 * domain that owns grabbing, wait for the download, import it, prove the
 * replacement is real, and only then consider whether the old copy may be
 * retired. Collapsing the two would make "approve" mean something nobody can
 * inspect.
 *
 * ## What this phase still does not own
 *
 * Media Intelligence orchestrates; it never mutates. Every step names the
 * domain that owns the mutation and calls that domain's existing service.
 * There is no delete service, no move service and no grab service here, and
 * the absence is enforced by a structural test rather than by good intentions.
 *
 * ## Why the statuses are shaped like this
 *
 * Modelled on `media/cleanup/domain/plan-contract.ts`, which already solved
 * approval-gated destructive execution in this codebase: a pure transition
 * graph, terminal states nothing leaves, expiry treated as a safety property
 * rather than a chore, and every precondition gathered into one function so a
 * caller cannot check three of the four. Where Phase 6 departs from it, the
 * reason is recorded at the departure.
 *
 * The one real addition is what happens AFTER the source action succeeds.
 * Cleanup deletes a file and is done; a lifecycle plan asks a different domain
 * to change the world and then has to find out whether the world actually
 * changed. That is why `verifying` exists and why `succeeded` is reached only
 * from it.
 */

/* ------------------------------------------------------------- lifecycle */

/**
 * Every state a plan can occupy.
 *
 * Deliberately fewer names than Phase 6's brief suggested. `QUEUED` and
 * `APPROVED` are one state here (`approved`) because nothing distinguishes
 * them for an operator: an approved plan is waiting for the scheduler either
 * way, and a second name would need a second transition nobody can observe.
 */
export const REMEDIATION_PLAN_STATUSES = [
  /** Built and explainable, but nothing has been asked of anyone yet. */
  'proposed',
  /** A human must decide. The plan pins what they are deciding about. */
  'awaiting_approval',
  /** Cleared to run — by a person, or by an automation policy that qualified. */
  'approved',
  /** A step is running, or the plan sits between steps. */
  'executing',
  /**
   * A source action was issued and the plan is waiting for the world: a
   * download to finish, an import to complete. Distinct from `executing`
   * because nothing is consuming a worker.
   */
  'waiting',
  /**
   * Every step finished, and the plan is now checking whether the DESIRED
   * STATE is actually satisfied. An action returning success is not the same
   * as the drift being gone, and conflating them is how a system reports
   * victory over a library it never fixed.
   */
  'verifying',
  /** Source truth now satisfies the desired state. The only honest success. */
  'succeeded',
  /** A step failed permanently, or verification proved the intent unmet. */
  'failed',
  /**
   * A safety gate refused. Not a failure of execution — execution never
   * started — and not something a retry fixes on its own.
   */
  'blocked',
  /** A human stopped it. Completed steps are NOT undone. */
  'cancelled',
  /**
   * The world moved: the drift resolved, the policy changed, the candidate
   * stopped being superior, or someone fixed it by hand. A plan that has lost
   * its justification must not keep executing.
   */
  'superseded',
] as const;
export type RemediationPlanStatus = (typeof REMEDIATION_PLAN_STATUSES)[number];

/** Nothing leaves these. A decided plan stays decided. */
export const TERMINAL_PLAN_STATUSES: ReadonlySet<RemediationPlanStatus> =
  new Set<RemediationPlanStatus>(['succeeded', 'failed', 'cancelled', 'superseded']);

/**
 * `blocked` is deliberately NOT terminal.
 *
 * A block is a statement about the present — an unknown fact, a policy
 * conflict, a locked item — and those get resolved. When the next evaluation
 * finds the blocker gone the plan returns to `proposed` and is re-gated from
 * scratch, rather than resuming on the strength of a safety check that passed
 * before the thing that blocked it existed.
 */
const TRANSITIONS: Record<RemediationPlanStatus, readonly RemediationPlanStatus[]> = {
  proposed: ['awaiting_approval', 'approved', 'blocked', 'superseded', 'cancelled'],
  awaiting_approval: ['approved', 'blocked', 'superseded', 'cancelled'],
  // An approved plan may still be superseded: approval is not a licence that
  // outlives the evidence it was granted on.
  approved: ['executing', 'blocked', 'superseded', 'cancelled'],
  executing: ['waiting', 'verifying', 'failed', 'blocked', 'cancelled'],
  waiting: ['executing', 'verifying', 'failed', 'blocked', 'cancelled', 'superseded'],
  // Verification can conclude the intent was NOT met. That is a failure, not a
  // success with a caveat.
  verifying: ['succeeded', 'failed', 'blocked'],
  blocked: ['proposed', 'superseded', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
  superseded: [],
};

/**
 * Named `…Plan` rather than a bare `canTransition`: `intake.ts` already
 * exports that name into the same flat barrel, and two different state
 * machines cannot share one exported symbol. The prefix is not noise — a
 * caller importing from `@ultratorrent/shared` gets no file context, so the
 * name has to say which machine it governs.
 */
export function canTransitionPlan(
  from: RemediationPlanStatus,
  to: RemediationPlanStatus,
): boolean {
  if (from === to) return false;
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Is this plan still going somewhere? Drives the "active" filter and dedupe. */
export function isActivePlan(status: RemediationPlanStatus): boolean {
  return !TERMINAL_PLAN_STATUSES.has(status);
}

/* ----------------------------------------------------------------- steps */

/**
 * What one step of a plan is doing.
 *
 * Mirrors the plan's own vocabulary where the meaning is identical, because
 * two nearly-synonymous status sets is how a UI ends up translating one into
 * the other and getting it wrong.
 */
export const REMEDIATION_STEP_STATUSES = [
  'pending',
  'running',
  /** Issued to the owning domain; the outcome is not yet observable. */
  'waiting',
  'succeeded',
  'failed',
  /** A precondition said this step is unnecessary — not a failure. */
  'skipped',
  'cancelled',
] as const;
export type RemediationStepStatus = (typeof REMEDIATION_STEP_STATUSES)[number];

/**
 * How dangerous a step is, independent of who authorized it.
 *
 * Risk and policy mode are SEPARATE inputs. A policy set to automatic does not
 * make an irreversible action automatically executable; the two are combined
 * by the safety evaluator, and the stricter one wins. Ordered so comparisons
 * are possible without a second table.
 */
export const REMEDIATION_RISK_CLASSES = ['low', 'moderate', 'destructive', 'irreversible'] as const;
export type RemediationRiskClass = (typeof REMEDIATION_RISK_CLASSES)[number];

export const RISK_SEVERITY: Record<RemediationRiskClass, number> = {
  low: 0,
  moderate: 1,
  destructive: 2,
  irreversible: 3,
};

/* -------------------------------------------------------------- failures */

/**
 * Why a step failed, and therefore what may be done about it.
 *
 * Retrying everything is how a failing system turns into a storm; retrying
 * nothing is how a transient DNS blip becomes a manual chore. Only
 * `transient` and `external_rate_limit` are retryable, and the classifier is
 * the single place that decides.
 */
export const REMEDIATION_FAILURE_CLASSES = [
  /** Network blip, engine briefly unreachable. Retry with backoff. */
  'transient',
  /** It will not work next time either. Identity mismatch, malformed input. */
  'permanent',
  /** A safety gate refused. Never retried; the condition must change first. */
  'safety_block',
  /** The world moved between planning and execution. Re-plan, do not retry. */
  'precondition_changed',
  /** The actor lost the authority it had. Never retried silently. */
  'authorization',
  /** The owning domain cannot do this at all. Nothing to retry. */
  'capability_unavailable',
  /** An external provider asked us to slow down. Retry, later. */
  'external_rate_limit',
  /** A human stopped it. */
  'cancelled',
] as const;
export type RemediationFailureClass = (typeof REMEDIATION_FAILURE_CLASSES)[number];

/** The only classes a retry may follow. Everything else needs a new decision. */
export const RETRYABLE_FAILURE_CLASSES: ReadonlySet<RemediationFailureClass> =
  new Set<RemediationFailureClass>(['transient', 'external_rate_limit']);

export function isRetryable(failure: RemediationFailureClass): boolean {
  return RETRYABLE_FAILURE_CLASSES.has(failure);
}

/* ----------------------------------------------------------- safety gates */

/**
 * Why a plan may not proceed.
 *
 * Stable codes, humanized at the edge. Every one of these is a refusal the
 * operator is entitled to see stated plainly — "blocked" with no reason is the
 * kind of opacity that makes people switch a feature off.
 *
 * The UNKNOWN entries matter most. Phase 5 established that `unknown` is not
 * `compliant` and not `drift`; Phase 6 adds that it is not permission either.
 * Several of these survive human approval, because approval cannot convert an
 * unmeasured file into a measured one.
 */
export const REMEDIATION_BLOCK_REASONS = [
  /** A dimension the plan depends on could not be evaluated. */
  'desired_state_unknown',
  /** Two same-scope policies disagree. Determinism is not consent. */
  'policy_conflict',
  /** The entity is not confidently matched to a known work. */
  'identity_uncertain',
  /** Quality was never measured, so "better" cannot be established. */
  'quality_not_measured',
  /** The owning domain exposes no action for this remediation. */
  'capability_unavailable',
  /** The candidate verification aged out and must be re-earned. */
  'verification_stale',
  /** The candidate is no longer strictly superior to what is owned. */
  'candidate_not_superior',
  /** A person locked this item against automated change. */
  'item_locked',
  /** The entity vanished between planning and execution. */
  'entity_missing',
  /** Whether the payload is still seeding could not be established. */
  'seeding_state_unknown',
  /** The path left its hard root, or the destination is occupied. */
  'path_unsafe',
  /** Budgets or a circuit breaker are holding work back right now. */
  'budget_exhausted',
  'circuit_open',
  /** The approval no longer describes this plan. */
  'approval_invalidated',
  /** The actor lacks the permission this step requires. */
  'insufficient_authority',
] as const;
export type RemediationBlockReason = (typeof REMEDIATION_BLOCK_REASONS)[number];

/**
 * Blockers a human approval cannot clear.
 *
 * The distinction Phase 6 must not lose: some refusals are "nobody has said
 * yes yet", and some are "the system does not know enough to act safely". A
 * person clicking Approve supplies consent, not knowledge. Approving past an
 * unmeasured file would authorise a replacement whose superiority nothing
 * established.
 */
export const APPROVAL_PROOF_BLOCKERS: ReadonlySet<RemediationBlockReason> =
  new Set<RemediationBlockReason>([
    'desired_state_unknown',
    'identity_uncertain',
    'quality_not_measured',
    'capability_unavailable',
    'candidate_not_superior',
    'entity_missing',
    'seeding_state_unknown',
    'path_unsafe',
    /*
     * A lock is here for two reasons, and the second is the decisive one.
     *
     * It is a separate, deliberate operator act — "keep automation off this
     * title" — and approving an unrelated remediation is not a decision to
     * revoke it. Someone who wants the plan to run unlocks the item, which is
     * an explicit choice with its own audit trail.
     *
     * And mechanically, the owning domains skip locked items silently
     * (`MediaBulkService.unlockedOf` filters them out before any work). So a
     * plan approved past a lock would execute, touch nothing, and still reach
     * `succeeded` — reporting a drift resolved that was never addressed.
     */
    'item_locked',
  ]);

export function survivesApproval(reason: RemediationBlockReason): boolean {
  return APPROVAL_PROOF_BLOCKERS.has(reason);
}

/* ---------------------------------------------------------------- expiry */

/**
 * A plan expires because its fingerprints decay.
 *
 * Same reasoning as Library Cleanup: the longer a plan waits, the less its
 * snapshot describes the world. Bounded tighter than cleanup's 72h default
 * because a remediation plan pins an INDEXER candidate, and Phase 4 already
 * established that a verification stops meaning anything after 12 hours.
 */
export const REMEDIATION_PLAN_EXPIRY = {
  defaultHours: 12,
  minHours: 1,
  maxHours: 168,
} as const;

/**
 * An undated plan is treated as expired — one we cannot date is one we cannot
 * vouch for. (Library Cleanup's `plan-contract.ts` reaches the same
 * conclusion; it can keep the bare name because it is module-local, while
 * everything here lands in one flat barrel.)
 */
export function isPlanExpired(
  expiresAt: Date | string | null | undefined,
  now: Date,
): boolean {
  if (!expiresAt) return true;
  const at = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return at.getTime() <= now.getTime();
}

export function resolvePlanExpiry(now: Date, hours?: number): Date {
  const h = hours ?? REMEDIATION_PLAN_EXPIRY.defaultHours;
  const clamped = Math.min(
    Math.max(Math.round(h), REMEDIATION_PLAN_EXPIRY.minHours),
    REMEDIATION_PLAN_EXPIRY.maxHours,
  );
  return new Date(now.getTime() + clamped * 3_600_000);
}

/* ------------------------------------------------------------------ DTOs */

/**
 * One EXECUTABLE step of a plan, as the API returns it.
 *
 * Named `…PlanStep` because `MediaRemediationStep` is already taken, by Phase
 * 4's `MEDIA_REMEDIATION_STEPS` — the *explanatory* vocabulary a
 * recommendation carries (`search_indexers`, `require_approval`, …). That
 * collision is worth keeping rather than merging: an explanatory step says
 * what a response would involve, while this says what the executor will
 * actually invoke, against which domain, under which permission. Phase 6
 * exists because those are different things.
 *
 * Note what is absent: no filesystem path, no download URL, no provider
 * payload, no client-supplied handler. A step names the domain that owns the
 * mutation and the capability it will invoke there; the server decides what
 * actually executes, and the owning domain enforces its own permission when
 * called. Anything richer would make this object a set of instructions a
 * browser could edit.
 */
export interface MediaRemediationPlanStep {
  id: string;
  ordinal: number;

  /** The step's machine kind, e.g. `refresh_metadata`. Humanized at the edge. */
  kind: string;
  /** Which module owns the mutation — `media_manager`, `torrents`, … */
  ownerDomain: string;
  /** The CAMA id the owning module already registered, when one exists. */
  capabilityId: string | null;
  /** The permission that domain requires, so the UI can explain a refusal. */
  requiredPermission: string | null;

  status: RemediationStepStatus;

  /** Bounded scalar inputs. Never secrets. */
  inputSnapshot: Record<string, unknown>;
  /** What must be true afterwards for this step to count as done. */
  expectedPostcondition: Record<string, unknown>;

  attemptCount: number;
  failureClass: RemediationFailureClass | null;
  /** Bounded. Never a raw provider error payload. */
  failureMessage: string | null;
  /** A precondition said this step was unnecessary — not a failure. */
  skipReason: string | null;

  startedAt: string | null;
  completedAt: string | null;
}

/** One transition in a plan's history. Bounded, never localized prose. */
export interface MediaRemediationPlanEvent {
  id: string;
  event: string;
  at: string;
  /** Null for machine transitions: no person did it. Rendered "by system". */
  actorUserId: string | null;
  actorName: string | null;
  detail: Record<string, unknown>;
}

/**
 * One remediation plan, as the API returns it.
 *
 * Carries its own justification — which policy, which finding, which
 * recommendation — because a plan that cannot say why it exists is exactly
 * the opaque automation this phase is built to avoid.
 */
export interface MediaRemediationPlan {
  id: string;

  entityType: string;
  entityId: string;
  /** Denormalized from the projection for rendering; never authoritative. */
  title: string | null;
  year: number | null;

  findingId: string | null;
  recommendationId: string | null;
  policyId: string | null;
  /** Why this plan exists, in the operator's terms. */
  policyName: string | null;
  findingCode: string | null;

  type: string;
  status: RemediationPlanStatus;
  riskClass: RemediationRiskClass;

  /** Set whenever `status` is `blocked`. Humanized at the edge. */
  blockReason: RemediationBlockReason | null;
  /** True when the blocker survives approval — knowledge, not consent. */
  blockSurvivesApproval: boolean;

  /** Bounded, scalar. What the plan intends and what it rests on. */
  explanation: Record<string, unknown>;

  steps: MediaRemediationPlanStep[];

  approvedById: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  /** True when a material input moved after approval; re-approval required. */
  approvalInvalidated: boolean;

  expiresAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  supersededAt: string | null;
  supersededReason: string | null;

  failureClass: RemediationFailureClass | null;
  failureMessage: string | null;

  createdAt: string;
  updatedAt: string;
}

export interface MediaRemediationPlanListResult {
  items: MediaRemediationPlan[];
  total: number;
  page: number;
  pageSize: number;
}

/** Counts for the remediation overview. Same predicate as the list. */
export interface MediaRemediationSummary {
  awaitingApproval: number;
  approved: number;
  executing: number;
  waiting: number;
  blocked: number;
  failed: number;
  /** Completed within the retention window — context, not a queue. */
  recentlySucceeded: number;
}
