import { validateWorkflowGraph } from './workflow-validator';
import { WorkflowNodeRegistry } from '../node-registry.service';
import type { WorkflowGraph } from './workflow-graph.types';

const registry = new WorkflowNodeRegistry();

/** A minimal valid graph: manual trigger → scan action → end. */
function validGraph(): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
      { id: 'a', type: 'action.media_scan_library', position: { x: 100, y: 0 }, config: { libraryId: 'lib1' } },
      { id: 'e', type: 'control.end', position: { x: 200, y: 0 } },
    ],
    edges: [
      { id: 'e1', sourceNodeId: 't', targetNodeId: 'a' },
      { id: 'e2', sourceNodeId: 'a', sourcePort: 'out', targetNodeId: 'e' },
    ],
  };
}

const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);

describe('validateWorkflowGraph', () => {
  it('accepts a well-formed graph', () => {
    const r = validateWorkflowGraph(validGraph(), registry);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects a graph with no trigger', () => {
    const g = validGraph();
    g.nodes = g.nodes.filter((n) => n.id !== 't');
    g.edges = g.edges.filter((e) => e.sourceNodeId !== 't');
    const r = validateWorkflowGraph(g, registry);
    expect(r.valid).toBe(false);
    expect(codes(r)).toContain('graph.no_trigger');
  });

  it('rejects unknown node types', () => {
    const g = validGraph();
    g.nodes[1].type = 'action.does_not_exist';
    expect(codes(validateWorkflowGraph(g, registry))).toContain('node.unknown_type');
  });

  it('rejects duplicate node ids', () => {
    const g = validGraph();
    g.nodes[2].id = 'a';
    expect(codes(validateWorkflowGraph(g, registry))).toContain('node.duplicate_id');
  });

  it('rejects an edge to an unknown node', () => {
    const g = validGraph();
    g.edges.push({ id: 'x', sourceNodeId: 'a', targetNodeId: 'ghost' });
    expect(codes(validateWorkflowGraph(g, registry))).toContain('edge.unknown_target');
  });

  it('rejects an invalid source port', () => {
    const g = validGraph();
    g.edges[1].sourcePort = 'nope';
    expect(codes(validateWorkflowGraph(g, registry))).toContain('edge.invalid_source_port');
  });

  it('rejects an incoming edge into a trigger', () => {
    const g = validGraph();
    g.edges.push({ id: 'back', sourceNodeId: 'a', targetNodeId: 't' });
    const r = validateWorkflowGraph(g, registry);
    expect(codes(r)).toContain('node.trigger_has_input');
  });

  it('detects cycles', () => {
    const g: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'a', type: 'control.transform', position: { x: 1, y: 0 } },
        { id: 'b', type: 'control.transform', position: { x: 2, y: 0 } },
      ],
      edges: [
        { id: '1', sourceNodeId: 't', targetNodeId: 'a' },
        { id: '2', sourceNodeId: 'a', targetNodeId: 'b' },
        { id: '3', sourceNodeId: 'b', targetNodeId: 'a' },
      ],
    };
    expect(codes(validateWorkflowGraph(g, registry))).toContain('graph.cycle');
  });

  it('requires a positive bounded delay', () => {
    const g = validGraph();
    g.nodes[1] = { id: 'd', type: 'control.delay', position: { x: 1, y: 0 }, config: { duration: 0 } };
    g.edges = [
      { id: 'e1', sourceNodeId: 't', targetNodeId: 'd' },
      { id: 'e2', sourceNodeId: 'd', targetNodeId: 'e' },
    ];
    expect(codes(validateWorkflowGraph(g, registry))).toContain('node.delay_unbounded');
  });

  it('requires a wait node to handle its timeout', () => {
    const g: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'w', type: 'control.wait', position: { x: 1, y: 0 }, config: { eventType: 'torrent.completed' } },
        { id: 'e', type: 'control.end', position: { x: 2, y: 0 } },
      ],
      edges: [
        { id: '1', sourceNodeId: 't', targetNodeId: 'w' },
        { id: '2', sourceNodeId: 'w', sourcePort: 'completed', targetNodeId: 'e' },
      ],
    };
    expect(codes(validateWorkflowGraph(g, registry))).toContain('node.wait_without_timeout');
  });

  it('requires an explicit safeguard on destructive nodes', () => {
    const g: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'd', type: 'action.delete_with_data', position: { x: 1, y: 0 } },
      ],
      edges: [{ id: '1', sourceNodeId: 't', targetNodeId: 'd' }],
    };
    expect(codes(validateWorkflowGraph(g, registry))).toContain('node.destructive_unguarded');

    g.nodes[1].config = { acknowledgeDestructive: true };
    expect(codes(validateWorkflowGraph(g, registry))).not.toContain('node.destructive_unguarded');
  });

  it('enforces permission gating when granted permissions are supplied', () => {
    const g = validGraph();
    const r = validateWorkflowGraph(g, registry, { grantedPermissions: new Set() });
    expect(codes(r)).toContain('node.permission_denied');
    const ok = validateWorkflowGraph(g, registry, { grantedPermissions: new Set(['media_manager.scan']) });
    expect(codes(ok)).not.toContain('node.permission_denied');
  });

  it('rejects a subworkflow that invokes itself', () => {
    const g: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 's', type: 'control.subworkflow', position: { x: 1, y: 0 }, config: { workflowId: 'wf-self' } },
      ],
      edges: [{ id: '1', sourceNodeId: 't', targetNodeId: 's' }],
    };
    expect(codes(validateWorkflowGraph(g, registry, { selfWorkflowId: 'wf-self' }))).toContain('node.recursive_subworkflow');
  });

  it('flags a scheduled trigger without an execution identity', () => {
    const g: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.scheduled', position: { x: 0, y: 0 }, config: { schedule: '0 0 * * *' } },
        { id: 'e', type: 'control.end', position: { x: 1, y: 0 } },
      ],
      edges: [{ id: '1', sourceNodeId: 't', targetNodeId: 'e' }],
    };
    const r = validateWorkflowGraph(g, registry);
    expect(codes(r)).toContain('node.scheduled_without_identity');
    expect(codes(r)).toContain('node.missing_config'); // executionIdentity also required-config
  });

  it('warns (not errors) on an unreachable node', () => {
    const g = validGraph();
    g.nodes.push({ id: 'iso', type: 'control.transform', position: { x: 5, y: 5 } });
    const r = validateWorkflowGraph(g, registry);
    expect(r.warnings.map((w) => w.code)).toContain('node.unreachable');
  });
});
