import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  canTransition,
  isActiveIntake,
  TERMINAL_INTAKE_STATES,
  type IntakeState,
} from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface EnqueueInput {
  profileId: string;
  sourcePath: string;
  torrentHash?: string | null;
  engineId?: string | null;
  /** Overrides the derived key; supply one for non-torrent sources. */
  idempotencyKey?: string;
}

/**
 * The intake workflow engine.
 *
 * Owns the lifecycle: creating an intake, moving it between states, recording
 * why, and letting a failed one resume where it stopped. It does not know how
 * to verify a download or fetch artwork — the stages do that and call back
 * here. Keeping the transitions in one place is what makes the pipeline
 * auditable rather than a sequence of services each writing its own status.
 *
 * Every transition is validated against the shared state machine before it is
 * written. A stage that tries to skip ahead — importing something never
 * identified — is refused rather than recorded, because the timeline is the
 * evidence an operator uses and a timeline that contains impossible moves
 * cannot be reasoned about.
 */
@Injectable()
export class MediaIntakeService {
  private readonly logger = new Logger(MediaIntakeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register something for intake, once.
   *
   * The idempotency key is the guard. `torrent.completed` is edge-fired, but an
   * edge can be re-observed across a restart if the snapshot baseline is
   * rebuilt, and a second intake for the same payload would import it twice.
   * The unique constraint makes the second attempt a no-op that returns the
   * first job rather than an error, because a duplicate trigger is not a
   * failure — it is the same work already being done.
   */
  async enqueue(input: EnqueueInput) {
    const key = input.idempotencyKey ?? this.keyFor(input);
    const existing = await this.prisma.mediaIntakeJob.findUnique({ where: { idempotencyKey: key } });
    if (existing) {
      this.logger.debug(`Intake ${key} already exists (${existing.state}); ignoring duplicate.`);
      return existing;
    }
    const job = await this.prisma.mediaIntakeJob.create({
      data: {
        profileId: input.profileId,
        sourcePath: input.sourcePath,
        torrentHash: input.torrentHash ?? null,
        engineId: input.engineId ?? null,
        idempotencyKey: key,
        state: 'queued',
      },
    });
    await this.record(job.id, null, 'queued', 'Registered for intake');
    return job;
  }

  /**
   * Move an intake to `to`, refusing an illegal move.
   *
   * Returns the updated job. The event row is written in the same transaction
   * as the state change: a state without its event is a timeline with a hole in
   * it, and the hole is always at the moment something went wrong.
   */
  async transition(
    jobId: string,
    to: IntakeState,
    opts: { message?: string; data?: Record<string, unknown>; userId?: string } = {},
  ) {
    const job = await this.prisma.mediaIntakeJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Intake job not found');
    const from = job.state as IntakeState;
    if (!canTransition(from, to)) {
      throw new Error(`Illegal intake transition ${from} → ${to}`);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.mediaIntakeJob.update({
        where: { id: jobId },
        data: {
          state: to,
          // Remember where a failure happened so a retry resumes there instead
          // of re-verifying and re-fetching everything that already succeeded.
          resumeState: to === 'failed' ? from : to === 'queued' ? null : job.resumeState,
          lastError: to === 'failed' ? (opts.message ?? job.lastError) : null,
          startedAt: from === 'queued' ? new Date() : job.startedAt,
          importedAt: to === 'imported' ? new Date() : job.importedAt,
        },
      });
      await tx.mediaIntakeEvent.create({
        data: {
          jobId,
          fromState: from,
          toState: to,
          message: opts.message ?? null,
          data: (opts.data ?? undefined) as never,
          userId: opts.userId ?? null,
        },
      });
      return updated;
    });
  }

  /**
   * Put a failed intake back into the pipeline at the point it stopped.
   *
   * Retrying from the beginning would re-download metadata and re-fetch artwork
   * that already succeeded — slow, and rude to every provider involved.
   */
  async retry(jobId: string, userId?: string) {
    const job = await this.prisma.mediaIntakeJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Intake job not found');
    if (job.state !== 'failed') {
      throw new Error(`Only a failed intake can be retried (this one is ${job.state}).`);
    }
    const resume = (job.resumeState as IntakeState | null) ?? 'completed';
    await this.prisma.mediaIntakeJob.update({
      where: { id: jobId },
      data: { attempts: { increment: 1 } },
    });
    return this.transition(jobId, resume, {
      message: `Retry #${job.attempts + 1} resuming at ${resume}`,
      userId,
    });
  }

  /** Record the chosen strategy and why, before executing it. */
  async recordStrategy(jobId: string, strategy: string, reason: string) {
    return this.prisma.mediaIntakeJob.update({
      where: { id: jobId },
      data: { strategy, strategyReason: reason },
    });
  }

  list(filter: { state?: string; active?: boolean } = {}) {
    const where: Record<string, unknown> = {};
    if (filter.state) where.state = filter.state;
    else if (filter.active) {
      where.state = { notIn: [...TERMINAL_INTAKE_STATES, 'seeding'] };
    }
    return this.prisma.mediaIntakeJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async detail(jobId: string) {
    const job = await this.prisma.mediaIntakeJob.findUnique({
      where: { id: jobId },
      include: { events: { orderBy: { createdAt: 'asc' } }, profile: true },
    });
    if (!job) throw new NotFoundException('Intake job not found');
    return job;
  }

  /** Counts per state — the dashboard's queue summary in one query. */
  async summary() {
    const rows = await this.prisma.mediaIntakeJob.groupBy({
      by: ['state'],
      _count: { _all: true },
    });
    const byState = Object.fromEntries(rows.map((r) => [r.state, r._count._all]));
    return {
      byState,
      active: rows
        .filter((r) => isActiveIntake(r.state as IntakeState))
        .reduce((n, r) => n + r._count._all, 0),
    };
  }

  private async record(
    jobId: string,
    from: IntakeState | null,
    to: IntakeState,
    message: string,
  ): Promise<void> {
    await this.prisma.mediaIntakeEvent.create({
      data: { jobId, fromState: from, toState: to, message },
    });
  }

  /**
   * A stable identity for one payload.
   *
   * Hash plus source path rather than hash alone: the same torrent can legitimately
   * be imported into two profiles (a 4K and a 1080p library), and keying on the
   * hash would make the second one look like a duplicate of the first.
   */
  private keyFor(input: EnqueueInput): string {
    return `${input.engineId ?? 'none'}:${input.torrentHash ?? 'manual'}:${input.sourcePath}`;
  }
}
