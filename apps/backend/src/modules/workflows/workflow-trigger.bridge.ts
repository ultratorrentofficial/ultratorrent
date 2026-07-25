import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
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
