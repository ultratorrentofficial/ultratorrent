import { Injectable } from '@nestjs/common';
import { AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS } from '../automation/automation.module';
import type { WorkflowNodeDefinition, NodeCategory } from './domain/node-definition.types';
import { ACTION_PERMISSION, DESTRUCTIVE_ACTIONS, LONG_RUNNING_ACTIONS, moduleForCategory } from './domain/action-metadata';

/** The `type` prefix for each node family. */
export const NODE_PREFIX = { trigger: 'trigger.', action: 'action.', control: 'control.' } as const;

/**
 * The workflow node catalog — a registry, not a switch. Trigger and Action node
 * definitions are **generated from the Automation catalog** (`AUTOMATION_TRIGGERS`/
 * `AUTOMATION_ACTIONS`), so visual nodes always reference real registered triggers/actions
 * (non-negotiable #2/#3/#4). Built-in control nodes (condition/branch/delay/wait/parallel/
 * join/transform/variable/approval/subworkflow/end + manual/scheduled/webhook triggers)
 * are declared here. The editor palette, the graph validator, and the executor all read
 * from this one source. See docs/WORKFLOW_BUILDER_ARCHITECTURE_REVIEW.md §12.
 */
@Injectable()
export class WorkflowNodeRegistry {
  private readonly defs = new Map<string, WorkflowNodeDefinition>();

  constructor() {
    this.buildBuiltins();
    this.buildFromCatalog();
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  get(type: string): WorkflowNodeDefinition | undefined {
    return this.defs.get(type);
  }

  list(): WorkflowNodeDefinition[] {
    return [...this.defs.values()];
  }

  listByCategory(category: NodeCategory): WorkflowNodeDefinition[] {
    return this.list().filter((d) => d.category === category);
  }

  get size(): number {
    return this.defs.size;
  }

  // ── Catalog-derived trigger & action nodes ──────────────────────────────────
  private buildFromCatalog(): void {
    for (const trigger of AUTOMATION_TRIGGERS) {
      const module = moduleForCategory(trigger.category);
      this.add({
        type: `${NODE_PREFIX.trigger}${trigger.id}`,
        category: 'trigger',
        labelKey: `workflows.trigger.${trigger.id}`,
        capabilities: { retry: false, timeout: false, simulation: true },
        sideEffect: 'none',
        destructive: false,
        ports: { inputs: 0, outputs: ['out'] },
        triggerId: trigger.id,
        requiredModules: module ? [module] : undefined,
      });
    }
    for (const action of AUTOMATION_ACTIONS) {
      const module = moduleForCategory(action.category);
      this.add({
        type: `${NODE_PREFIX.action}${action.id}`,
        category: 'action',
        labelKey: `workflows.action.${action.id}`,
        requiredPermission: ACTION_PERMISSION[action.id],
        requiredModules: module ? [module] : undefined,
        capabilities: {
          retry: true,
          timeout: LONG_RUNNING_ACTIONS.has(action.id),
          simulation: true,
        },
        sideEffect: 'write',
        destructive: DESTRUCTIVE_ACTIONS.has(action.id),
        ports: { inputs: 1, outputs: ['out', 'failure'] },
        actionId: action.id,
      });
    }
  }

  // ── Built-in triggers + control nodes ───────────────────────────────────────
  private buildBuiltins(): void {
    const triggers: WorkflowNodeDefinition[] = [
      { type: 'trigger.manual', category: 'trigger', labelKey: 'workflows.node.manualTrigger', capabilities: cap(), sideEffect: 'none', destructive: false, ports: { inputs: 0, outputs: ['out'] } },
      { type: 'trigger.scheduled', category: 'trigger', labelKey: 'workflows.node.scheduledTrigger', capabilities: cap(), sideEffect: 'none', destructive: false, ports: { inputs: 0, outputs: ['out'] }, requiredConfig: ['schedule', 'executionIdentity'] },
      { type: 'trigger.webhook', category: 'trigger', labelKey: 'workflows.node.webhookTrigger', capabilities: cap(), sideEffect: 'none', destructive: false, ports: { inputs: 0, outputs: ['out'] } },
    ];
    const controls: WorkflowNodeDefinition[] = [
      { type: 'control.condition', category: 'condition', labelKey: 'workflows.node.condition', capabilities: cap(), sideEffect: 'none', destructive: false, ports: { inputs: 1, outputs: ['true', 'false'] } },
      { type: 'control.branch', category: 'branch', labelKey: 'workflows.node.branch', capabilities: cap(), sideEffect: 'none', destructive: false, ports: { inputs: 1, outputs: ['default'], dynamicOutputs: true } },
      { type: 'control.delay', category: 'delay', labelKey: 'workflows.node.delay', capabilities: cap(), sideEffect: 'none', destructive: false, ports: { inputs: 1, outputs: ['out'] }, requiredConfig: ['duration'] },
      { type: 'control.wait', category: 'wait', labelKey: 'workflows.node.wait', capabilities: cap(), sideEffect: 'read', destructive: false, ports: { inputs: 1, outputs: ['completed', 'timeout'] }, requiredConfig: ['eventType'] },
      { type: 'control.parallel', category: 'parallel', labelKey: 'workflows.node.parallel', capabilities: cap(), sideEffect: 'none', destructive: false, ports: { inputs: 1, outputs: ['branch'], dynamicOutputs: true } },
      { type: 'control.join', category: 'join', labelKey: 'workflows.node.join', capabilities: cap(), sideEffect: 'none', destructive: false, ports: { inputs: -1, outputs: ['out'] } },
      { type: 'control.transform', category: 'transform', labelKey: 'workflows.node.transform', capabilities: cap(), sideEffect: 'none', destructive: false, ports: { inputs: 1, outputs: ['out'] } },
      { type: 'control.variable', category: 'variable', labelKey: 'workflows.node.variable', capabilities: cap(), sideEffect: 'none', destructive: false, ports: { inputs: 1, outputs: ['out'] }, requiredConfig: ['key'] },
      { type: 'control.approval', category: 'approval', labelKey: 'workflows.node.approval', capabilities: cap(), sideEffect: 'none', destructive: false, ports: { inputs: 1, outputs: ['approved', 'rejected', 'timeout'] } },
      { type: 'control.subworkflow', category: 'subworkflow', labelKey: 'workflows.node.subworkflow', capabilities: { retry: false, timeout: true, simulation: true }, sideEffect: 'write', destructive: false, ports: { inputs: 1, outputs: ['out', 'failure'] }, requiredConfig: ['workflowId'] },
      { type: 'control.end', category: 'end', labelKey: 'workflows.node.end', capabilities: cap(), sideEffect: 'none', destructive: false, ports: { inputs: 1, outputs: [] } },
    ];
    for (const d of [...triggers, ...controls]) this.add(d);
  }

  private add(def: WorkflowNodeDefinition): void {
    this.defs.set(def.type, def);
  }
}

function cap(): WorkflowNodeDefinition['capabilities'] {
  return { retry: false, timeout: false, simulation: true };
}
