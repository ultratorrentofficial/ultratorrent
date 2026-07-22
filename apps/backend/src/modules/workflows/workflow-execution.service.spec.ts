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
  approvals: any[] = [];
  users = new Map<string, any>();

  user = {
    findUnique: async ({ where }: any) => this.users.get(where.id) ?? null,
  };

  seedUser(id: string, superAdmin: boolean, permissions: string[]) {
    this.users.set(id, {
      id,
      roles: [{ role: { name: superAdmin ? 'SUPER_ADMIN' : 'USER', permissions: permissions.map((k) => ({ permission: { key: k } })) } }],
    });
  }

  workflowNodeExecution = {
    findMany: async ({ where }: any) => this.nodeExecs.filter((n) => n.workflowExecutionId === where.workflowExecutionId),
    findFirst: async ({ where }: any) => this.nodeExecs.find((n) =>
      n.workflowExecutionId === where.workflowExecutionId
      && (where.nodeId === undefined || n.nodeId === where.nodeId)
      && (where.status === undefined || n.status === where.status)) ?? null,
    create: async ({ data }: any) => { const row = { id: `n_${++this.seq}`, ...data }; this.nodeExecs.push(row); return row; },
    update: async ({ where, data }: any) => { const row = this.nodeExecs.find((n) => n.id === where.id); Object.assign(row, data); return row; },
    updateMany: async ({ where, data }: any) => {
      const rows = this.nodeExecs.filter((n) => n.workflowExecutionId === where.workflowExecutionId && (where.nodeId === undefined || n.nodeId === where.nodeId) && (where.status === undefined || n.status === where.status));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  };

  workflowApproval = {
    create: async ({ data }: any) => { const row = { id: `ap_${++this.seq}`, requestedAt: new Date(), ...data }; this.approvals.push(row); return row; },
    findUnique: async ({ where }: any) => this.approvals.find((a) => a.id === where.id) ?? null,
    findMany: async ({ where }: any) => this.approvals.filter((a) => !where?.status || a.status === where.status),
    update: async ({ where, data }: any) => { const row = this.approvals.find((a) => a.id === where.id); Object.assign(row, data); return row; },
    updateMany: async ({ where, data }: any) => { const rows = this.approvals.filter((a) => a.workflowExecutionId === where.workflowExecutionId && a.status === where.status); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; },
  };

  seedWorkflow(graph: WorkflowGraph) {
    this.versions.set('v1', { id: 'v1', workflowId: 'w1', graph });
    this.workflows.set('w1', { id: 'w1', status: 'published', publishedVersionId: 'v1', enabled: true });
    const exec = { id: 'e1', workflowId: 'w1', workflowVersionId: 'v1', status: 'queued', inputContext: {}, startedAt: null, jobId: null };
    this.execs.set('e1', exec);
    return 'e1';
  }
}

const registry = new WorkflowNodeRegistry();
const audit = { record: jest.fn() } as any;
const user = { id: 'u1', username: 'admin', roles: [], permissions: [] } as any;

/** No-op Jobs Center mirror — the bridge is best-effort and must not affect execution logic. */
const jobBridge = {
  createExecutionJob: jest.fn().mockResolvedValue(null),
  park: jest.fn(), unpark: jest.fn(), finish: jest.fn(),
  startNodeJob: jest.fn().mockResolvedValue(null), finishNodeJob: jest.fn(), cancelJob: jest.fn(),
} as any;

const eventBus = { emit: jest.fn() } as any;

function makeService(prisma: FakePrisma, run: jest.Mock) {
  const automation = { runWorkflowAction: run } as any;
  return new WorkflowExecutionService(prisma as any, audit, registry, automation, jobBridge, eventBus);
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

  it('resumes a delayed execution and completes it (Phase 7)', async () => {
    const prisma = new FakePrisma();
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'd', type: 'control.delay', position: { x: 1, y: 0 }, config: { duration: 60 } },
        { id: 'a', type: 'action.media_scan_library', position: { x: 2, y: 0 } },
      ],
      edges: [
        { id: '1', sourceNodeId: 't', targetNodeId: 'd' },
        { id: '2', sourceNodeId: 'd', targetNodeId: 'a' },
      ],
    };
    const id = prisma.seedWorkflow(graph);
    const run = jest.fn().mockResolvedValue(undefined);
    const svc = makeService(prisma, run);
    await svc.runExecution(id);
    expect(prisma.execs.get('e1').status).toBe('waiting');
    expect(run).not.toHaveBeenCalled();

    await svc.resume('e1', 'out'); // scheduler tick would call this
    expect(prisma.execs.get('e1').status).toBe('completed');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('creates an approval gate, then an approval decision resumes it', async () => {
    const prisma = new FakePrisma();
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'ap', type: 'control.approval', position: { x: 1, y: 0 } },
        { id: 'a', type: 'action.media_scan_library', position: { x: 2, y: 0 } },
      ],
      edges: [
        { id: '1', sourceNodeId: 't', targetNodeId: 'ap' },
        { id: '2', sourceNodeId: 'ap', sourcePort: 'approved', targetNodeId: 'a' },
      ],
    };
    const id = prisma.seedWorkflow(graph);
    const run = jest.fn().mockResolvedValue(undefined);
    const svc = makeService(prisma, run);
    await svc.runExecution(id);

    expect(prisma.execs.get('e1').status).toBe('waiting_for_approval');
    expect(prisma.approvals).toHaveLength(1);
    expect(prisma.approvals[0].status).toBe('pending');

    await svc.respondToApproval(prisma.approvals[0].id, 'approved', user);
    expect(prisma.approvals[0].status).toBe('approved');
    expect(prisma.execs.get('e1').status).toBe('completed');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a rejected approval routes down the reject branch, not the approve branch', async () => {
    const prisma = new FakePrisma();
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'ap', type: 'control.approval', position: { x: 1, y: 0 } },
        { id: 'a', type: 'action.media_scan_library', position: { x: 2, y: -1 } },
        { id: 'r', type: 'control.end', position: { x: 2, y: 1 } },
      ],
      edges: [
        { id: '1', sourceNodeId: 't', targetNodeId: 'ap' },
        { id: '2', sourceNodeId: 'ap', sourcePort: 'approved', targetNodeId: 'a' },
        { id: '3', sourceNodeId: 'ap', sourcePort: 'rejected', targetNodeId: 'r' },
      ],
    };
    const id = prisma.seedWorkflow(graph);
    const run = jest.fn().mockResolvedValue(undefined);
    const svc = makeService(prisma, run);
    await svc.runExecution(id);
    await svc.respondToApproval(prisma.approvals[0].id, 'rejected', user);

    expect(run).not.toHaveBeenCalled(); // approve branch (the action) never ran
    expect(prisma.nodeExecs.find((n) => n.nodeId === 'a')?.status).toBe('skipped');
    expect(prisma.execs.get('e1').status).toBe('completed');
  });

  it('mirrors into the Jobs Center: long-running node → child job, finished on completion', async () => {
    const prisma = new FakePrisma();
    const id = prisma.seedWorkflow(linear); // action.media_scan_library is long-running
    const run = jest.fn().mockResolvedValue(undefined);
    jobBridge.startNodeJob.mockResolvedValueOnce('childjob1');
    await makeService(prisma, run).runExecution(id);

    expect(jobBridge.startNodeJob).toHaveBeenCalledWith(null, 'e1', 'a', 'media_scan_library');
    expect(jobBridge.finishNodeJob).toHaveBeenCalledWith('childjob1', true);
    expect(jobBridge.finish).toHaveBeenCalledWith(null, 'completed');
    expect(prisma.nodeExecs.find((n) => n.nodeId === 'a')?.jobId).toBe('childjob1');
  });

  it('start() creates a parent Jobs Center job and stores its id on the execution', async () => {
    const prisma = new FakePrisma();
    prisma.versions.set('v1', { id: 'v1', workflowId: 'w1', graph: { schemaVersion: 1, nodes: [{ id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } }], edges: [] } });
    prisma.workflows.set('w1', { id: 'w1', name: 'WF', status: 'published', publishedVersionId: 'v1', enabled: true });
    jobBridge.createExecutionJob.mockResolvedValueOnce('pjob1');
    const svc = makeService(prisma, jest.fn());
    const { executionId } = await svc.start('w1', { triggerSource: 'manual', identityUserId: 'u1' });

    expect(jobBridge.createExecutionJob).toHaveBeenCalledWith(executionId, 'w1', 'WF', 'u1');
    expect(prisma.execs.get(executionId)?.jobId).toBe('pjob1');
  });

  it('denies an action the run identity lacks permission for (least-privilege re-check)', async () => {
    const prisma = new FakePrisma();
    prisma.seedWorkflow(linear); // action.media_scan_library requires media_manager.scan
    prisma.seedUser('u1', false, []); // identity holds NO permissions
    prisma.execs.get('e1').executionIdentityUserId = 'u1';
    const run = jest.fn().mockResolvedValue(undefined);
    await makeService(prisma, run).runExecution('e1');

    expect(run).not.toHaveBeenCalled(); // never dispatched
    const node = prisma.nodeExecs.find((n) => n.nodeId === 'a');
    expect(node?.status).toBe('failed');
    expect(node?.errorMessage).toContain('permission_denied');
    expect(prisma.execs.get('e1').status).toBe('failed');
  });

  it('allows an action when the run identity holds the permission (or is super-admin)', async () => {
    const prisma = new FakePrisma();
    prisma.seedWorkflow(linear);
    prisma.seedUser('u1', false, ['media_manager.scan']);
    prisma.execs.get('e1').executionIdentityUserId = 'u1';
    const run = jest.fn().mockResolvedValue(undefined);
    await makeService(prisma, run).runExecution('e1');
    expect(run).toHaveBeenCalledTimes(1);
    expect(prisma.execs.get('e1').status).toBe('completed');
  });

  it('emits a Notification Center event when an execution fails', async () => {
    const prisma = new FakePrisma();
    prisma.seedWorkflow(linear);
    const run = jest.fn().mockRejectedValue(new Error('boom'));
    await makeService(prisma, run).runExecution('e1');
    expect(eventBus.emit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ event: 'workflow.execution.failed' }));
  });

  it('preserves variables across a durable pause', async () => {
    const prisma = new FakePrisma();
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'v', type: 'control.variable', position: { x: 1, y: 0 }, config: { key: 'lib', value: 'movies' } },
        { id: 'd', type: 'control.delay', position: { x: 2, y: 0 }, config: { duration: 60 } },
        { id: 'a', type: 'action.media_scan_library', position: { x: 3, y: 0 }, config: { libraryId: '{{vars.lib}}' } },
      ],
      edges: [
        { id: '1', sourceNodeId: 't', targetNodeId: 'v' },
        { id: '2', sourceNodeId: 'v', targetNodeId: 'd' },
        { id: '3', sourceNodeId: 'd', targetNodeId: 'a' },
      ],
    };
    const id = prisma.seedWorkflow(graph);
    const run = jest.fn().mockResolvedValue(undefined);
    const svc = makeService(prisma, run);
    await svc.runExecution(id);
    expect(prisma.execs.get('e1').outputSummary?.vars).toEqual({ lib: 'movies' });

    await svc.resume('e1', 'out');
    // The action, run after resume, received the variable set BEFORE the pause.
    expect(run).toHaveBeenCalledWith('media_scan_library', { libraryId: 'movies' }, expect.any(Object));
  });
});
