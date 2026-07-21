/**
 * The typed **workflow graph contract** — the shape stored in `WorkflowVersion.graph`
 * and validated strictly server-side before publish. Stable node/edge ids;
 * `schemaVersion` gates future migrations. Contains NO executable code — action node
 * `type`s are validated against the node registry + the caller's permissions at
 * validate/publish time; expressions are resolved by a constrained evaluator, never eval.
 * See docs/WORKFLOW_BUILDER_ARCHITECTURE_REVIEW.md §12.
 */

export const WORKFLOW_GRAPH_SCHEMA_VERSION = 1;

export interface WorkflowGraph {
  schemaVersion: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  metadata?: Record<string, unknown>;
  viewport?: { x: number; y: number; zoom: number };
  groups?: WorkflowGroup[];
  comments?: WorkflowComment[];
}

/** A node's error policy when it fails. */
export type NodeErrorPolicy = 'stop' | 'continue' | 'retry' | 'failure_branch' | 'approval' | 'compensate';

export interface NodeRetryPolicy {
  maxAttempts?: number;
  strategy?: 'fixed' | 'exponential';
  baseMs?: number;
  maxMs?: number;
}

export interface WorkflowNode {
  id: string;
  /** Registered node type, e.g. "trigger.torrent.completed", "action.media_scan_library", "control.condition". */
  type: string;
  label?: string;
  position: { x: number; y: number };
  /** Node configuration — validated against the node definition's config schema. */
  config?: Record<string, unknown>;
  inputPorts?: string[];
  outputPorts?: string[];
  retryPolicy?: NodeRetryPolicy;
  timeoutSeconds?: number;
  errorPolicy?: NodeErrorPolicy;
  continueOnError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  sourceNodeId: string;
  sourcePort?: string;
  targetNodeId: string;
  targetPort?: string;
  label?: string;
  /** Optional edge guard (a typed condition; resolved by the constrained evaluator). */
  condition?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface WorkflowGroup {
  id: string;
  label?: string;
  nodeIds: string[];
  collapsed?: boolean;
}

export interface WorkflowComment {
  id: string;
  text: string;
  position: { x: number; y: number };
}

/** A minimal shape guard (structural only — full validation lives in the validator). */
export function isWorkflowGraphShape(value: unknown): value is WorkflowGraph {
  if (!value || typeof value !== 'object') return false;
  const g = value as Record<string, unknown>;
  return typeof g.schemaVersion === 'number' && Array.isArray(g.nodes) && Array.isArray(g.edges);
}
