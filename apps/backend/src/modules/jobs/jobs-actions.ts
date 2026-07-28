/**
 * What can be done to a job — declared, not derived per surface.
 *
 * The Jobs Center already resolved actions from state, in two private copies
 * (`rowActions(job)` in the list, `detailActions(job)` in the detail page). Both
 * gated correctly on job status and **neither gated on permission at all**, so
 * every viewer saw live Cancel and Retry buttons regardless of their grants.
 *
 * These declarations close that: the permission is checked by the server when
 * building the catalogue, and the state check becomes a capability the row
 * advertises (`jobCapabilities()` on the client) rather than a branch each
 * surface writes for itself.
 *
 * **The server still enforces more than this can.** `assertUnderlyingPermission`
 * requires the caller to hold the *job's own* `requiredPermission` as well —
 * holding `jobs.cancel` does not let you cancel a job whose work you could not
 * have started. That is per-job and cannot be answered by a static catalogue, so
 * it stays where it is: CAMA offers the action, the endpoint refuses the ones
 * this particular caller may not run.
 */
import { PERMISSIONS } from '@ultratorrent/shared';
import type { ActionDescriptor, EntityType } from '@ultratorrent/shared';

const P = PERMISSIONS;

/** How many jobs one bulk request may carry, mirroring the controller. */
const MAX_BULK_JOBS = 200;

/**
 * Capability tokens a job row advertises. Named for the action rather than the
 * flag (`cancel`, not `cancellable`) because they encode status *and* the
 * declared capability: a cancellable job that already finished advertises
 * nothing.
 */
export const JOB_CAPABILITY_TOKENS = ['cancel', 'pause', 'resume', 'retry', 'rerun'] as const;

const base = {
  group: 'maintenance',
  entityTypes: ['job'] as EntityType[],
  /*
   * Arity is per action, not shared: the Jobs Center has bulk routes for
   * cancel/retry/rerun ONLY. Declaring pause and resume as `any` advertised a
   * bulk capability the API does not have.
   */
  /*
   * No `module` constraint on purpose. The Jobs Center ships controllers and
   * permissions but has no module manifest — like Indexers, Workflows and the
   * renamer, it is gated purely by RBAC (docs/MODULES.md). Naming a module that
   * does not exist would withhold every one of these actions, since an absent
   * module is never enabled.
   */
  /*
   * Disabled rather than hidden.
   *
   * A job list is a place people come to *do* these things, and a Cancel that
   * silently vanishes when a job finishes reads as the UI losing a feature. The
   * disabled control with its reason is what tells them the job is already done.
   */
  whenUnavailable: 'disable',
} as const;

export const JOB_ACTIONS: ActionDescriptor[] = [
  // --- one job: POST jobs/:id/<verb> ------------------------------------
  { ...base, arity: 'single', id: 'jobs.cancel', permissions: [P.JOBS_CANCEL], requiresEntityCapability: 'cancel', icon: 'Ban', destructive: true, order: 10 },
  { ...base, arity: 'single', id: 'jobs.pause', permissions: [P.JOBS_PAUSE], requiresEntityCapability: 'pause', icon: 'Pause', order: 20 },
  { ...base, arity: 'single', id: 'jobs.resume', permissions: [P.JOBS_RESUME], requiresEntityCapability: 'resume', icon: 'Play', order: 30 },
  { ...base, arity: 'single', id: 'jobs.retry', permissions: [P.JOBS_RETRY], requiresEntityCapability: 'retry', icon: 'RotateCw', order: 40 },
  { ...base, arity: 'single', id: 'jobs.rerun', permissions: [P.JOBS_RERUN], requiresEntityCapability: 'rerun', icon: 'RefreshCw', order: 50 },

  /*
   * --- many jobs: POST jobs/bulk/<verb> ---------------------------------
   *
   * Separate declarations because the bulk routes require `jobs.bulk_manage`
   * IN ADDITION to the verb. Declaring one action across both meant a user
   * holding `jobs.cancel` alone got a working row button and a 403 on any
   * multi-selection — same action, same enabled state, different outcome by
   * selection size. There is deliberately no bulk pause or resume: the API has
   * none.
   */
  { ...base, arity: 'multi', maxSelection: MAX_BULK_JOBS, id: 'jobs.cancelBulk', permissions: [P.JOBS_BULK_MANAGE, P.JOBS_CANCEL], requiresEntityCapability: 'cancel', icon: 'Ban', destructive: true, order: 10 },
  { ...base, arity: 'multi', maxSelection: MAX_BULK_JOBS, id: 'jobs.retryBulk', permissions: [P.JOBS_BULK_MANAGE, P.JOBS_RETRY], requiresEntityCapability: 'retry', icon: 'RotateCw', order: 40 },
  { ...base, arity: 'multi', maxSelection: MAX_BULK_JOBS, id: 'jobs.rerunBulk', permissions: [P.JOBS_BULK_MANAGE, P.JOBS_RERUN], requiresEntityCapability: 'rerun', icon: 'RefreshCw', order: 50 },
];
