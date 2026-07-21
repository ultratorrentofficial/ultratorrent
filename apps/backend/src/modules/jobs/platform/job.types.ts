import type { JobStatus } from './job-status';
import type { SanitizedError } from './job-redaction';

/** Structured-event severity. */
export type JobLevel = 'debug' | 'info' | 'warning' | 'error' | 'success';

/** Structured-event kind (a bounded vocabulary; see PlatformJobEvent). */
export type JobEventType =
  | 'created'
  | 'scheduled'
  | 'queued'
  | 'started'
  | 'heartbeat'
  | 'progress'
  | 'phase_changed'
  | 'child_created'
  | 'dependency_wait'
  | 'warning'
  | 'retry_scheduled'
  | 'pausing'
  | 'paused'
  | 'resumed'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'
  | 'output_available'
  | 'stalled';

/** How a job came to exist. */
export type JobSource = 'manual' | 'scheduled' | 'event' | 'automation' | 'workflow' | 'system';

/** Who can see a job. `module` = holders of the job's requiredPermission; `own` = creator only. */
export type JobVisibility = 'module' | 'own' | 'public';

/** What a handler safely supports. Drives which actions the UI/API offer. */
export interface JobCapabilities {
  cancellable: boolean;
  retryable: boolean;
  pausable: boolean;
  resumable: boolean;
}

/**
 * A module's declaration of a job type. Registered once with the {@link JobRegistry};
 * the Jobs Center reads this metadata and never contains module business logic.
 */
export interface JobDefinition<TInput = unknown, TResult = unknown> {
  /** Globally-unique, namespaced type, e.g. "media.library_scan". */
  type: string;
  moduleKey: string;
  workspaceKey?: string;
  /** i18n keys (jobs namespace) for the type's display name/description. */
  labelKey: string;
  descriptionKey?: string;
  /** Permission a caller/viewer must hold for this job (server-enforced). */
  requiredPermission?: string;
  capabilities: JobCapabilities;
  defaultMaxAttempts?: number;
  defaultTimeoutSeconds?: number;
  defaultPriority?: number;
  visibility?: JobVisibility;
  /** Validate & narrow raw input; throw on invalid. */
  validateInput(input: unknown): TInput;
  /** A small, sanitized, persist-safe summary of the input (no secrets/large blobs). */
  summarizeInput?(input: TInput): Record<string, unknown>;
}

/** Progress snapshot a handler reports. */
export interface JobProgress {
  percent?: number;
  current?: number;
  total?: number;
  unit?: string;
  phase?: string;
  messageKey?: string;
  messageParams?: Record<string, unknown>;
  /** No known total — show an indeterminate bar. */
  indeterminate?: boolean;
}

/** A handler's return value. */
export interface JobResult<TResult = unknown> {
  result?: TResult;
  /** Non-fatal warnings → status becomes completed_with_warnings. */
  warnings?: string[];
  metrics?: Record<string, number>;
  /** A small, sanitized summary persisted on the job (no secrets/large blobs). */
  resultSummary?: Record<string, unknown>;
}

/** Cooperative cancellation, checked by handlers at safe boundaries. */
export interface JobCancellationSignal {
  isCancelled(): boolean;
  /** Throw JobCancelledError if cancellation was requested (call at a safe point). */
  throwIfCancelled(): void;
}

/**
 * Everything a handler needs at run time. Handlers must route all lifecycle/progress
 * changes through this context (never scattered Prisma writes).
 */
export interface JobExecutionContext {
  readonly jobId: string;
  readonly rootJobId: string;
  readonly parentJobId: string | null;
  readonly attempt: number;
  readonly correlationId: string | null;
  /** The user/service the work runs as. */
  readonly runAsUserId: string | null;
  readonly signal: JobCancellationSignal;
  /** Report progress (throttled to the DB; emitted more often over WS). */
  progress(update: JobProgress): Promise<void>;
  /** Set the current phase (emits phase_changed). */
  setPhase(phase: string, messageKey?: string): Promise<void>;
  /** Append a structured event. */
  event(
    eventType: JobEventType,
    opts?: { level?: JobLevel; messageKey?: string; messageParams?: Record<string, unknown>; message?: string; metadata?: Record<string, unknown> },
  ): Promise<void>;
  /** Record a non-fatal warning (bubbles into completed_with_warnings). */
  warn(messageKey: string, params?: Record<string, unknown>): Promise<void>;
  /** Keep-alive so stall detection knows the worker is healthy. */
  heartbeat(): Promise<void>;
  /** Persist a checkpoint (only meaningful for pausable/resumable handlers). */
  saveCheckpoint(checkpoint: unknown): Promise<void>;
  /** Load the last checkpoint (undefined if none). */
  loadCheckpoint<T = unknown>(): Promise<T | undefined>;
  /** Record a metric value. */
  metric(name: string, value: number): void;
}

/** A handler that actually performs a job type's work. */
export interface JobHandler<TInput = unknown, TResult = unknown> {
  execute(input: TInput, context: JobExecutionContext): Promise<JobResult<TResult>>;
  /** Optional: called when a pausable job is asked to pause at a safe boundary. */
  onPause?(context: JobExecutionContext): Promise<void>;
}

/**
 * A job body — the shape of `JobHandler.execute`. Used directly by the legacy-queue
 * adapters, which run a caller's closure as the body while a registered definition
 * supplies the metadata/capabilities.
 */
export type JobExecutor<TInput = unknown, TResult = unknown> = (
  input: TInput,
  context: JobExecutionContext,
) => Promise<JobResult<TResult>>;

/** A registry entry pairs a definition with its handler. */
export interface RegisteredJob<TInput = unknown, TResult = unknown> {
  definition: JobDefinition<TInput, TResult>;
  handler: JobHandler<TInput, TResult>;
}

/** What a producer passes to enqueue a job. */
export interface EnqueueJobInput<TInput = unknown> {
  type: string;
  input: TInput;
  name?: string;
  source?: JobSource;
  sourceId?: string;
  correlationId?: string;
  parentJobId?: string;
  scheduleId?: string;
  resourceType?: string;
  resourceId?: string;
  libraryId?: string;
  mediaItemId?: string;
  createdById?: string;
  runAsUserId?: string;
  priority?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

/** Thrown by a handler when it observes cancellation at a safe boundary. */
export class JobCancelledError extends Error {
  constructor() {
    super('Cancelled by the operator');
    this.name = 'JobCancelledError';
  }
}

export type { SanitizedError, JobStatus };
