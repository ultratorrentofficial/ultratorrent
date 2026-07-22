import type { WorkflowGraph, WorkflowEdge } from './workflow-graph.types';

/**
 * The pure, **restart-safe** scheduling core of the durable executor. Given the graph and the
 * persisted per-node state (loaded from `workflow_node_executions`), it computes what to do
 * next — with no side effects and no in-memory assumptions — so a fresh process can resume an
 * execution purely from the database. The `WorkflowExecutionService` owns dispatch + persistence
 * and calls this to decide the next wave.
 */

export type NodeRunStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped';

export interface NodeRunState {
  status: NodeRunStatus;
  /** Output ports this node activated on completion (e.g. condition → ['true']). */
  firedPorts: string[];
}

export interface PlannerLookup {
  isJoin(nodeType: string): boolean;
  isTrigger(nodeType: string): boolean;
}

export interface PlannerView {
  /** Nodes with all dependencies satisfied and status `pending` — dispatch these next. */
  ready: string[];
  /** Nodes that can never become ready (every incoming edge resolved without firing) — skip these. */
  dead: string[];
  /** True when no node is running/waiting and none can advance — the execution is quiescent. */
  quiescent: boolean;
}

function indexEdges(graph: WorkflowGraph) {
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const e of graph.edges) {
    const list = incoming.get(e.targetNodeId);
    if (list) list.push(e);
    else incoming.set(e.targetNodeId, [e]);
  }
  return incoming;
}

/** Classify one edge given its source node's current state. */
function edgeState(edge: WorkflowEdge, states: Map<string, NodeRunState>): 'live' | 'dead' | 'pending' {
  const src = states.get(edge.sourceNodeId);
  if (!src) return 'pending';
  const port = edge.sourcePort ?? 'out';
  // A completed node (succeeded, or failed-and-routed) fires exactly the ports it recorded —
  // so an action's `failure` port stays live even though the node's own status is `failed`.
  if (src.status === 'succeeded' || src.status === 'failed') {
    return src.firedPorts.includes(port) ? 'live' : 'dead';
  }
  if (src.status === 'skipped') return 'dead';
  return 'pending'; // pending / running / waiting
}

export function planExecution(
  graph: WorkflowGraph,
  states: Map<string, NodeRunState>,
  lookup: PlannerLookup,
): PlannerView {
  const incoming = indexEdges(graph);
  const ready: string[] = [];
  const dead: string[] = [];
  let anyActive = false;

  for (const node of graph.nodes) {
    const st = states.get(node.id) ?? { status: 'pending', firedPorts: [] };
    if (st.status === 'running' || st.status === 'waiting') { anyActive = true; continue; }
    if (st.status !== 'pending') continue;

    if (lookup.isTrigger(node.type)) { ready.push(node.id); continue; }

    const ins = incoming.get(node.id) ?? [];
    if (ins.length === 0) { dead.push(node.id); continue; } // unreachable non-trigger

    const classes = ins.map((e) => edgeState(e, states));
    const live = classes.filter((c) => c === 'live').length;
    const pending = classes.filter((c) => c === 'pending').length;

    if (lookup.isJoin(node.type)) {
      // Join needs every incoming edge live. If any edge is dead it can never satisfy → skip.
      if (classes.some((c) => c === 'dead') && pending === 0) dead.push(node.id);
      else if (live === ins.length) ready.push(node.id);
    } else {
      if (live > 0) ready.push(node.id);
      else if (pending === 0) dead.push(node.id); // all incoming resolved, none fired → skip
    }
  }

  const quiescent = !anyActive && ready.length === 0;
  return { ready, dead, quiescent };
}
