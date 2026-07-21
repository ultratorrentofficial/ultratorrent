import { Module } from '@nestjs/common';
import { WorkflowNodeRegistry } from './node-registry.service';
import { WorkflowService } from './workflow.service';
import { WorkflowsController } from './workflows.controller';

/**
 * Visual Workflow Builder. Extends the Automation Engine (node definitions are derived from
 * the automation catalog — see {@link WorkflowNodeRegistry}); it does NOT replace it. Durable
 * execution rides the Unified Jobs Center (added in a later phase). Prisma, Audit, and the
 * Automation catalog are all global, so this module stays lean.
 */
@Module({
  providers: [WorkflowNodeRegistry, WorkflowService],
  controllers: [WorkflowsController],
  exports: [WorkflowNodeRegistry, WorkflowService],
})
export class WorkflowsModule {}
