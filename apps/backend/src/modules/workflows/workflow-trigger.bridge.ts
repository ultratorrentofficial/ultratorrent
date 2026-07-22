import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NOTIFICATION_BUS_CHANNEL, type DomainEventEnvelope } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { WorkflowExecutionService } from './workflow-execution.service';
import type { WorkflowGraph } from './domain/workflow-graph.types';

/**
 * Starts workflow executions off the **same shared domain-event bus** the Automation Engine
 * and Jobs Center use — no second bus (non-negotiable). On each event it finds the enabled,
 * published workflows whose published graph contains a matching `trigger.<event>` node and
 * starts one version-pinned execution each, seeded with the event payload. Mirrors the
 * decoupled `JobAutomationBridge` pattern.
 */
@Injectable()
export class WorkflowTriggerBridge {
  private readonly logger = new Logger(WorkflowTriggerBridge.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly executions: WorkflowExecutionService,
  ) {}

  @OnEvent(NOTIFICATION_BUS_CHANNEL)
  async onDomainEvent(envelope: DomainEventEnvelope): Promise<void> {
    const event = envelope?.event;
    if (!event) return;
    const triggerNodeType = `trigger.${event}`;
    try {
      // Candidate: enabled + published workflows. Match the trigger node inside the published graph.
      const candidates = await this.prisma.workflow.findMany({
        where: { enabled: true, status: 'published', publishedVersionId: { not: null } },
        select: { id: true, publishedVersionId: true },
        take: 200,
      });
      if (candidates.length === 0) return;

      const versions = await this.prisma.workflowVersion.findMany({
        where: { id: { in: candidates.map((c) => c.publishedVersionId!) } },
        select: { id: true, workflowId: true, graph: true },
      });

      for (const version of versions) {
        const graph = version.graph as unknown as WorkflowGraph;
        const matches = graph.nodes?.some((n) => n.type === triggerNodeType);
        if (!matches) continue;
        await this.executions.start(version.workflowId, {
          triggerSource: 'event',
          triggerType: event,
          correlationId: envelope.dedupeKey ?? undefined,
          context: envelope.payload ?? {},
        });
      }

      // Resume durable wait-for-event nodes whose declared eventType matches this event.
      await this.resumeWaitingForEvent(event);
    } catch (err) {
      this.logger.debug(`Workflow trigger for "${event}" failed: ${(err as Error).message}`);
    }
  }

  private async resumeWaitingForEvent(event: string): Promise<void> {
    const waiting = await this.prisma.workflowExecution.findMany({
      where: { status: 'waiting_for_event' },
      select: { id: true, workflowVersionId: true },
      take: 200,
    });
    for (const ex of waiting) {
      const waitNode = await this.prisma.workflowNodeExecution.findFirst({
        where: { workflowExecutionId: ex.id, status: 'waiting' }, select: { nodeId: true },
      });
      if (!waitNode) continue;
      const version = await this.prisma.workflowVersion.findUnique({
        where: { id: ex.workflowVersionId }, select: { graph: true },
      });
      const node = (version?.graph as unknown as WorkflowGraph)?.nodes?.find((n) => n.id === waitNode.nodeId);
      if (node?.config?.eventType === event) {
        await this.executions.resume(ex.id, 'completed');
      }
    }
  }
}
