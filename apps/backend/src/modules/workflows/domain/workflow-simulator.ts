import type { WorkflowGraph, WorkflowNode, WorkflowEdge } from './workflow-graph.types';
import type { NodeDefinitionLookup } from './workflow-validator';
import { evaluateCondition, resolvePath, type ConditionOperator } from './condition-eval';

/** One node's simulated outcome. */
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
  /** The actions that WOULD run (no provider was called), with rendered inputs. */
  wouldExecute: { nodeId: string; actionId: string; input: Record<string, unknown> }[];
  reachedNodeIds: string[];
  truncated: boolean;
}

export interface SimulationContext {
  /** Sample trigger payload the run would receive. */
  trigger?: Record<string, unknown>;
  /** Seed variables (workflow/global scope). */
  vars?: Record<string, unknown>;
}

/**
 * A **no-side-effect** dry run. Walks the (validated, acyclic) graph in topological order:
 * conditions/branches are evaluated with the same operator semantics as the rules engine,
 * variables are set, action inputs are rendered — but **no provider is ever called**.
 * Actions/delays/waits/approvals are recorded as "would happen". Deterministic, so a given
 * graph + context always yields the same trace.
 */
export function simulateWorkflow(
  graph: WorkflowGraph,
  context: SimulationContext,
  registry: NodeDefinitionLookup,
): SimulationResult {
  const byId = new Map<string, WorkflowNode>(graph.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, WorkflowEdge[]>();
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const e of graph.edges) {
    (outgoing.get(e.sourceNodeId) ?? outgoing.set(e.sourceNodeId, []).get(e.sourceNodeId)!).push(e);
    (incoming.get(e.targetNodeId) ?? incoming.set(e.targetNodeId, []).get(e.targetNodeId)!).push(e);
  }

  const order = topoOrder(graph, incoming, outgoing);
  const vars: Record<string, unknown> = { ...(context.vars ?? {}) };
  const evalContext = () => ({ trigger: context.trigger ?? {}, vars, ...(context.trigger ?? {}) });

  const activePorts = new Map<string, Set<string>>(); // nodeId -> fired output ports
  const reached = new Set<string>();
  const steps: SimulationStep[] = [];
  const wouldExecute: SimulationResult['wouldExecute'] = [];

  const isReached = (node: WorkflowNode): boolean => {
    const def = registry.get(node.type);
    if (def?.category === 'trigger') return true;
    const ins = incoming.get(node.id) ?? [];
    const followed = ins.filter((e) => activePorts.get(e.sourceNodeId)?.has(e.sourcePort ?? 'out') && reached.has(e.sourceNodeId));
    if (ins.length === 0) return false;
    // Join waits for ALL its inputs; everything else fires on the first.
    return def?.category === 'join' ? followed.length === ins.length : followed.length > 0;
  };

  const MAX = graph.nodes.length + 1;
  let truncated = false;

  for (const nodeId of order) {
    if (steps.length > MAX) { truncated = true; break; }
    const node = byId.get(nodeId);
    if (!node) continue;
    const def = registry.get(node.type);
    const category = def?.category ?? 'unknown';

    if (!isReached(node)) {
      // Only record genuinely orphaned nodes as unreachable steps (keeps the trace focused).
      continue;
    }
    reached.add(node.id);

    const outs = def?.ports.outputs ?? ['out'];
    const fired = new Set<string>();
    const step: SimulationStep = { nodeId: node.id, nodeType: node.type, category, outcome: 'executed', chosenPorts: [] };

    switch (category) {
      case 'trigger':
        step.outcome = 'executed';
        fired.add('out');
        break;
      case 'condition': {
        const cond = readCondition(node);
        const result = cond ? evaluateCondition(cond, evalContext()) : true;
        step.outcome = 'evaluated';
        step.detail = `condition → ${result}`;
        fired.add(result ? 'true' : 'false');
        break;
      }
      case 'branch': {
        const chosen = chooseBranch(node, evalContext(), outs);
        step.outcome = 'evaluated';
        step.detail = `branch → ${chosen}`;
        fired.add(chosen);
        break;
      }
      case 'action': {
        const input = renderConfig(node.config ?? {}, evalContext());
        step.outcome = 'executed';
        step.renderedConfig = input;
        step.detail = def?.destructive ? 'destructive action (not run)' : 'action (not run)';
        if (def?.actionId) wouldExecute.push({ nodeId: node.id, actionId: def.actionId, input });
        fired.add('out');
        break;
      }
      case 'delay':
        step.outcome = 'waited';
        step.detail = `delay ${Number(node.config?.duration ?? 0)}s (skipped in simulation)`;
        fired.add('out');
        break;
      case 'wait':
        step.outcome = 'waited';
        step.detail = `wait for "${String(node.config?.eventType ?? '')}" (assumed received)`;
        fired.add('completed');
        break;
      case 'approval':
        step.outcome = 'requested_approval';
        step.detail = 'approval assumed granted';
        step.warnings = ['Approval is auto-approved in simulation; a real run pauses here.'];
        fired.add('approved');
        break;
      case 'variable': {
        const key = String(node.config?.key ?? '');
        const value = renderValue(node.config?.value, evalContext());
        if (key) vars[key] = value;
        step.outcome = 'variable_set';
        step.detail = `${key} = ${JSON.stringify(value)}`;
        fired.add('out');
        break;
      }
      case 'subworkflow':
        step.outcome = 'subworkflow';
        step.detail = `references workflow ${String(node.config?.workflowId ?? '?')} (not expanded)`;
        fired.add('out');
        break;
      case 'end':
        step.outcome = 'ended';
        break;
      default:
        // transform / join / parallel: pass through, activating every output port.
        step.outcome = 'executed';
        for (const p of outs) fired.add(p);
        break;
    }

    // Only keep ports that actually exist on the node.
    const validFired = new Set([...fired].filter((p) => outs.includes(p) || (def?.ports.dynamicOutputs ?? false)));
    activePorts.set(node.id, validFired);
    step.chosenPorts = [...validFired];
    steps.push(step);
  }

  return { steps, variables: vars, wouldExecute, reachedNodeIds: [...reached], truncated };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function readCondition(node: WorkflowNode) {
  const c = (node.config ?? {}) as Record<string, unknown>;
  const field = (c.field ?? (c.condition as Record<string, unknown> | undefined)?.field) as string | undefined;
  const op = (c.operator ?? c.op ?? (c.condition as Record<string, unknown> | undefined)?.op) as ConditionOperator | undefined;
  if (!field || !op) return null;
  const value = c.value ?? (c.condition as Record<string, unknown> | undefined)?.value;
  return { field, op, value };
}

function chooseBranch(node: WorkflowNode, ctx: unknown, outs: string[]): string {
  const branches = (node.config?.branches as Array<{ port: string; field: string; operator: string; value: unknown }> | undefined) ?? [];
  for (const b of branches) {
    if (b.field && b.operator && evaluateCondition({ field: b.field, op: b.operator, value: b.value }, ctx)) {
      return b.port;
    }
  }
  return outs.includes('default') ? 'default' : outs[0] ?? 'default';
}

/** Render `{{path}}` templates inside string config values against the context. */
function renderConfig(config: Record<string, unknown>, ctx: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) out[k] = renderValue(v, ctx);
  return out;
}

function renderValue(value: unknown, ctx: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const resolved = resolvePath(ctx, path);
    return resolved == null ? '' : String(resolved);
  });
}

/** Kahn topological order; falls back to input order for any leftover (defensive). */
function topoOrder(
  graph: WorkflowGraph,
  incoming: Map<string, WorkflowEdge[]>,
  outgoing: Map<string, WorkflowEdge[]>,
): string[] {
  const indeg = new Map<string, number>();
  for (const n of graph.nodes) indeg.set(n.id, (incoming.get(n.id) ?? []).length);
  const queue = graph.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const e of outgoing.get(id) ?? []) {
      indeg.set(e.targetNodeId, (indeg.get(e.targetNodeId) ?? 1) - 1);
      if ((indeg.get(e.targetNodeId) ?? 0) <= 0) queue.push(e.targetNodeId);
    }
  }
  for (const n of graph.nodes) if (!seen.has(n.id)) order.push(n.id); // leftover (cycles shouldn't exist post-validation)
  return order;
}
