import {
  JOB_STATUSES,
  JOB_TRANSITIONS,
  TERMINAL_STATUSES,
  InvalidJobTransitionError,
  assertTransition,
  canTransition,
  isActive,
  isJobStatus,
  isTerminal,
  type JobStatus,
} from './job-status';

describe('job state machine', () => {
  it('defines exactly the 15 standard statuses', () => {
    expect(JOB_STATUSES).toHaveLength(15);
    expect(new Set(JOB_STATUSES).size).toBe(15); // no dups
  });

  it('has a transition entry for every status (matrix is total)', () => {
    for (const s of JOB_STATUSES) {
      expect(JOB_TRANSITIONS[s]).toBeInstanceOf(Set);
    }
  });

  it('only lists valid target statuses in the matrix', () => {
    for (const s of JOB_STATUSES) {
      for (const target of JOB_TRANSITIONS[s]) {
        expect(isJobStatus(target)).toBe(true);
      }
    }
  });

  it('terminal states have no outgoing edges (except failed, which is not terminal)', () => {
    for (const s of TERMINAL_STATUSES) {
      expect(JOB_TRANSITIONS[s].size).toBe(0);
    }
    expect(isTerminal('failed')).toBe(false);
    expect([...JOB_TRANSITIONS.failed]).toEqual(['retrying']);
  });

  it('allows the canonical happy path', () => {
    expect(canTransition('scheduled', 'queued')).toBe(true);
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('running', 'completed_with_warnings')).toBe(true);
  });

  it('allows the cancellation path (never straight running → cancelled)', () => {
    expect(canTransition('running', 'cancelling')).toBe(true);
    expect(canTransition('cancelling', 'cancelled')).toBe(true);
    expect(canTransition('running', 'cancelled')).toBe(false);
  });

  it('allows the pause/resume path', () => {
    expect(canTransition('running', 'pausing')).toBe(true);
    expect(canTransition('pausing', 'paused')).toBe(true);
    expect(canTransition('paused', 'queued')).toBe(true);
    expect(canTransition('paused', 'running')).toBe(true);
  });

  it('allows the retry path but not a direct failed → queued', () => {
    expect(canTransition('failed', 'retrying')).toBe(true);
    expect(canTransition('retrying', 'queued')).toBe(true);
    expect(canTransition('failed', 'queued')).toBe(false);
    expect(canTransition('failed', 'running')).toBe(false);
  });

  it('allows scheduled/waiting/blocked → expired and dependency gating', () => {
    expect(canTransition('scheduled', 'expired')).toBe(true);
    expect(canTransition('queued', 'blocked')).toBe(true);
    expect(canTransition('blocked', 'queued')).toBe(true);
    expect(canTransition('waiting', 'queued')).toBe(true);
  });

  it('treats a self-transition as a no-op (allowed)', () => {
    for (const s of JOB_STATUSES) expect(canTransition(s, s)).toBe(true);
  });

  it('rejects representative invalid transitions', () => {
    const invalid: [JobStatus, JobStatus][] = [
      ['completed', 'running'],
      ['cancelled', 'queued'],
      ['queued', 'completed'],
      ['running', 'queued'],
      ['expired', 'queued'],
      ['skipped', 'running'],
      ['scheduled', 'running'],
      ['completed_with_warnings', 'failed'],
    ];
    for (const [from, to] of invalid) expect(canTransition(from, to)).toBe(false);
  });

  it('assertTransition throws InvalidJobTransitionError with context', () => {
    expect(() => assertTransition('completed', 'running', 'job-1')).toThrow(InvalidJobTransitionError);
    try {
      assertTransition('completed', 'running', 'job-1');
    } catch (e) {
      const err = e as InvalidJobTransitionError;
      expect(err.from).toBe('completed');
      expect(err.to).toBe('running');
      expect(err.jobId).toBe('job-1');
    }
    expect(() => assertTransition('queued', 'running')).not.toThrow();
  });

  it('classifies active vs terminal correctly', () => {
    expect(isActive('running')).toBe(true);
    expect(isActive('queued')).toBe(true);
    expect(isActive('cancelling')).toBe(true);
    expect(isActive('completed')).toBe(false);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('running')).toBe(false);
  });

  it('isJobStatus guards unknown strings', () => {
    expect(isJobStatus('running')).toBe(true);
    expect(isJobStatus('nonsense')).toBe(false);
    expect(isJobStatus(42)).toBe(false);
  });
});
