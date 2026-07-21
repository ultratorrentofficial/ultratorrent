import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { PlatformJob, Prisma } from '@prisma/client';
import { WS_EVENTS, type JobEventPayload } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { JobRegistry } from './job-registry.service';
import {
  ACTIVE_STATUSES,
  assertTransition,
  isTerminal,
  type JobStatus,
} from './job-status';
import { redact, sanitizeError } from './job-redaction';
import {
  JobCancelledError,
  JobPausedError,
  type EnqueueJobInput,
  type JobEventType,
  type JobExecutionContext,
  type JobExecutor,
  type JobLevel,
  type JobProgress,
  type JobResult,
} from './job.types';
import { PROGRESS_THROTTLE_MS } from './job-constants';

/** Backoff policy persisted on a job (all optional; sensible defaults applied). */
interface RetryPolicy {
  baseMs?: number;
  factor?: number;
  maxMs?: number;
}

/**
 * The heart of the Unified Jobs Center: the single writer of `platform_jobs` and
 * `platform_job_events`. Every lifecycle change, progress update, and structured
 * event flows through here, so the server-enforced state machine (job-status.ts)
 * and secret redaction (job-redaction.ts) apply uniformly, whatever module produced
 * the job. Handlers never touch job rows directly — they get a {@link JobExecutionContext}.
 *
 * Execution is in-process (matching the existing engines — no external broker); the
 * contract is designed so a future durable worker can run the same handlers. Real-time
 * WS emission is layered on in Phase 4; here we persist the authoritative record.
 */
@Injectable()
export class PlatformJobService implements OnModuleInit {
  private readonly logger = new Logger(PlatformJobService.name);
  /** Jobs this process is executing — the only ones it can cooperatively cancel. */
  private readonly running = new Set<string>();
  private readonly cancelRequested = new Set<string>();
  private readonly pauseRequested = new Set<string>();
  /** Per-job monotonic event sequence, seeded lazily. */
  private readonly seq = new Map<string, number>();
  private readonly lastProgressAt = new Map<string, number>();
  private readonly warnings = new Map<string, string[]>();
  private readonly metrics = new Map<string, Record<string, number>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistry,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Emit a `jobs.*` event scoped to the job's own required permission. */
  private emitRow(row: PlatformJob | (Partial<PlatformJob> & { id: string; type: string; moduleKey: string; status: string; requiredPermission: string | null }), wsEvent: string, message?: string): void {
    const payload: JobEventPayload = {
      jobId: row.id,
      type: row.type,
      moduleKey: row.moduleKey,
      workspaceKey: row.workspaceKey ?? null,
      status: row.status,
      phase: row.phase ?? null,
      progress: row.progressPercent ?? null,
      parentJobId: row.parentJobId ?? null,
      rootJobId: row.rootJobId ?? null,
      correlationId: row.correlationId ?? null,
      errorCode: row.errorCode ?? null,
      message: message ?? null,
      at: new Date().toISOString(),
    };
    try {
      this.realtime.emitToPermission(row.requiredPermission ?? null, wsEvent, payload);
    } catch {
      /* realtime is best-effort */
    }
  }

  /** Fetch the scoping fields for a job id and emit a `jobs.*` event. */
  private async notify(jobId: string, wsEvent: string, message?: string): Promise<void> {
    const row = await this.prisma.platformJob
      .findUnique({
        where: { id: jobId },
        select: { id: true, type: true, moduleKey: true, workspaceKey: true, status: true, phase: true, progressPercent: true, parentJobId: true, rootJobId: true, correlationId: true, errorCode: true, requiredPermission: true },
      })
      .catch(() => null);
    if (row) this.emitRow(row as never, wsEvent, message);
  }

  /**
   * Reconcile orphaned platform jobs at boot. In-process bodies do not survive a
   * restart, so any row left in a running/pausing/cancelling state belongs to a
   * dead process — fail it out (mirrors the legacy engines' behaviour).
   */
  async onModuleInit(): Promise<void> {
    try {
      const { count } = await this.prisma.platformJob.updateMany({
        where: { status: { in: ['running', 'pausing', 'cancelling'] } },
        data: { status: 'failed', failedAt: new Date(), errorCode: 'interrupted', errorMessage: 'Interrupted by a service restart' },
      });
      if (count > 0) this.logger.warn(`Reconciled ${count} orphaned platform job(s) from a previous process`);
    } catch (err) {
      this.logger.warn(`Could not reconcile orphaned platform jobs: ${(err as Error).message}`);
    }
  }

  // ── Producer API ───────────────────────────────────────────────────────────

  /** Create a queued (or scheduled) job row from a registered definition. */
  async enqueue<TInput>(input: EnqueueJobInput<TInput>): Promise<PlatformJob> {
    const def = this.registry.getDefinition(input.type);
    const validated = def.validateInput(input.input);

    // Idempotency: an active job with the same key returns instead of duplicating.
    if (input.idempotencyKey) {
      const existing = await this.prisma.platformJob.findFirst({
        where: { idempotencyKey: input.idempotencyKey, status: { in: [...ACTIVE_STATUSES] } },
      });
      if (existing) return existing;
    }

    const rootJobId = input.parentJobId ? await this.rootOf(input.parentJobId) : undefined;
    const inputSummary = def.summarizeInput ? redact(def.summarizeInput(validated)) : undefined;
    const status: JobStatus = 'queued';

    const job = await this.prisma.platformJob.create({
      data: {
        type: def.type,
        name: input.name ?? null,
        moduleKey: def.moduleKey,
        workspaceKey: def.workspaceKey ?? null,
        sourceType: input.source ?? 'manual',
        sourceId: input.sourceId ?? null,
        correlationId: input.correlationId ?? null,
        parentJobId: input.parentJobId ?? null,
        rootJobId: rootJobId ?? null, // self-root set below once id exists
        scheduleId: input.scheduleId ?? null,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        libraryId: input.libraryId ?? null,
        mediaItemId: input.mediaItemId ?? null,
        status,
        cancellable: def.capabilities.cancellable,
        pausable: def.capabilities.pausable,
        resumable: def.capabilities.resumable,
        retryable: def.capabilities.retryable,
        priority: input.priority ?? def.defaultPriority ?? 0,
        maxAttempts: input.maxAttempts ?? def.defaultMaxAttempts ?? 1,
        timeoutSeconds: def.defaultTimeoutSeconds ?? null,
        visibilityScope: def.visibility ?? 'module',
        requiredPermission: def.requiredPermission ?? null,
        createdById: input.createdById ?? null,
        runAsUserId: input.runAsUserId ?? input.createdById ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        inputData: (validated ?? undefined) as Prisma.InputJsonValue | undefined,
        inputSummary: (inputSummary ?? undefined) as Prisma.InputJsonValue | undefined,
        metadata: (input.metadata ? redact(input.metadata) : undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    // A root job is its own root.
    if (!job.rootJobId) {
      await this.prisma.platformJob.update({ where: { id: job.id }, data: { rootJobId: job.id } });
    }
    await this.recordEvent(job.id, 'created', { level: 'info' });
    await this.recordEvent(job.id, 'queued', { level: 'info' });
    this.emitRow(job, WS_EVENTS.JOB_CREATED);
    this.emitRow(job, WS_EVENTS.JOB_QUEUED);
    if (job.parentJobId) this.emitRow(job, WS_EVENTS.JOB_CHILD_CREATED);
    return job;
  }

  /**
   * Enqueue and run to completion, awaiting the result. Input is carried in memory
   * (the row persists only a redacted summary). An optional `executor` overrides the
   * registered handler — this is how the legacy-queue adapters run a caller's closure
   * as the job body while still getting a registered definition's metadata/capabilities.
   */
  async run<TInput, TResult = unknown>(
    input: EnqueueJobInput<TInput>,
    executor?: JobExecutor<TInput, TResult>,
  ): Promise<{ jobId: string; result?: TResult }> {
    const job = await this.enqueue(input);
    this.running.add(job.id);
    const result = await this.runHandler(job, input.input, executor);
    return { jobId: job.id, result };
  }

  /** Enqueue and run in the background; returns immediately with the job id. */
  async runDetached<TInput, TResult = unknown>(
    input: EnqueueJobInput<TInput>,
    executor?: JobExecutor<TInput, TResult>,
  ): Promise<{ jobId: string }> {
    const job = await this.enqueue(input);
    this.running.add(job.id); // registered before the async body so an early cancel isn't dropped
    void this.runHandler(job, input.input, executor).catch((err) =>
      this.logger.error(`Job ${job.id} execution error: ${(err as Error).message}`),
    );
    return { jobId: job.id };
  }

  /**
   * The single execution path: run the body, retrying on retryable failures with
   * backoff up to `maxAttempts`, honouring cooperative cancel and pause. A retry
   * walks the real state machine (running → failed → retrying → queued → running),
   * so the record and events reflect every attempt.
   */
  private async runHandler<TInput, TResult>(
    job: PlatformJob,
    rawInput: TInput,
    executor?: JobExecutor<TInput, TResult>,
  ): Promise<TResult | undefined> {
    const jobId = job.id;
    const { handler, definition } = this.registry.get(job.type);
    const body = executor ?? (handler.execute.bind(handler) as JobExecutor<TInput, TResult>);
    const maxAttempts = job.maxAttempts ?? 1;
    let attempt = job.attempt ?? 1;
    this.running.add(jobId);
    try {
      while (true) {
        const started = await this.transition(jobId, 'running', {
          startedAt: new Date(),
          heartbeatAt: new Date(),
          attempt,
        });
        await this.recordEvent(jobId, 'started', { level: 'info', metadata: attempt > 1 ? { attempt } : undefined });
        this.emitRow(started, WS_EVENTS.JOB_STARTED);
        const ctx = this.buildContext(started);
        try {
          const input = definition.validateInput(rawInput) as TInput;
          const out = ((await body(input, ctx)) ?? {}) as JobResult<TResult>;
          await this.finishSuccess(jobId, out);
          return out.result;
        } catch (err) {
          if (err instanceof JobCancelledError) {
            await this.markCancelled(jobId);
            throw err;
          }
          if (err instanceof JobPausedError) {
            await this.markPaused(jobId);
            return undefined; // paused is not a failure and not a rejection
          }
          const canRetry = job.retryable && attempt < maxAttempts && this.isRetryable(err);
          if (!canRetry) {
            await this.markFailed(jobId, err);
            throw err;
          }
          // Record the failed attempt, then schedule a retry through the state machine.
          const sanitized = sanitizeError(err);
          attempt += 1;
          const delayMs = this.backoff(job, attempt);
          await this.safeTransition(jobId, 'failed', { failedAt: new Date(), errorCode: sanitized.code, errorMessage: sanitized.message });
          await this.recordEvent(jobId, 'retry_scheduled', { level: 'warning', metadata: { attempt, delayMs } });
          await this.safeTransition(jobId, 'retrying', { attempt, retryAt: new Date(Date.now() + delayMs) });
          await this.notify(jobId, WS_EVENTS.JOB_RETRYING);
          await this.safeTransition(jobId, 'queued');
          await this.delay(delayMs);
          if (this.cancelRequested.has(jobId)) {
            await this.markCancelled(jobId);
            throw new JobCancelledError();
          }
          // loop: next iteration transitions queued → running for the new attempt
        }
      }
    } finally {
      this.running.delete(jobId);
      this.cancelRequested.delete(jobId);
      this.pauseRequested.delete(jobId);
      this.seq.delete(jobId);
      this.lastProgressAt.delete(jobId);
      this.warnings.delete(jobId);
      this.metrics.delete(jobId);
    }
  }

  private isRetryable(err: unknown): boolean {
    if (err && typeof err === 'object' && 'retryable' in err) {
      return (err as { retryable?: boolean }).retryable !== false;
    }
    return true;
  }

  private backoff(job: PlatformJob, attempt: number): number {
    const policy = (job.retryPolicy as RetryPolicy | null) ?? {};
    const base = policy.baseMs ?? 1000;
    const factor = policy.factor ?? 2;
    const max = policy.maxMs ?? 60_000;
    return Math.min(max, Math.round(base * Math.pow(factor, Math.max(0, attempt - 2))));
  }

  /** Overridable in tests. */
  protected delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async markPaused(jobId: string): Promise<void> {
    await this.safeTransition(jobId, 'pausing');
    await this.safeTransition(jobId, 'paused', { pausedAt: new Date() });
    await this.recordEvent(jobId, 'paused', { level: 'info' });
    await this.notify(jobId, WS_EVENTS.JOB_PAUSED);
  }

  // ── Control ────────────────────────────────────────────────────────────────

  /**
   * Request cooperative cancellation. A job this process is running is flagged (its
   * handler stops at a safe boundary); a still-queued job is cancelled immediately.
   * Returns whether the request was actionable.
   */
  async requestCancel(jobId: string): Promise<boolean> {
    if (this.running.has(jobId)) {
      this.cancelRequested.add(jobId);
      await this.safeTransition(jobId, 'cancelling');
      await this.recordEvent(jobId, 'cancelling', { level: 'info' });
      await this.notify(jobId, WS_EVENTS.JOB_CANCELLING);
      return true;
    }
    const job = await this.prisma.platformJob.findUnique({ where: { id: jobId }, select: { status: true } });
    const status = job?.status as JobStatus | undefined;
    if (status === 'queued' || status === 'scheduled' || status === 'waiting' || status === 'blocked' || status === 'paused') {
      await this.transition(jobId, 'cancelled', { cancelledAt: new Date() });
      await this.recordEvent(jobId, 'cancelled', { level: 'info' });
      await this.notify(jobId, WS_EVENTS.JOB_CANCELLED);
      return true;
    }
    return false;
  }

  /**
   * Request a pause. Only meaningful for a `pausable` job this process is running:
   * the handler checkpoints and stops at a safe boundary (throws JobPausedError).
   * Returns whether the request was actionable.
   */
  async requestPause(jobId: string): Promise<boolean> {
    const job = await this.prisma.platformJob.findUnique({ where: { id: jobId }, select: { pausable: true, status: true } });
    if (!job?.pausable || !this.running.has(jobId)) return false;
    this.pauseRequested.add(jobId);
    await this.safeTransition(jobId, 'pausing');
    await this.recordEvent(jobId, 'pausing', { level: 'info' });
    return true;
  }

  /**
   * Resume a paused job from its checkpoint. Re-executes the handler (which loads
   * the checkpoint via the context) using the persisted input. Returns the new run's
   * job id (same job) or null if not resumable.
   */
  async resume(jobId: string): Promise<{ jobId: string } | null> {
    const job = await this.prisma.platformJob.findUnique({ where: { id: jobId } });
    if (!job || job.status !== 'paused' || !job.resumable) return null;
    await this.transition(jobId, 'queued', { resumedAt: new Date() });
    await this.recordEvent(jobId, 'resumed', { level: 'info' });
    await this.notify(jobId, WS_EVENTS.JOB_RESUMED);
    this.running.add(jobId);
    void this.runHandler(job, job.inputData, undefined).catch((err) =>
      this.logger.error(`Resume of ${jobId} errored: ${(err as Error).message}`),
    );
    return { jobId };
  }

  /**
   * Manually retry a FAILED job — re-execute the same job (preserving its attempt
   * history) from its persisted input. Returns the job id, or null if not retriable.
   * Distinct from {@link rerun}, which creates a new linked job.
   */
  async retry(jobId: string): Promise<{ jobId: string } | null> {
    const job = await this.prisma.platformJob.findUnique({ where: { id: jobId } });
    if (!job || job.status !== 'failed') return null;
    if (job.inputData == null) return null;
    const nextAttempt = (job.attempt ?? 1) + 1;
    await this.transition(jobId, 'retrying', { attempt: nextAttempt });
    await this.recordEvent(jobId, 'retry_scheduled', { level: 'info', metadata: { manual: true, attempt: nextAttempt } });
    await this.transition(jobId, 'queued');
    this.running.add(jobId);
    void this.runHandler({ ...job, attempt: nextAttempt, status: 'queued' }, job.inputData, undefined).catch((err) =>
      this.logger.error(`Manual retry of ${jobId} errored: ${(err as Error).message}`),
    );
    return { jobId };
  }

  /**
   * Rerun a finished job: create a NEW linked job from the original's persisted input
   * (revalidated by the definition), preserving the source relationship. Returns the
   * new job id. Never mutates the original.
   */
  async rerun(jobId: string, actorUserId?: string): Promise<{ jobId: string }> {
    const original = await this.prisma.platformJob.findUnique({ where: { id: jobId } });
    if (!original) throw new Error(`Job ${jobId} not found`);
    if (original.inputData == null) throw new Error(`Job ${jobId} cannot be rerun — no persisted input`);
    return this.runDetached({
      type: original.type,
      input: original.inputData,
      name: original.name ?? undefined,
      source: 'manual',
      correlationId: original.correlationId ?? undefined,
      resourceType: original.resourceType ?? undefined,
      resourceId: original.resourceId ?? undefined,
      libraryId: original.libraryId ?? undefined,
      mediaItemId: original.mediaItemId ?? undefined,
      createdById: actorUserId ?? original.createdById ?? undefined,
      metadata: { rerunOfJobId: jobId },
    });
  }

  // ── Lifecycle writers (the only place status changes) ────────────────────────

  /** Move a job to `to`, enforcing the state machine. Extra columns applied atomically. */
  async transition(jobId: string, to: JobStatus, data: Prisma.PlatformJobUpdateInput = {}): Promise<PlatformJob> {
    const current = await this.prisma.platformJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (!current) throw new Error(`Job ${jobId} not found`);
    assertTransition(current.status as JobStatus, to, jobId);
    return this.prisma.platformJob.update({ where: { id: jobId }, data: { status: to, ...data } });
  }

  /** Like {@link transition} but swallows an invalid-transition (best-effort control paths). */
  private async safeTransition(jobId: string, to: JobStatus, data: Prisma.PlatformJobUpdateInput = {}): Promise<void> {
    try {
      await this.transition(jobId, to, data);
    } catch (err) {
      this.logger.debug(`safeTransition ${jobId} → ${to} skipped: ${(err as Error).message}`);
    }
  }

  private async finishSuccess(jobId: string, out: JobResult): Promise<void> {
    const collectedWarnings = [...(this.warnings.get(jobId) ?? []), ...(out.warnings ?? [])];
    const metrics = { ...(this.metrics.get(jobId) ?? {}), ...(out.metrics ?? {}) };
    const withWarnings = collectedWarnings.length > 0;
    const to: JobStatus = withWarnings ? 'completed_with_warnings' : 'completed';
    const row = await this.transition(jobId, to, {
      completedAt: new Date(),
      progressPercent: 100,
      warnings: collectedWarnings.length ? (redact(collectedWarnings) as Prisma.InputJsonValue) : undefined,
      metrics: Object.keys(metrics).length ? (metrics as Prisma.InputJsonValue) : undefined,
      resultSummary: out.resultSummary ? (redact(out.resultSummary) as Prisma.InputJsonValue) : undefined,
    });
    if (withWarnings) await this.recordEvent(jobId, 'warning', { level: 'warning', metadata: { count: collectedWarnings.length } });
    await this.recordEvent(jobId, 'completed', { level: 'success' });
    this.emitRow(row, WS_EVENTS.JOB_COMPLETED);
  }

  private async markFailed(jobId: string, err: unknown): Promise<void> {
    const sanitized = sanitizeError(err);
    await this.safeTransition(jobId, 'failed', {
      failedAt: new Date(),
      errorCode: sanitized.code,
      errorMessage: sanitized.message,
    });
    await this.recordEvent(jobId, 'failed', { level: 'error', message: sanitized.message });
    await this.notify(jobId, WS_EVENTS.JOB_FAILED, sanitized.message);
  }

  private async markCancelled(jobId: string): Promise<void> {
    await this.safeTransition(jobId, 'cancelled', { cancelledAt: new Date() });
    await this.recordEvent(jobId, 'cancelled', { level: 'info' });
    await this.notify(jobId, WS_EVENTS.JOB_CANCELLED);
  }

  /** Broadcast a stalled event (called by the reliability scanner). */
  async broadcastStalled(jobId: string): Promise<void> {
    await this.notify(jobId, WS_EVENTS.JOB_STALLED);
  }

  /** Append a structured event with a monotonic per-job sequence. */
  async recordEvent(
    jobId: string,
    eventType: JobEventType,
    opts: { level?: JobLevel; messageKey?: string; messageParams?: Record<string, unknown>; message?: string; progress?: number; metadata?: Record<string, unknown> } = {},
  ): Promise<void> {
    const sequence = await this.nextSeq(jobId);
    await this.prisma.platformJobEvent
      .create({
        data: {
          jobId,
          sequence,
          level: opts.level ?? 'info',
          eventType,
          messageKey: opts.messageKey ?? null,
          messageParams: (opts.messageParams ? redact(opts.messageParams) : undefined) as Prisma.InputJsonValue | undefined,
          sanitizedMessage: opts.message ? sanitizeError(new Error(opts.message)).message : null,
          progress: opts.progress ?? null,
          metadata: (opts.metadata ? redact(opts.metadata) : undefined) as Prisma.InputJsonValue | undefined,
        },
      })
      .catch((e) => this.logger.debug(`event persist failed for ${jobId}: ${(e as Error).message}`));
  }

  private async nextSeq(jobId: string): Promise<number> {
    let n = this.seq.get(jobId);
    if (n === undefined) {
      const last = await this.prisma.platformJobEvent.findFirst({
        where: { jobId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      n = last?.sequence ?? 0;
    }
    n += 1;
    this.seq.set(jobId, n);
    return n;
  }

  private async rootOf(parentJobId: string): Promise<string> {
    const parent = await this.prisma.platformJob.findUnique({ where: { id: parentJobId }, select: { rootJobId: true, id: true } });
    return parent?.rootJobId ?? parent?.id ?? parentJobId;
  }

  // ── Execution context ────────────────────────────────────────────────────────

  private buildContext(job: PlatformJob): JobExecutionContext {
    const jobId = job.id;
    const signal = {
      isCancelled: () => this.cancelRequested.has(jobId),
      throwIfCancelled: () => {
        if (this.cancelRequested.has(jobId)) throw new JobCancelledError();
      },
    };
    return {
      jobId,
      rootJobId: job.rootJobId ?? job.id,
      parentJobId: job.parentJobId,
      attempt: job.attempt,
      correlationId: job.correlationId,
      runAsUserId: job.runAsUserId,
      signal,
      progress: (u) => this.applyProgress(jobId, u),
      setPhase: async (phase, messageKey) => {
        await this.prisma.platformJob.update({ where: { id: jobId }, data: { phase, statusMessageKey: messageKey ?? undefined } });
        await this.recordEvent(jobId, 'phase_changed', { level: 'info', messageKey, metadata: { phase } });
      },
      event: (eventType, o) => this.recordEvent(jobId, eventType, o),
      warn: async (messageKey, params) => {
        const list = this.warnings.get(jobId) ?? [];
        list.push(messageKey);
        this.warnings.set(jobId, list);
        await this.recordEvent(jobId, 'warning', { level: 'warning', messageKey, messageParams: params });
      },
      heartbeat: async () => {
        await this.prisma.platformJob.update({ where: { id: jobId }, data: { heartbeatAt: new Date() } }).catch(() => undefined);
      },
      saveCheckpoint: async (checkpoint) => {
        await this.prisma.platformJob.update({
          where: { id: jobId },
          data: { checkpoint: redact(checkpoint) as Prisma.InputJsonValue, checkpointVersion: { increment: 1 } },
        });
      },
      loadCheckpoint: async <T = unknown>() => {
        const row = await this.prisma.platformJob.findUnique({ where: { id: jobId }, select: { checkpoint: true } });
        return (row?.checkpoint as T) ?? undefined;
      },
      metric: (name, value) => {
        const m = this.metrics.get(jobId) ?? {};
        m[name] = value;
        this.metrics.set(jobId, m);
      },
      isPauseRequested: () => this.pauseRequested.has(jobId),
    };
  }

  /** Persist progress, throttled per job to bound DB writes; always persists terminal 100%. */
  private async applyProgress(jobId: string, u: JobProgress): Promise<void> {
    const now = Date.now();
    const last = this.lastProgressAt.get(jobId) ?? 0;
    if (now - last < PROGRESS_THROTTLE_MS && (u.percent ?? 0) < 100) return;
    this.lastProgressAt.set(jobId, now);
    const percent = u.percent != null ? Math.max(0, Math.min(100, Math.round(u.percent))) : undefined;
    const row = await this.prisma.platformJob
      .update({
        where: { id: jobId },
        data: {
          progressPercent: percent,
          progressCurrent: u.current ?? undefined,
          progressTotal: u.total ?? undefined,
          progressUnit: u.unit ?? undefined,
          phase: u.phase ?? undefined,
          statusMessageKey: u.messageKey ?? undefined,
          statusMessageParams: (u.messageParams ? redact(u.messageParams) : undefined) as Prisma.InputJsonValue | undefined,
        },
      })
      .catch(() => null);
    if (row) this.emitRow(row, u.phase ? WS_EVENTS.JOB_PHASE_CHANGED : WS_EVENTS.JOB_PROGRESS);
    await this.recordEvent(jobId, 'progress', { level: 'debug', progress: percent, metadata: u.phase ? { phase: u.phase } : undefined });
  }

  /** Whether a job id is being executed by this process (for adapters/tests). */
  isRunningHere(jobId: string): boolean {
    return this.running.has(jobId);
  }
}
