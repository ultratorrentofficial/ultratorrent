import { graphChecksum } from './workflow-checksum';
import type { WorkflowGraph } from './workflow-graph.types';

const base: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [
    { id: 'n1', type: 'trigger.torrent.completed', position: { x: 0, y: 0 } },
    { id: 'n2', type: 'action.media_scan_library', position: { x: 100, y: 0 }, config: { libraryId: 'lib1' } },
  ],
  edges: [{ id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2' }],
};

describe('graphChecksum', () => {
  it('is stable and 64-hex', () => {
    const c = graphChecksum(base);
    expect(c).toMatch(/^[0-9a-f]{64}$/);
    expect(graphChecksum(base)).toBe(c);
  });

  it('ignores node/edge order and layout (position, viewport)', () => {
    const reordered: WorkflowGraph = {
      ...base,
      nodes: [
        { id: 'n2', type: 'action.media_scan_library', position: { x: 999, y: 999 }, config: { libraryId: 'lib1' } },
        { id: 'n1', type: 'trigger.torrent.completed', position: { x: 50, y: 50 } },
      ],
      viewport: { x: 10, y: 10, zoom: 2 },
    };
    expect(graphChecksum(reordered)).toBe(graphChecksum(base));
  });

  it('is insensitive to config key order but sensitive to config values', () => {
    const sameConfigDifferentKeyOrder: WorkflowGraph = {
      ...base,
      nodes: [
        base.nodes[0],
        { id: 'n2', type: 'action.media_scan_library', position: { x: 100, y: 0 }, config: { libraryId: 'lib1' } },
      ],
    };
    expect(graphChecksum(sameConfigDifferentKeyOrder)).toBe(graphChecksum(base));

    const changedValue: WorkflowGraph = {
      ...base,
      nodes: [base.nodes[0], { ...base.nodes[1], config: { libraryId: 'lib2' } }],
    };
    expect(graphChecksum(changedValue)).not.toBe(graphChecksum(base));
  });

  it('changes when an edge changes', () => {
    const changed: WorkflowGraph = { ...base, edges: [{ id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', label: 'success' }] };
    expect(graphChecksum(changed)).not.toBe(graphChecksum(base));
  });
});
