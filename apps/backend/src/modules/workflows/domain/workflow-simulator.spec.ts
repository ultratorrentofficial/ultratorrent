import { simulateWorkflow } from './workflow-simulator';
import { WorkflowNodeRegistry } from '../node-registry.service';
import type { WorkflowGraph } from './workflow-graph.types';

const registry = new WorkflowNodeRegistry();

describe('simulateWorkflow', () => {
  it('runs a linear trigger → action → end path without side effects', () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'a', type: 'action.media_scan_library', position: { x: 1, y: 0 }, config: { libraryId: 'lib1' } },
        { id: 'e', type: 'control.end', position: { x: 2, y: 0 } },
      ],
      edges: [
        { id: '1', sourceNodeId: 't', targetNodeId: 'a' },
        { id: '2', sourceNodeId: 'a', sourcePort: 'out', targetNodeId: 'e' },
      ],
    };
    const r = simulateWorkflow(graph, {}, registry);
    expect(r.reachedNodeIds.sort()).toEqual(['a', 'e', 't']);
    expect(r.wouldExecute).toEqual([{ nodeId: 'a', actionId: 'media_scan_library', input: { libraryId: 'lib1' } }]);
    expect(r.steps.find((s) => s.nodeId === 'e')?.outcome).toBe('ended');
  });

  it('follows the TRUE branch of a condition and skips the FALSE path', () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'c', type: 'control.condition', position: { x: 1, y: 0 }, config: { field: 'trigger.ratio', operator: 'gte', value: 2 } },
        { id: 'yes', type: 'action.pause', position: { x: 2, y: -1 }, config: { acknowledgeDestructive: false } },
        { id: 'no', type: 'action.stop', position: { x: 2, y: 1 } },
      ],
      edges: [
        { id: '1', sourceNodeId: 't', targetNodeId: 'c' },
        { id: '2', sourceNodeId: 'c', sourcePort: 'true', targetNodeId: 'yes' },
        { id: '3', sourceNodeId: 'c', sourcePort: 'false', targetNodeId: 'no' },
      ],
    };
    const r = simulateWorkflow(graph, { trigger: { ratio: 3 } }, registry);
    expect(r.reachedNodeIds).toContain('yes');
    expect(r.reachedNodeIds).not.toContain('no');
    expect(r.steps.find((s) => s.nodeId === 'c')?.detail).toContain('true');
  });

  it('renders {{template}} action inputs from the trigger context', () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'a', type: 'action.media_scan_library', position: { x: 1, y: 0 }, config: { libraryId: '{{trigger.lib}}' } },
      ],
      edges: [{ id: '1', sourceNodeId: 't', targetNodeId: 'a' }],
    };
    const r = simulateWorkflow(graph, { trigger: { lib: 'movies' } }, registry);
    expect(r.wouldExecute[0].input).toEqual({ libraryId: 'movies' });
  });

  it('sets variables and auto-approves approval nodes with a warning', () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'v', type: 'control.variable', position: { x: 1, y: 0 }, config: { key: 'count', value: '5' } },
        { id: 'ap', type: 'control.approval', position: { x: 2, y: 0 } },
        { id: 'e', type: 'control.end', position: { x: 3, y: 0 } },
      ],
      edges: [
        { id: '1', sourceNodeId: 't', targetNodeId: 'v' },
        { id: '2', sourceNodeId: 'v', targetNodeId: 'ap' },
        { id: '3', sourceNodeId: 'ap', sourcePort: 'approved', targetNodeId: 'e' },
      ],
    };
    const r = simulateWorkflow(graph, {}, registry);
    expect(r.variables.count).toBe('5');
    const ap = r.steps.find((s) => s.nodeId === 'ap');
    expect(ap?.outcome).toBe('requested_approval');
    expect(ap?.warnings?.length).toBeGreaterThan(0);
    expect(r.reachedNodeIds).toContain('e');
  });

  it('a join waits for all incoming branches', () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'p', type: 'control.parallel', position: { x: 1, y: 0 } },
        { id: 'a', type: 'control.transform', position: { x: 2, y: -1 } },
        { id: 'b', type: 'control.transform', position: { x: 2, y: 1 } },
        { id: 'j', type: 'control.join', position: { x: 3, y: 0 } },
      ],
      edges: [
        { id: '1', sourceNodeId: 't', targetNodeId: 'p' },
        { id: '2', sourceNodeId: 'p', sourcePort: 'branch', targetNodeId: 'a' },
        { id: '3', sourceNodeId: 'p', sourcePort: 'branch', targetNodeId: 'b' },
        { id: '4', sourceNodeId: 'a', targetNodeId: 'j' },
        { id: '5', sourceNodeId: 'b', targetNodeId: 'j' },
      ],
    };
    const r = simulateWorkflow(graph, {}, registry);
    expect(r.reachedNodeIds).toEqual(expect.arrayContaining(['a', 'b', 'j']));
  });
});
