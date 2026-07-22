import { Module } from '@nestjs/common';
import { WorkflowNodeRegistry } from './node-registry.service';
import { WorkflowService } from './workflow.service';
import { WorkflowExecutionService } from './workflow-execution.service';
import { WorkflowTriggerBridge } from './workflow-trigger.bridge';
import { WorkflowsController } from './workflows.controller';

/**
 * Visual Workflow Builder. Extends the Automation Engine (node definitions are derived from
 * the automation catalog — see {@link WorkflowNodeRegistry} — and actions are dispatched by
 * reusing `AutomationEngine`); it does NOT replace it. The durable executor persists all
 * progress relationally (restart-safe). Prisma, Audit, and AutomationEngine are all global,
 * and the trigger bridge listens on the shared domain-event bus, so this module stays lean.
 */
@Module({
  providers: [WorkflowNodeRegistry, WorkflowService, WorkflowExecutionService, WorkflowTriggerBridge],
  controllers: [WorkflowsController],
  exports: [WorkflowNodeRegistry, WorkflowService, WorkflowExecutionService],
})
export class WorkflowsModule {}
