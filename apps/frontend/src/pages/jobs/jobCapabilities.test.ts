import { describe, expect, it } from 'vitest';
import { jobCapabilities, type JobLike } from './jobCapabilities';

const job = (status: string, caps: Partial<JobLike['capabilities']> = {}): JobLike => ({
  status,
  capabilities: {
    cancellable: false,
    pausable: false,
    resumable: false,
    retryable: false,
    ...caps,
  },
});

const ALL = { cancellable: true, pausable: true, resumable: true, retryable: true };

describe('jobCapabilities', () => {
  it('offers cancel only while the job is still going', () => {
    for (const s of ['scheduled', 'queued', 'waiting', 'blocked', 'running', 'pausing', 'retrying']) {
      expect(jobCapabilities(job(s, ALL))).toContain('cancel');
    }
    for (const s of ['completed', 'failed', 'cancelled', 'paused']) {
      expect(jobCapabilities(job(s, ALL))).not.toContain('cancel');
    }
  });

  it('respects the declared capability, not just the status', () => {
    // A running job whose handler cannot be interrupted must not offer cancel —
    // the flag and the status are an AND, and dropping either was the bug this
    // consolidation exists to make impossible to reintroduce.
    expect(jobCapabilities(job('running', { cancellable: false }))).not.toContain('cancel');
    expect(jobCapabilities(job('running', { cancellable: true }))).toContain('cancel');
  });

  it('pauses only what is running and resumes only what is paused', () => {
    expect(jobCapabilities(job('running', ALL))).toContain('pause');
    expect(jobCapabilities(job('paused', ALL))).not.toContain('pause');
    expect(jobCapabilities(job('paused', ALL))).toContain('resume');
    expect(jobCapabilities(job('running', ALL))).not.toContain('resume');
  });

  it('retries only a failure', () => {
    expect(jobCapabilities(job('failed', ALL))).toContain('retry');
    expect(jobCapabilities(job('completed', ALL))).not.toContain('retry');
  });

  it('reruns anything finished, whatever its flags', () => {
    // Rerun makes a NEW job from the old input, so it needs no capability flag
    // — only that there is nothing left to interrupt.
    for (const s of ['completed', 'completed_with_warnings', 'failed', 'cancelled', 'skipped', 'expired']) {
      expect(jobCapabilities(job(s))).toContain('rerun');
    }
    expect(jobCapabilities(job('running', ALL))).not.toContain('rerun');
  });

  it('advertises nothing for a running job whose handler supports nothing', () => {
    // What makes the toolbar correct: a selection of these offers no action at
    // all, rather than a live Cancel over work that cannot be interrupted.
    expect(jobCapabilities(job('running'))).toEqual([]);
  });

  it('never advertises a token outside the known set', () => {
    const known = new Set(['cancel', 'pause', 'resume', 'retry', 'rerun']);
    for (const s of ['running', 'paused', 'failed', 'completed', 'queued', 'nonsense']) {
      for (const token of jobCapabilities(job(s, ALL))) expect(known).toContain(token);
    }
  });

  it('advertises nothing for a status it does not recognise', () => {
    // A status added server-side that this has not learned yet must withhold
    // actions rather than guess — offering Cancel on an unknown state is how a
    // new lifecycle phase becomes a data-loss bug.
    expect(jobCapabilities(job('some_future_status', ALL))).toEqual([]);
  });
});
