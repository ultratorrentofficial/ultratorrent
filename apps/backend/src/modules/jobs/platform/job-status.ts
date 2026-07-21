/**
 * The Unified Jobs Center status model and its server-enforced state machine.
 *
 * Status is a plain string in the DB (matching the schema convention); validity is
 * enforced here, in one place, so every lifecycle transition — from any handler,
 * adapter, or the API — goes through the same gate. See
 * docs/UNIFIED_JOBS_CENTER_ARCHITECTURE_REVIEW.md §15.2.
 */

export const JOB_STATUSES = [
  'scheduled',
  'queued',
  'waiting',
  'blocked',
  'running',
  'pausing',
  'paused',
  'retrying',
  'completed',
  'completed_with_warnings',
  'failed',
  'cancelling',
  'cancelled',
  'skipped',
  'expired',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Terminal states — a job here does no more work (failed can still → retrying). */
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'completed',
  'completed_with_warnings',
  'cancelled',
  'skipped',
  'expired',
]);

/** States that count as "not finished" — used for active/queue-depth queries and reconciliation. */
export const ACTIVE_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'scheduled',
  'queued',
  'waiting',
  'blocked',
  'running',
  'pausing',
  'paused',
  'retrying',
  'cancelling',
]);

/** States in which a job is (or is about to be) executing on a worker. */
export const RUNNING_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'running',
  'pausing',
  'cancelling',
]);

/**
 * The allowed transitions. A key's set lists the states it may move to. Terminal
 * states (except `failed`) have no outgoing edges. Kept deliberately explicit so
 * the matrix is auditable and fully covered by tests.
 */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, ReadonlySet<JobStatus>>> = {
  scheduled: new Set(['queued', 'cancelled', 'expired']),
  queued: new Set(['running', 'waiting', 'blocked', 'cancelled', 'skipped']),
  waiting: new Set(['queued', 'blocked', 'cancelled', 'expired']),
  blocked: new Set(['queued', 'cancelled', 'expired']),
  running: new Set(['completed', 'completed_with_warnings', 'failed', 'cancelling', 'pausing']),
  pausing: new Set(['paused', 'running', 'failed', 'cancelling']),
  paused: new Set(['queued', 'running', 'cancelled']),
  retrying: new Set(['queued']),
  failed: new Set(['retrying']),
  cancelling: new Set(['cancelled']),
  // Terminal
  completed: new Set([]),
  completed_with_warnings: new Set([]),
  cancelled: new Set([]),
  skipped: new Set([]),
  expired: new Set([]),
};

/** Thrown when a lifecycle change would violate the state machine. */
export class InvalidJobTransitionError extends Error {
  constructor(
    public readonly from: JobStatus,
    public readonly to: JobStatus,
    public readonly jobId?: string,
  ) {
    super(
      `Invalid job status transition ${from} → ${to}` + (jobId ? ` (job ${jobId})` : ''),
    );
    this.name = 'InvalidJobTransitionError';
  }
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

/** Whether `to` is a legal next status from `from` (a self-transition is a no-op, allowed). */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return true;
  return JOB_TRANSITIONS[from].has(to);
}

/** Assert a transition is legal; throws {@link InvalidJobTransitionError} otherwise. */
export function assertTransition(from: JobStatus, to: JobStatus, jobId?: string): void {
  if (!canTransition(from, to)) throw new InvalidJobTransitionError(from, to, jobId);
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isActive(status: JobStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}
