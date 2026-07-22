import { planExecution, type NodeRunState } from './execution-planner';
import type { WorkflowGraph } from './workflow-graph.types';

const lookup = {
  isJoin: (t: string) => t === 'control.join',
  isTrigger: (t: string) => t.startsWith('trigger.'),
};

function states(entries: Record<string, NodeRunState>): Map<string, NodeRunState> {
  return new Map(Object.entries(entries));
}

describe('planExecution', () => {
  const linear: WorkflowGraph = {
    schemaVersion: 1,
    nodes: [
      { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
      { id: 'a', type: 'action.pause', position: { x: 1, y: 0 } },
      { id: 'e', type: 'control.end', position: { x: 2, y: 0 } },
    ],
    edges: [
      { id: '1', sourceNodeId: 't', targetNodeId: 'a' },
      { id: '2', sourceNodeId: 'a', sourcePort: 'out', targetNodeId: 'e' },
    ],
  };

  it('starts with the trigger ready', () => {
    const v = planExecution(linear, states({}), lookup);
    expect(v.ready).toEqual(['t']);
    expect(v.quiescent).toBe(false);
  });

  it('advances to the next node once the predecessor succeeds and fires its port', () => {
    const v = planExecution(linear, states({
      t: { status: 'succeeded', firedPorts: ['out'] },
    }), lookup);
    expect(v.ready).toEqual(['a']);
  });

  it('is quiescent when the terminal node has completed', () => {
    const v = planExecution(linear, states({
      t: { status: 'succeeded', firedPorts: ['out'] },
      a: { status: 'succeeded', firedPorts: ['out'] },
      e: { status: 'succeeded', firedPorts: [] },
    }), lookup);
    expect(v.ready).toEqual([]);
    expect(v.quiescent).toBe(true);
  });

  it('marks the not-taken branch of a condition dead', () => {
    const g: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'c', type: 'control.condition', position: { x: 1, y: 0 } },
        { id: 'yes', type: 'action.pause', position: { x: 2, y: -1 } },
        { id: 'no', type: 'action.stop', position: { x: 2, y: 1 } },
      ],
      edges: [
        { id: '1', sourceNodeId: 't', targetNodeId: 'c' },
        { id: '2', sourceNodeId: 'c', sourcePort: 'true', targetNodeId: 'yes' },
        { id: '3', sourceNodeId: 'c', sourcePort: 'false', targetNodeId: 'no' },
      ],
    };
    const v = planExecution(g, states({
      t: { status: 'succeeded', firedPorts: ['out'] },
      c: { status: 'succeeded', firedPorts: ['true'] },
    }), lookup);
    expect(v.ready).toEqual(['yes']);
    expect(v.dead).toContain('no');
  });

  it('a join waits for all live inputs and is not ready until both arrive', () => {
    const g: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 'a', type: 'control.transform', position: { x: 0, y: -1 } },
        { id: 'b', type: 'control.transform', position: { x: 0, y: 1 } },
        { id: 'j', type: 'control.join', position: { x: 1, y: 0 } },
      ],
      edges: [
        { id: '1', sourceNodeId: 'a', targetNodeId: 'j' },
        { id: '2', sourceNodeId: 'b', targetNodeId: 'j' },
      ],
    };
    const partial = planExecution(g, states({
      a: { status: 'succeeded', firedPorts: ['out'] },
      b: { status: 'running', firedPorts: [] },
    }), lookup);
    expect(partial.ready).not.toContain('j');

    const both = planExecution(g, states({
      a: { status: 'succeeded', firedPorts: ['out'] },
      b: { status: 'succeeded', firedPorts: ['out'] },
    }), lookup);
    expect(both.ready).toContain('j');
  });

  it('skips a join when one incoming branch died', () => {
    const g: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 'a', type: 'control.transform', position: { x: 0, y: -1 } },
        { id: 'b', type: 'control.transform', position: { x: 0, y: 1 } },
        { id: 'j', type: 'control.join', position: { x: 1, y: 0 } },
      ],
      edges: [
        { id: '1', sourceNodeId: 'a', targetNodeId: 'j' },
        { id: '2', sourceNodeId: 'b', targetNodeId: 'j' },
      ],
    };
    const v = planExecution(g, states({
      a: { status: 'succeeded', firedPorts: ['out'] },
      b: { status: 'skipped', firedPorts: [] },
    }), lookup);
    expect(v.dead).toContain('j');
  });
});
