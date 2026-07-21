import { describe, it, expect } from 'vitest';
import { toFlow, fromFlow, newNodeId } from './graph-mapping';
import type { NodeDefinition, WorkflowGraph } from './types';

const def: NodeDefinition = {
  type: 'action.media_scan_library', category: 'action', labelKey: 'x', label: 'Scan',
  capabilities: { retry: true, timeout: true, simulation: true }, sideEffect: 'write', destructive: false,
  ports: { inputs: 1, outputs: ['out', 'failure'] },
};
const defs = new Map<string, NodeDefinition>([[def.type, def]]);

const graph: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [
    { id: 't', type: 'trigger.manual', position: { x: 10, y: 20 } },
    { id: 'a', type: 'action.media_scan_library', position: { x: 100, y: 40 }, config: { libraryId: 'lib1' } },
  ],
  edges: [{ id: 'e1', sourceNodeId: 't', sourcePort: 'out', targetNodeId: 'a', label: 'out' }],
};

describe('graph-mapping', () => {
  it('round-trips a graph through @xyflow and back', () => {
    const flow = toFlow(graph, defs, new Map([['a', 2]]));
    expect(flow.nodes).toHaveLength(2);
    expect(flow.edges[0].source).toBe('t');
    expect(flow.edges[0].sourceHandle).toBe('out');
    expect(flow.nodes.find((n) => n.id === 'a')?.data.issues).toBe(2);

    const back = fromFlow(flow.nodes, flow.edges);
    expect(back.nodes.map((n) => n.id).sort()).toEqual(['a', 't']);
    expect(back.nodes.find((n) => n.id === 'a')?.config).toEqual({ libraryId: 'lib1' });
    expect(back.edges[0]).toMatchObject({ sourceNodeId: 't', sourcePort: 'out', targetNodeId: 'a' });
  });

  it('newNodeId avoids collisions', () => {
    const existing = new Set(['delay_1', 'delay_2']);
    expect(newNodeId('delay', existing)).toBe('delay_3');
  });
});
