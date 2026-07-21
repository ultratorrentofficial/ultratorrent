/**
 * A workflow node **definition** — the registry metadata for one node type. Trigger and
 * Action definitions are generated from the Automation catalog (single source of truth);
 * control nodes are built-in. The Jobs-Center-style registry pattern: no giant switch.
 */

export type NodeCategory =
  | 'trigger' | 'condition' | 'branch' | 'action' | 'delay' | 'wait'
  | 'parallel' | 'join' | 'transform' | 'variable' | 'approval' | 'subworkflow' | 'end';

export type SideEffectLevel = 'none' | 'read' | 'write';

export interface NodePorts {
  /** Number of input connections: 0 (trigger), 1 (default), -1 (many — join). */
  inputs: number;
  /** Named output ports. Empty for an End node. */
  outputs: string[];
  /** Output ports are defined by node config (branch/parallel) — validate against config. */
  dynamicOutputs?: boolean;
}

export interface WorkflowNodeDefinition {
  /** e.g. "trigger.torrent.completed", "action.media_scan_library", "control.condition". */
  type: string;
  category: NodeCategory;
  labelKey: string;
  descriptionKey?: string;
  icon?: string;
  /** For action nodes: the underlying action permission that STILL applies at run time. */
  requiredPermission?: string;
  requiredModules?: string[];
  capabilities: { retry: boolean; timeout: boolean; simulation: boolean };
  sideEffect: SideEffectLevel;
  destructive: boolean;
  ports: NodePorts;
  /** Config keys that must be present for the node to be valid. */
  requiredConfig?: string[];
  /** Reference into the Automation catalog (trigger/action nodes only). */
  triggerId?: string;
  actionId?: string;
}

/** A validation finding. `error` blocks publish; `warning` is advisory. */
export interface WorkflowValidationError {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  nodeId?: string;
  edgeId?: string;
}
