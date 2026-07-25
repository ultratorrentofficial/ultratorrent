import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { DomainEventEnvelope } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { WorkflowExecutionService } from './workflow-execution.service';
import type { WorkflowGraph } from './domain/workflow-graph.types';

/** Cap per event so one arrival cannot scan an unbounded backlog. */
const MAX_WAITING_SCANNED = 200;

/**
 * Wakes workflow executions that are waiting on a domain event.
 *
 * This restores a capability that was silently lost. A `control.wait` node parks
 * its execution in `waiting_for_event`, and until now the **only** thing that
 * could end that state was `WorkflowResumeService` firing on `expiresAt` — a
 * timeout. Every event-waiting workflow expired, and nothing in the UI or logs
 * said why.
 *
 * Deliberately a subscriber, not a call from the producers: a workflow can wait
 * on any registered event, and the module that publishes `torrent.completed` has
 * no business knowing workflows exist.
 */
@Injectable()
export class WorkflowEventBridge implements OnModuleInit {
  private readonly logger = new Logger(WorkflowEventBridge.name);
  private unsubscribe?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    private readonly executions: WorkflowExecutionService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe('workflow-event-bridge', (envelope) =>
      this.onDomainEvent(envelope),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /**
   * Resume every execution whose current wait node names this event.
   *
   * Each execution is resumed independently and failures are contained: one
   * corrupt graph must not stop the others waking. `resume()` is idempotent, so
   * racing with the timeout tick is harmless.
   */
  private async onDomainEvent(envelope: DomainEventEnvelope): Promise<void> {
    const waiting = await this.prisma.workflowExecution.findMany({
      where: { status: 'waiting_for_event' },
      select: { id: true, workflowVersionId: true },
      take: MAX_WAITING_SCANNED,
    });
    if (!waiting.length) return;

    for (const execution of waiting) {
      try {
        const waitNode = await this.prisma.workflowNodeExecution.findFirst({
          where: { workflowExecutionId: execution.id, status: 'waiting' },
          select: { nodeId: true },
        });
        if (!waitNode) continue;

        const version = await this.prisma.workflowVersion.findUnique({
          where: { id: execution.workflowVersionId },
          select: { graph: true },
        });
        const node = (version?.graph as unknown as WorkflowGraph)?.nodes?.find(
          (n) => n.id === waitNode.nodeId,
        );
        if (node?.config?.eventType !== envelope.eventKey) continue;

        await this.executions.resume(execution.id, 'completed');
        this.logger.log(`Resumed ${execution.id} on ${envelope.eventKey}`);
      } catch (err) {
        this.logger.warn(
          `Resume of ${execution.id} on ${envelope.eventKey} failed: ${(err as Error).message}`,
        );
      }
    }
  }
}
