/**
 * Server-enforced state machines for the Visual Workflow Builder — the workflow,
 * execution, and node-execution lifecycles. One gate for every transition, so invalid
 * moves throw `InvalidWorkflowTransitionError`. Statuses are plain strings (matching the
 * schema convention); validity is enforced here. Mirrors the Jobs Center's approach.
 */

export class InvalidWorkflowTransitionError extends Error {
  constructor(
    public readonly kind: string,
    public readonly from: string,
    public readonly to: string,
    public readonly id?: string,
  ) {
    super(`Invalid ${kind} transition ${from} → ${to}` + (id ? ` (${id})` : ''));
    this.name = 'InvalidWorkflowTransitionError';
  }
}

interface StateMachine<S extends string> {
  readonly kind: string;
  readonly statuses: readonly S[];
  readonly terminal: ReadonlySet<S>;
  readonly transitions: Readonly<Record<S, ReadonlySet<S>>>;
  is(value: unknown): value is S;
  isTerminal(s: S): boolean;
  canTransition(from: S, to: S): boolean;
  assertTransition(from: S, to: S, id?: string): void;
}

function makeStateMachine<S extends string>(
  kind: string,
  transitions: Record<S, S[]>,
): StateMachine<S> {
  const statuses = Object.keys(transitions) as S[];
  const map = {} as Record<S, ReadonlySet<S>>;
  for (const s of statuses) map[s] = new Set(transitions[s]);
  const terminal = new Set(statuses.filter((s) => map[s].size === 0));
  const set = new Set<string>(statuses);
  return {
    kind,
    statuses,
    terminal,
    transitions: map,
    is: (v): v is S => typeof v === 'string' && set.has(v),
    isTerminal: (s) => terminal.has(s),
    canTransition: (from, to) => from === to || map[from].has(to),
    assertTransition(from, to, id) {
      if (from !== to && !map[from].has(to)) throw new InvalidWorkflowTransitionError(kind, from, to, id);
    },
  };
}

// ── Workflow lifecycle ───────────────────────────────────────────────────────
export type WorkflowStatus =
  | 'draft' | 'validation_failed' | 'ready' | 'published' | 'disabled' | 'archived';

export const WorkflowSM = makeStateMachine<WorkflowStatus>('workflow', {
  draft: ['validation_failed', 'ready', 'archived'],
  validation_failed: ['draft', 'ready', 'archived'],
  ready: ['published', 'draft', 'validation_failed', 'archived'],
  published: ['disabled', 'draft', 'archived'],
  disabled: ['published', 'draft', 'archived'],
  archived: [],
});

// ── Execution lifecycle ──────────────────────────────────────────────────────
export type WorkflowExecutionStatus =
  | 'scheduled' | 'queued' | 'running' | 'waiting' | 'waiting_for_event'
  | 'waiting_for_approval' | 'paused' | 'retrying' | 'completed'
  | 'completed_with_warnings' | 'failed' | 'cancelling' | 'cancelled' | 'expired';

export const ExecutionSM = makeStateMachine<WorkflowExecutionStatus>('execution', {
  scheduled: ['queued', 'cancelled', 'expired'],
  queued: ['running', 'cancelled'],
  running: ['waiting', 'waiting_for_event', 'waiting_for_approval', 'paused', 'retrying', 'completed', 'completed_with_warnings', 'failed', 'cancelling'],
  waiting: ['running', 'cancelling', 'failed', 'expired'],
  waiting_for_event: ['running', 'cancelling', 'failed', 'expired'],
  waiting_for_approval: ['running', 'cancelling', 'failed', 'expired'],
  paused: ['running', 'cancelling'],
  retrying: ['queued', 'running'],
  cancelling: ['cancelled'],
  // terminal
  completed: [],
  completed_with_warnings: [],
  failed: [],
  cancelled: [],
  expired: [],
});

/** Execution states that are not finished (for scheduling/reconciliation queries). */
export const EXECUTION_ACTIVE: ReadonlySet<WorkflowExecutionStatus> = new Set(
  ExecutionSM.statuses.filter((s) => !ExecutionSM.isTerminal(s)),
);

// ── Node-execution lifecycle ─────────────────────────────────────────────────
export type WorkflowNodeStatus =
  | 'pending' | 'blocked' | 'queued' | 'running' | 'waiting' | 'succeeded'
  | 'succeeded_with_warnings' | 'failed' | 'skipped' | 'retrying' | 'cancelled' | 'expired';

export const NodeSM = makeStateMachine<WorkflowNodeStatus>('node', {
  pending: ['blocked', 'queued', 'skipped', 'cancelled'],
  blocked: ['queued', 'skipped', 'cancelled'],
  queued: ['running', 'cancelled', 'skipped'],
  running: ['waiting', 'succeeded', 'succeeded_with_warnings', 'failed', 'retrying', 'cancelled'],
  waiting: ['running', 'failed', 'cancelled', 'expired'],
  retrying: ['queued', 'running'],
  // terminal
  succeeded: [],
  succeeded_with_warnings: [],
  failed: [],
  skipped: [],
  cancelled: [],
  expired: [],
});
