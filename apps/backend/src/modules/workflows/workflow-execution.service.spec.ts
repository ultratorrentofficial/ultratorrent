import { WorkflowExecutionService } from './workflow-execution.service';
import { WorkflowNodeRegistry } from './node-registry.service';
import type { WorkflowGraph } from './domain/workflow-graph.types';

/** A tiny in-memory Prisma double covering exactly the calls the executor makes. */
class FakePrisma {
  workflows = new Map<string, any>();
  versions = new Map<string, any>();
  execs = new Map<string, any>();
  nodeExecs: any[] = [];
  private seq = 0;

  workflow = {
    findUnique: async ({ where }: any) => this.workflows.get(where.id) ?? null,
  };
  workflowVersion = {
    findUnique: async ({ where }: any) => this.versions.get(where.id) ?? null,
  };
  workflowExecution = {
    create: async ({ data }: any) => { const id = `ex_${++this.seq}`; const row = { id, createdAt: new Date(), ...data }; this.execs.set(id, row); return row; },
    findUnique: async ({ where, include }: any) => {
      const row = this.execs.get(where.id) ?? null;
      if (row && include?.nodes) return { ...row, nodes: this.nodeExecs.filter((n) => n.workflowExecutionId === where.id) };
      return row;
    },
    update: async ({ where, data }: any) => { const row = this.execs.get(where.id); Object.assign(row, data); return row; },
    findMany: async () => [],
  };
  workflowNodeExecution = {
    findMany: async ({ where }: any) => this.nodeExecs.filter((n) => n.workflowExecutionId === where.workflowExecutionId),
    findFirst: async ({ where }: any) => this.nodeExecs.find((n) => n.workflowExecutionId === where.workflowExecutionId && n.nodeId === where.nodeId) ?? null,
    create: async ({ data }: any) => { const row = { id: `n_${++this.seq}`, ...data }; this.nodeExecs.push(row); return row; },
    update: async ({ where, data }: any) => { const row = this.nodeExecs.find((n) => n.id === where.id); Object.assign(row, data); return row; },
    updateMany: async () => ({ count: 0 }),
  };

  seedWorkflow(graph: WorkflowGraph) {
    this.versions.set('v1', { id: 'v1', workflowId: 'w1', graph });
    this.workflows.set('w1', { id: 'w1', status: 'published', publishedVersionId: 'v1', enabled: true });
    const exec = { id: 'e1', workflowId: 'w1', workflowVersionId: 'v1', status: 'queued', inputContext: {}, startedAt: null };
    this.execs.set('e1', exec);
    return 'e1';
  }
}

const registry = new WorkflowNodeRegistry();
const audit = { record: jest.fn() } as any;

function makeService(prisma: FakePrisma, run: jest.Mock) {
  const automation = { runWorkflowAction: run } as any;
  return new WorkflowExecutionService(prisma as any, audit, registry, automation);
}

const linear: WorkflowGraph = {
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

describe('WorkflowExecutionService.runExecution', () => {
  beforeEach(() => jest.clearAllMocks());

  it('runs a linear graph, dispatching the action once, and completes', async () => {
    const prisma = new FakePrisma();
    const id = prisma.seedWorkflow(linear);
    const run = jest.fn().mockResolvedValue(undefined);
    await makeService(prisma, run).runExecution(id);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('media_scan_library', { libraryId: 'lib1' }, expect.any(Object));
    expect(prisma.execs.get('e1').status).toBe('completed');
    expect(prisma.nodeExecs.find((n) => n.nodeId === 'a')?.status).toBe('succeeded');
  });

  it('fails the execution when an action fails and there is no failure branch', async () => {
    const prisma = new FakePrisma();
    const id = prisma.seedWorkflow(linear);
    const run = jest.fn().mockRejectedValue(new Error('boom'));
    await makeService(prisma, run).runExecution(id);

    expect(prisma.execs.get('e1').status).toBe('failed');
    expect(prisma.nodeExecs.find((n) => n.nodeId === 'a')?.status).toBe('failed');
  });

  it('retries a failing action up to maxAttempts then succeeds', async () => {
    const prisma = new FakePrisma();
    const graph: WorkflowGraph = {
      ...linear,
      nodes: [
        linear.nodes[0],
        { ...linear.nodes[1], retryPolicy: { maxAttempts: 3 } },
        linear.nodes[2],
      ],
    };
    const id = prisma.seedWorkflow(graph);
    const run = jest.fn()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockResolvedValueOnce(undefined);
    await makeService(prisma, run).runExecution(id);

    expect(run).toHaveBeenCalledTimes(3);
    expect(prisma.execs.get('e1').status).toBe('completed');
  });

  it('routes a failed action to its failure branch and continues', async () => {
    const prisma = new FakePrisma();
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'a', type: 'action.media_scan_library', position: { x: 1, y: 0 } },
        { id: 'rescue', type: 'control.end', position: { x: 2, y: 0 } },
      ],
      edges: [
        { id: '1', sourceNodeId: 't', targetNodeId: 'a' },
        { id: '2', sourceNodeId: 'a', sourcePort: 'failure', targetNodeId: 'rescue' },
      ],
    };
    const id = prisma.seedWorkflow(graph);
    const run = jest.fn().mockRejectedValue(new Error('boom'));
    await makeService(prisma, run).runExecution(id);

    // Action failed but the failure branch was taken → execution not marked failed.
    expect(prisma.execs.get('e1').status).toBe('completed');
    expect(prisma.nodeExecs.find((n) => n.nodeId === 'rescue')?.status).toBe('succeeded');
  });

  it('evaluates a condition and only runs the taken branch', async () => {
    const prisma = new FakePrisma();
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'c', type: 'control.condition', position: { x: 1, y: 0 }, config: { field: 'trigger.ratio', operator: 'gte', value: 2 } },
        { id: 'hi', type: 'action.media_scan_library', position: { x: 2, y: -1 } },
        { id: 'lo', type: 'action.media_match', position: { x: 2, y: 1 } },
      ],
      edges: [
        { id: '1', sourceNodeId: 't', targetNodeId: 'c' },
        { id: '2', sourceNodeId: 'c', sourcePort: 'true', targetNodeId: 'hi' },
        { id: '3', sourceNodeId: 'c', sourcePort: 'false', targetNodeId: 'lo' },
      ],
    };
    prisma.versions.set('v1', { id: 'v1', workflowId: 'w1', graph });
    prisma.workflows.set('w1', { id: 'w1', status: 'published', publishedVersionId: 'v1', enabled: true });
    prisma.execs.set('e1', { id: 'e1', workflowId: 'w1', workflowVersionId: 'v1', status: 'queued', inputContext: { ratio: 5 }, startedAt: null });

    const run = jest.fn().mockResolvedValue(undefined);
    await makeService(prisma, run).runExecution('e1');

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('media_scan_library', expect.any(Object), expect.any(Object));
    expect(prisma.nodeExecs.find((n) => n.nodeId === 'lo')?.status).toBe('skipped');
  });

  it('pauses at a delay node (durable wait) instead of completing', async () => {
    const prisma = new FakePrisma();
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'd', type: 'control.delay', position: { x: 1, y: 0 }, config: { duration: 3600 } },
        { id: 'e', type: 'control.end', position: { x: 2, y: 0 } },
      ],
      edges: [
        { id: '1', sourceNodeId: 't', targetNodeId: 'd' },
        { id: '2', sourceNodeId: 'd', targetNodeId: 'e' },
      ],
    };
    const id = prisma.seedWorkflow(graph);
    const run = jest.fn();
    await makeService(prisma, run).runExecution(id);

    expect(prisma.execs.get('e1').status).toBe('waiting');
    expect(prisma.execs.get('e1').resumeAt).toBeInstanceOf(Date);
    expect(prisma.nodeExecs.find((n) => n.nodeId === 'e')).toBeUndefined(); // never reached the end
  });
});
