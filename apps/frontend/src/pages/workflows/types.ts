/**
 * Frontend mirror of the backend workflow graph contract + API shapes.
 * The canvas ({@link ./graph-mapping}) converts between these and @xyflow/react's
 * node/edge model. Keep field names in lock-step with
 * `apps/backend/src/modules/workflows/domain/*` and the WorkflowsController.
 */

export const WORKFLOW_GRAPH_SCHEMA_VERSION = 1;

export interface WorkflowGraphNode {
  id: string;
  type: string;
  label?: string;
  position: { x: number; y: number };
  config?: Record<string, unknown>;
  retryPolicy?: { maxAttempts?: number; strategy?: 'fixed' | 'exponential'; baseMs?: number; maxMs?: number };
  timeoutSeconds?: number;
  errorPolicy?: 'stop' | 'continue' | 'retry' | 'failure_branch' | 'approval' | 'compensate';
  metadata?: Record<string, unknown>;
}

export interface WorkflowGraphEdge {
  id: string;
  sourceNodeId: string;
  sourcePort?: string;
  targetNodeId: string;
  targetPort?: string;
  label?: string;
}

export interface WorkflowGraph {
  schemaVersion: number;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  metadata?: Record<string, unknown>;
  viewport?: { x: number; y: number; zoom: number };
}

export type NodeCategory =
  | 'trigger' | 'condition' | 'branch' | 'action' | 'delay' | 'wait'
  | 'parallel' | 'join' | 'transform' | 'variable' | 'approval' | 'subworkflow' | 'end';

export interface NodeDefinition {
  type: string;
  category: NodeCategory;
  labelKey: string;
  label: string;
  requiredPermission?: string;
  requiredModules?: string[];
  capabilities: { retry: boolean; timeout: boolean; simulation: boolean };
  sideEffect: 'none' | 'read' | 'write';
  destructive: boolean;
  ports: { inputs: number; outputs: string[]; dynamicOutputs?: boolean };
  requiredConfig?: string[];
  triggerId?: string;
  actionId?: string;
}

export interface WorkflowCatalog {
  schemaVersion: number;
  nodes: NodeDefinition[];
  limits: {
    maxNodes: number;
    maxEdges: number;
    maxParallelBranches: number;
    maxDelaySeconds: number;
    maxWaitTimeoutSeconds: number;
  };
}

export interface WorkflowValidationIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  nodeId?: string;
  edgeId?: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: WorkflowValidationIssue[];
  warnings: WorkflowValidationIssue[];
}

export type WorkflowStatus =
  | 'draft' | 'validation_failed' | 'ready' | 'published' | 'disabled' | 'archived';

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  workspaceKey: string | null;
  enabled: boolean;
  status: WorkflowStatus;
  tags: string[];
  publishedVersionId: string | null;
  currentDraftVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowVersionDto {
  id: string;
  workflowId: string;
  versionNumber: number;
  status: string;
  graph: WorkflowGraph;
  checksum: string;
  requiredPermissions: string[];
  changeNotes: string | null;
  publishedAt: string | null;
  createdAt: string;
}

export interface WorkflowDetail {
  workflow: WorkflowSummary;
  draftVersion: WorkflowVersionDto | null;
  publishedVersion: WorkflowVersionDto | null;
}

export interface SaveDraftResult {
  workflow: WorkflowSummary;
  versionId: string;
  validation: WorkflowValidationResult;
}

export interface SimulationStep {
  nodeId: string;
  nodeType: string;
  category: string;
  outcome:
    | 'executed' | 'evaluated' | 'skipped' | 'waited'
    | 'requested_approval' | 'variable_set' | 'ended' | 'subworkflow' | 'unreachable';
  chosenPorts: string[];
  detail?: string;
  renderedConfig?: Record<string, unknown>;
  warnings?: string[];
}

export interface SimulationResult {
  steps: SimulationStep[];
  variables: Record<string, unknown>;
  wouldExecute: { nodeId: string; actionId: string; input: Record<string, unknown> }[];
  reachedNodeIds: string[];
  truncated: boolean;
}

export interface SimulateResponse {
  validation: WorkflowValidationResult;
  simulation: SimulationResult;
}

export interface WorkflowExecutionSummary {
  id: string;
  status: string;
  triggerSource: string | null;
  triggerType: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  createdAt: string;
}
