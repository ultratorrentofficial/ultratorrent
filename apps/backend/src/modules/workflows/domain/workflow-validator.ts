import type { WorkflowGraph, WorkflowNode, WorkflowEdge } from './workflow-graph.types';
import { WORKFLOW_GRAPH_SCHEMA_VERSION, isWorkflowGraphShape } from './workflow-graph.types';
import type { WorkflowNodeDefinition, WorkflowValidationError } from './node-definition.types';

/** Structural limits — a workflow that exceeds any of these is rejected at validate time. */
export const WORKFLOW_LIMITS = {
  maxNodes: 200,
  maxEdges: 500,
  maxParallelBranches: 20,
  maxDelaySeconds: 30 * 24 * 3600, // 30 days
  maxWaitTimeoutSeconds: 30 * 24 * 3600,
} as const;

/** A minimal registry surface the validator needs (avoids importing the Nest service). */
export interface NodeDefinitionLookup {
  get(type: string): WorkflowNodeDefinition | undefined;
  has(type: string): boolean;
}

export interface ValidateOptions {
  /** If provided, action nodes whose required permission is absent are errors. */
  grantedPermissions?: ReadonlySet<string>;
  /** If provided, nodes whose required modules aren't all enabled are errors. */
  enabledModules?: ReadonlySet<string>;
  /** This workflow's own id — a subworkflow node targeting it is direct recursion. */
  selfWorkflowId?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: WorkflowValidationError[]; // severity 'error'
  warnings: WorkflowValidationError[]; // severity 'warning'
}

/**
 * Strict, side-effect-free validation of a workflow graph against the node registry.
 * A graph must pass (zero errors) before it can be published — the executor trusts a
 * validated graph and does no structural re-checking. See the architecture review §12/§16.
 *
 * Checks: schema version, node/edge count limits, unique node ids, known node types,
 * exactly-one-trigger-family, no input into triggers / no output out of ends, edges
 * reference real nodes+ports, no cycles, every non-trigger node reachable from a trigger,
 * no orphan nodes, bounded delays, waits/approvals have a timeout branch, destructive nodes
 * carry an explicit safeguard, parallel fan-out within limits, and (when context is given)
 * permission + module gating and self-recursion.
 */
export function validateWorkflowGraph(
  graph: WorkflowGraph,
  registry: NodeDefinitionLookup,
  options: ValidateOptions = {},
): ValidationResult {
  const errors: WorkflowValidationError[] = [];
  const warnings: WorkflowValidationError[] = [];
  const err = (code: string, message: string, extra?: Partial<WorkflowValidationError>) =>
    errors.push({ code, message, severity: 'error', ...extra });
  const warn = (code: string, message: string, extra?: Partial<WorkflowValidationError>) =>
    warnings.push({ code, message, severity: 'warning', ...extra });

  if (!isWorkflowGraphShape(graph)) {
    err('graph.malformed', 'Graph is not a well-formed workflow graph.');
    return { valid: false, errors, warnings };
  }
  if (graph.schemaVersion !== WORKFLOW_GRAPH_SCHEMA_VERSION) {
    err('graph.schema_version', `Unsupported graph schema version ${graph.schemaVersion}; expected ${WORKFLOW_GRAPH_SCHEMA_VERSION}.`);
  }

  const { nodes, edges } = graph;

  if (nodes.length === 0) {
    err('graph.empty', 'A workflow must contain at least one node.');
    return { valid: false, errors, warnings };
  }
  if (nodes.length > WORKFLOW_LIMITS.maxNodes) {
    err('graph.too_many_nodes', `Workflow has ${nodes.length} nodes; the maximum is ${WORKFLOW_LIMITS.maxNodes}.`);
  }
  if (edges.length > WORKFLOW_LIMITS.maxEdges) {
    err('graph.too_many_edges', `Workflow has ${edges.length} edges; the maximum is ${WORKFLOW_LIMITS.maxEdges}.`);
  }

  // ── Node identity & types ───────────────────────────────────────────────────
  const byId = new Map<string, WorkflowNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      err('node.duplicate_id', `Duplicate node id "${node.id}".`, { nodeId: node.id });
      continue;
    }
    byId.set(node.id, node);
    const def = registry.get(node.type);
    if (!def) {
      err('node.unknown_type', `Unknown node type "${node.type}".`, { nodeId: node.id });
      continue;
    }
    validateNodeConfig(node, def, err, warn);
    if (options.grantedPermissions && def.requiredPermission && !options.grantedPermissions.has(def.requiredPermission)) {
      err('node.permission_denied', `Node requires permission "${def.requiredPermission}" that the workflow identity lacks.`, { nodeId: node.id });
    }
    if (options.enabledModules && def.requiredModules) {
      for (const m of def.requiredModules) {
        if (!options.enabledModules.has(m)) {
          err('node.module_disabled', `Node requires module "${m}" which is not enabled.`, { nodeId: node.id });
        }
      }
    }
    if (def.category === 'subworkflow' && options.selfWorkflowId && node.config?.workflowId === options.selfWorkflowId) {
      err('node.recursive_subworkflow', 'A subworkflow node cannot invoke its own workflow.', { nodeId: node.id });
    }
  }

  // ── Trigger family ──────────────────────────────────────────────────────────
  const triggerNodes = nodes.filter((n) => registry.get(n.type)?.category === 'trigger');
  if (triggerNodes.length === 0) {
    err('graph.no_trigger', 'A workflow must have at least one trigger node.');
  }

  // ── Edges: endpoints & ports ────────────────────────────────────────────────
  const outgoing = new Map<string, WorkflowEdge[]>();
  const incoming = new Map<string, WorkflowEdge[]>();
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      err('edge.duplicate_id', `Duplicate edge id "${edge.id}".`, { edgeId: edge.id });
    }
    edgeIds.add(edge.id);
    const src = byId.get(edge.sourceNodeId);
    const dst = byId.get(edge.targetNodeId);
    if (!src) {
      err('edge.unknown_source', `Edge "${edge.id}" references unknown source node "${edge.sourceNodeId}".`, { edgeId: edge.id });
    }
    if (!dst) {
      err('edge.unknown_target', `Edge "${edge.id}" references unknown target node "${edge.targetNodeId}".`, { edgeId: edge.id });
    }
    if (!src || !dst) continue;
    if (edge.sourceNodeId === edge.targetNodeId) {
      err('edge.self_loop', `Edge "${edge.id}" connects a node to itself.`, { edgeId: edge.id });
    }
    validatePort(edge, src, 'source', registry, err);
    validatePort(edge, dst, 'target', registry, err);
    push(outgoing, edge.sourceNodeId, edge);
    push(incoming, edge.targetNodeId, edge);
  }

  // ── Per-node connectivity rules ─────────────────────────────────────────────
  for (const node of byId.values()) {
    const def = registry.get(node.type);
    if (!def) continue;
    const outs = outgoing.get(node.id) ?? [];
    const ins = incoming.get(node.id) ?? [];

    if (def.category === 'trigger' && ins.length > 0) {
      err('node.trigger_has_input', 'Trigger nodes cannot have incoming edges.', { nodeId: node.id });
    }
    if (def.ports.inputs === 0 && ins.length > 0 && def.category !== 'trigger') {
      err('node.unexpected_input', `Node "${node.id}" does not accept incoming edges.`, { nodeId: node.id });
    }
    if (def.ports.inputs === 1 && ins.length > 1 && def.category !== 'join') {
      err('node.multiple_inputs', `Node "${node.id}" accepts a single incoming edge but has ${ins.length}.`, { nodeId: node.id });
    }
    if (def.category === 'end' && outs.length > 0) {
      err('node.end_has_output', 'End nodes cannot have outgoing edges.', { nodeId: node.id });
    }
    if (def.category !== 'trigger' && def.ports.inputs !== 0 && ins.length === 0) {
      warn('node.orphan_input', `Node "${node.id}" has no incoming edge and is unreachable.`, { nodeId: node.id });
    }
    if (def.category !== 'end' && def.ports.outputs.length > 0 && outs.length === 0) {
      warn('node.dangling_output', `Node "${node.id}" has no outgoing edge.`, { nodeId: node.id });
    }

    // Waits & approvals must handle their timeout branch.
    if ((def.category === 'wait' || def.category === 'approval') && def.ports.outputs.includes('timeout')) {
      const hasTimeout = outs.some((e) => e.sourcePort === 'timeout');
      const timeoutCfg = Number(node.config?.timeoutSeconds);
      if (!hasTimeout && !(timeoutCfg > 0)) {
        err('node.wait_without_timeout', `Node "${node.id}" waits indefinitely: connect its "timeout" output or set a timeoutSeconds.`, { nodeId: node.id });
      }
      if (timeoutCfg > WORKFLOW_LIMITS.maxWaitTimeoutSeconds) {
        err('node.wait_timeout_too_long', `Wait timeout exceeds the ${WORKFLOW_LIMITS.maxWaitTimeoutSeconds}s maximum.`, { nodeId: node.id });
      }
    }

    // Bounded delays.
    if (def.category === 'delay') {
      const duration = Number(node.config?.duration);
      if (!(duration > 0)) {
        err('node.delay_unbounded', `Delay node "${node.id}" needs a positive duration (seconds).`, { nodeId: node.id });
      } else if (duration > WORKFLOW_LIMITS.maxDelaySeconds) {
        err('node.delay_too_long', `Delay of ${duration}s exceeds the ${WORKFLOW_LIMITS.maxDelaySeconds}s maximum.`, { nodeId: node.id });
      }
    }

    // Parallel fan-out bound.
    if (def.category === 'parallel' && outs.length > WORKFLOW_LIMITS.maxParallelBranches) {
      err('node.parallel_too_wide', `Parallel node fans out to ${outs.length} branches; the maximum is ${WORKFLOW_LIMITS.maxParallelBranches}.`, { nodeId: node.id });
    }

    // Destructive nodes need an explicit safeguard flag on the node config.
    if (def.destructive && node.config?.acknowledgeDestructive !== true) {
      err('node.destructive_unguarded', `Destructive node "${node.id}" (${def.type}) must set config.acknowledgeDestructive = true.`, { nodeId: node.id });
    }

    // Scheduled triggers need a run identity to enforce permissions at run time.
    if (node.type === 'trigger.scheduled' && !node.config?.executionIdentity) {
      err('node.scheduled_without_identity', 'A scheduled trigger must declare an executionIdentity.', { nodeId: node.id });
    }
  }

  // ── Reachability & cycles ───────────────────────────────────────────────────
  detectUnreachable(byId, triggerNodes, outgoing, warn);
  if (hasCycle(byId, outgoing)) {
    err('graph.cycle', 'The workflow graph contains a cycle; workflows must be acyclic.');
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function validateNodeConfig(
  node: WorkflowNode,
  def: WorkflowNodeDefinition,
  err: (code: string, message: string, extra?: Partial<WorkflowValidationError>) => void,
  _warn: (code: string, message: string, extra?: Partial<WorkflowValidationError>) => void,
): void {
  for (const key of def.requiredConfig ?? []) {
    const value = node.config?.[key];
    if (value === undefined || value === null || value === '') {
      err('node.missing_config', `Node "${node.id}" (${def.type}) is missing required config "${key}".`, { nodeId: node.id });
    }
  }
}

function validatePort(
  edge: WorkflowEdge,
  node: WorkflowNode,
  end: 'source' | 'target',
  registry: NodeDefinitionLookup,
  err: (code: string, message: string, extra?: Partial<WorkflowValidationError>) => void,
): void {
  const def = registry.get(node.type);
  if (!def) return;
  if (end === 'source') {
    const port = edge.sourcePort ?? def.ports.outputs[0];
    if (def.ports.outputs.length === 0) {
      err('edge.no_source_port', `Node "${node.id}" (${def.type}) has no output ports.`, { edgeId: edge.id });
    } else if (!def.ports.dynamicOutputs && port !== undefined && !def.ports.outputs.includes(port)) {
      err('edge.invalid_source_port', `Edge "${edge.id}" uses output port "${port}" not defined on node "${node.id}".`, { edgeId: edge.id });
    }
  } else {
    if (def.ports.inputs === 0) {
      err('edge.no_target_port', `Node "${node.id}" (${def.type}) accepts no input.`, { edgeId: edge.id });
    }
  }
}

function push(map: Map<string, WorkflowEdge[]>, key: string, edge: WorkflowEdge): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

function detectUnreachable(
  byId: Map<string, WorkflowNode>,
  triggerNodes: WorkflowNode[],
  outgoing: Map<string, WorkflowEdge[]>,
  warn: (code: string, message: string, extra?: Partial<WorkflowValidationError>) => void,
): void {
  const seen = new Set<string>();
  const stack = triggerNodes.map((n) => n.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of outgoing.get(id) ?? []) stack.push(e.targetNodeId);
  }
  for (const id of byId.keys()) {
    if (!seen.has(id)) {
      warn('node.unreachable', `Node "${id}" is not reachable from any trigger.`, { nodeId: id });
    }
  }
}

function hasCycle(byId: Map<string, WorkflowNode>, outgoing: Map<string, WorkflowEdge[]>): boolean {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of byId.keys()) color.set(id, WHITE);

  const visit = (start: string): boolean => {
    // Iterative DFS with an explicit stack to avoid recursion limits on large graphs.
    const stack: Array<{ id: string; iter: number }> = [{ id: start, iter: 0 }];
    color.set(start, GRAY);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edges = outgoing.get(frame.id) ?? [];
      if (frame.iter >= edges.length) {
        color.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const next = edges[frame.iter++].targetNodeId;
      const c = color.get(next);
      if (c === GRAY) return true;
      if (c === WHITE) {
        color.set(next, GRAY);
        stack.push({ id: next, iter: 0 });
      }
    }
    return false;
  };

  for (const id of byId.keys()) {
    if (color.get(id) === WHITE && visit(id)) return true;
  }
  return false;
}
