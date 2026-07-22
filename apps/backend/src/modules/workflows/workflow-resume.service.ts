import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { WorkflowExecutionService } from './workflow-execution.service';

const TICK_MS = 15_000;

/**
 * The durable-resume heartbeat. Reuses the platform's existing `@nestjs/schedule` (no second
 * scheduler — non-negotiable): one named `@Interval` advances time-based waits. Delays whose
 * `resumeAt` has passed resume down their `out` port; event/approval waits whose `expiresAt`
 * has passed resume down `timeout` (expiring any pending approval first). Event arrival is
 * handled separately on the shared bus by {@link WorkflowTriggerBridge}. Resume is idempotent,
 * so a bus resume and a timeout tick can race harmlessly.
 */
@Injectable()
export class WorkflowResumeService {
  private readonly logger = new Logger(WorkflowResumeService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly executions: WorkflowExecutionService,
  ) {}

  @Interval('workflow_resume_tick', TICK_MS)
  async tick(): Promise<void> {
    if (this.running) return; // never overlap ticks
    this.running = true;
    try {
      const now = new Date();

      const due = await this.prisma.workflowExecution.findMany({
        where: { status: 'waiting', resumeAt: { not: null, lte: now } },
        select: { id: true }, take: 50,
      });
      for (const { id } of due) {
        await this.executions.resume(id, 'out').catch((e) => this.logger.error(`Resume delay ${id}: ${(e as Error).message}`));
      }

      const expired = await this.prisma.workflowExecution.findMany({
        where: { status: { in: ['waiting_for_event', 'waiting_for_approval'] }, expiresAt: { not: null, lte: now } },
        select: { id: true, status: true }, take: 50,
      });
      for (const ex of expired) {
        if (ex.status === 'waiting_for_approval') {
          await this.prisma.workflowApproval.updateMany({
            where: { workflowExecutionId: ex.id, status: 'pending' }, data: { status: 'expired' },
          });
        }
        await this.executions.resume(ex.id, 'timeout').catch((e) => this.logger.error(`Timeout ${ex.id}: ${(e as Error).message}`));
      }
    } catch (err) {
      this.logger.error(`Resume tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
