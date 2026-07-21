import {
  WorkflowSM,
  ExecutionSM,
  NodeSM,
  EXECUTION_ACTIVE,
  InvalidWorkflowTransitionError,
} from './workflow-status';

/** A machine viewed with string statuses, so the three can be iterated together. */
interface AnySM {
  kind: string;
  statuses: readonly string[];
  terminal: ReadonlySet<string>;
  transitions: Record<string, ReadonlySet<string>>;
  is(v: unknown): boolean;
  isTerminal(s: string): boolean;
  canTransition(a: string, b: string): boolean;
}

describe('workflow state machines', () => {
  const machines = [WorkflowSM, ExecutionSM, NodeSM] as unknown as AnySM[];

  it('each machine has a total transition map with valid targets only', () => {
    for (const sm of machines) {
      for (const s of sm.statuses) {
        expect(sm.transitions[s]).toBeInstanceOf(Set);
        for (const target of sm.transitions[s]) expect(sm.is(target)).toBe(true);
      }
    }
  });

  it('terminal states have no outgoing edges', () => {
    for (const sm of machines) {
      for (const s of sm.terminal) expect(sm.transitions[s].size).toBe(0);
    }
  });

  it('allows a self-transition (no-op) on every status', () => {
    for (const sm of machines) for (const s of sm.statuses) expect(sm.canTransition(s, s)).toBe(true);
  });

  it('assertTransition throws InvalidWorkflowTransitionError with context', () => {
    expect(() => ExecutionSM.assertTransition('completed', 'running', 'exec-1')).toThrow(InvalidWorkflowTransitionError);
    try {
      ExecutionSM.assertTransition('completed', 'running', 'exec-1');
    } catch (e) {
      const err = e as InvalidWorkflowTransitionError;
      expect(err.kind).toBe('execution');
      expect(err.from).toBe('completed');
      expect(err.to).toBe('running');
      expect(err.id).toBe('exec-1');
    }
  });

  describe('Workflow lifecycle', () => {
    it('walks draft → ready → published → disabled → published', () => {
      expect(WorkflowSM.canTransition('draft', 'ready')).toBe(true);
      expect(WorkflowSM.canTransition('ready', 'published')).toBe(true);
      expect(WorkflowSM.canTransition('published', 'disabled')).toBe(true);
      expect(WorkflowSM.canTransition('disabled', 'published')).toBe(true);
    });
    it('archived is terminal; published cannot jump straight to ready', () => {
      expect(WorkflowSM.isTerminal('archived')).toBe(true);
      expect(WorkflowSM.canTransition('archived', 'draft')).toBe(false);
      expect(WorkflowSM.canTransition('published', 'ready')).toBe(false);
    });
  });

  describe('Execution lifecycle', () => {
    it('supports the wait/approval/resume paths', () => {
      expect(ExecutionSM.canTransition('running', 'waiting_for_event')).toBe(true);
      expect(ExecutionSM.canTransition('running', 'waiting_for_approval')).toBe(true);
      expect(ExecutionSM.canTransition('waiting_for_approval', 'running')).toBe(true);
      expect(ExecutionSM.canTransition('waiting', 'expired')).toBe(true);
      expect(ExecutionSM.canTransition('scheduled', 'queued')).toBe(true);
    });
    it('cancellation goes through cancelling (never running → cancelled directly)', () => {
      expect(ExecutionSM.canTransition('running', 'cancelling')).toBe(true);
      expect(ExecutionSM.canTransition('cancelling', 'cancelled')).toBe(true);
      expect(ExecutionSM.canTransition('running', 'cancelled')).toBe(false);
    });
    it('rejects representative invalid transitions', () => {
      expect(ExecutionSM.canTransition('completed', 'running')).toBe(false);
      expect(ExecutionSM.canTransition('cancelled', 'queued')).toBe(false);
      expect(ExecutionSM.canTransition('queued', 'completed')).toBe(false);
    });
    it('EXECUTION_ACTIVE excludes terminal states', () => {
      expect(EXECUTION_ACTIVE.has('running')).toBe(true);
      expect(EXECUTION_ACTIVE.has('waiting_for_approval')).toBe(true);
      expect(EXECUTION_ACTIVE.has('completed')).toBe(false);
      expect(EXECUTION_ACTIVE.has('failed')).toBe(false);
    });
  });

  describe('Node lifecycle', () => {
    it('supports blocked/waiting/retry and skip', () => {
      expect(NodeSM.canTransition('pending', 'blocked')).toBe(true);
      expect(NodeSM.canTransition('blocked', 'queued')).toBe(true);
      expect(NodeSM.canTransition('running', 'waiting')).toBe(true);
      expect(NodeSM.canTransition('waiting', 'running')).toBe(true);
      expect(NodeSM.canTransition('running', 'retrying')).toBe(true);
      expect(NodeSM.canTransition('retrying', 'queued')).toBe(true);
      expect(NodeSM.canTransition('pending', 'skipped')).toBe(true);
    });
    it('succeeded/skipped/failed are terminal', () => {
      for (const s of ['succeeded', 'succeeded_with_warnings', 'failed', 'skipped', 'cancelled', 'expired'] as const) {
        expect(NodeSM.isTerminal(s)).toBe(true);
      }
      expect(NodeSM.canTransition('succeeded', 'running')).toBe(false);
    });
  });

  it('is guards unknown strings', () => {
    expect(WorkflowSM.is('draft')).toBe(true);
    expect(ExecutionSM.is('nonsense')).toBe(false);
    expect(NodeSM.is(42)).toBe(false);
  });
});
