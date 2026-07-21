import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { NodeDefinition, WorkflowGraph, WorkflowGraphNode } from './types';
import { WORKFLOW_GRAPH_SCHEMA_VERSION } from './types';

/** Data carried on each @xyflow node — the graph node plus its registry definition. */
export interface FlowNodeData extends Record<string, unknown> {
  node: WorkflowGraphNode;
  def: NodeDefinition | undefined;
  issues: number;
}

export type WorkflowFlowNode = FlowNode<FlowNodeData, 'workflowNode'>;

/** WorkflowGraph → @xyflow model (single custom node type carrying the domain node + def). */
export function toFlow(
  graph: WorkflowGraph,
  defsByType: Map<string, NodeDefinition>,
  issueCountByNode: Map<string, number>,
): { nodes: WorkflowFlowNode[]; edges: FlowEdge[] } {
  const nodes: WorkflowFlowNode[] = graph.nodes.map((n) => ({
    id: n.id,
    type: 'workflowNode',
    position: n.position ?? { x: 0, y: 0 },
    data: { node: n, def: defsByType.get(n.type), issues: issueCountByNode.get(n.id) ?? 0 },
  }));
  const edges: FlowEdge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.sourceNodeId,
    target: e.targetNodeId,
    sourceHandle: e.sourcePort ?? null,
    targetHandle: e.targetPort ?? null,
    label: e.label ?? e.sourcePort,
  }));
  return { nodes, edges };
}

/** @xyflow model → WorkflowGraph (positions + config preserved from node data). */
export function fromFlow(nodes: WorkflowFlowNode[], edges: FlowEdge[], viewport?: WorkflowGraph['viewport']): WorkflowGraph {
  return {
    schemaVersion: WORKFLOW_GRAPH_SCHEMA_VERSION,
    nodes: nodes.map((n) => ({
      ...n.data.node,
      id: n.id,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      sourceNodeId: e.source,
      sourcePort: e.sourceHandle ?? undefined,
      targetNodeId: e.target,
      targetPort: e.targetHandle ?? undefined,
      label: typeof e.label === 'string' ? e.label : undefined,
    })),
    viewport,
  };
}

/** Generate a short unique node id (no Math.random dependency on server, fine on client). */
export function newNodeId(type: string, existing: Set<string>): string {
  const base = type.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  let i = 1;
  let id = `${base}_${i}`;
  while (existing.has(id)) id = `${base}_${++i}`;
  return id;
}
