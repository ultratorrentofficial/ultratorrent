/**
 * What a job can have done to it right now.
 *
 * This replaces two private copies of the same reasoning — `rowActions(job)` in
 * the list and `detailActions(job)` in the detail page — which had already
 * drifted apart in the statuses they accepted. Both derived buttons directly;
 * this derives **capability tokens** instead, and CAMA turns those into buttons.
 *
 * The difference matters: those functions gated correctly on status and not at
 * all on permission, so every viewer saw live Cancel and Retry controls whatever
 * their grants. Advertising capabilities and letting the resolver apply the
 * permission is what closes that without each surface remembering to.
 *
 * Tokens are named for the action (`cancel`) rather than the flag
 * (`cancellable`) because they encode status *and* declared capability: a
 * cancellable job that has already finished advertises nothing.
 */

/** The subset of a job this needs. Kept structural so both DTOs satisfy it. */
export interface JobLike {
  status: string;
  capabilities: {
    cancellable: boolean;
    pausable: boolean;
    resumable: boolean;
    retryable: boolean;
  };
}

/** Statuses where a job is still going and can be stopped. */
const ACTIVE = new Set([
  'scheduled',
  'queued',
  'waiting',
  'blocked',
  'running',
  'pausing',
  'retrying',
]);

/** Statuses where a job is finished, and so can only be run again. */
const TERMINAL = new Set([
  'completed',
  'completed_with_warnings',
  'failed',
  'cancelled',
  'skipped',
  'expired',
]);

export function jobCapabilities(job: JobLike): string[] {
  const caps: string[] = [];
  if (job.capabilities.cancellable && ACTIVE.has(job.status)) caps.push('cancel');
  if (job.capabilities.pausable && job.status === 'running') caps.push('pause');
  if (job.capabilities.resumable && job.status === 'paused') caps.push('resume');
  if (job.capabilities.retryable && job.status === 'failed') caps.push('retry');
  // Rerun is a new job from the old one's input, so it needs no capability flag
  // — only that there is nothing left to interrupt.
  if (TERMINAL.has(job.status)) caps.push('rerun');
  return caps;
}
