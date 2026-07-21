import { UnprocessableEntityException, BadRequestException } from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { WorkflowNodeRegistry } from './node-registry.service';
import type { WorkflowGraph } from './domain/workflow-graph.types';

const registry = new WorkflowNodeRegistry();
const audit = { record: jest.fn() } as any;
const user = { id: 'u1', username: 'admin', roles: [], permissions: ['media_manager.scan'] } as any;

function validGraph(): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 } },
      { id: 'a', type: 'action.media_scan_library', position: { x: 1, y: 0 }, config: { libraryId: 'lib1' } },
    ],
    edges: [{ id: 'e1', sourceNodeId: 't', targetNodeId: 'a' }],
  };
}

describe('WorkflowService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('catalog() exposes the node registry and limits', () => {
    const svc = new WorkflowService({} as any, audit, registry);
    const cat = svc.catalog();
    expect(cat.nodes.length).toBe(registry.size);
    expect(cat.limits.maxNodes).toBeGreaterThan(0);
    expect(cat.schemaVersion).toBe(1);
  });

  it('validateGraph() reports an empty graph as invalid', () => {
    const svc = new WorkflowService({} as any, audit, registry);
    const r = svc.validateGraph({ schemaVersion: 1, nodes: [], edges: [] }, user);
    expect(r.valid).toBe(false);
  });

  it('validateGraph() accepts a well-formed graph the user is permitted to run', () => {
    const svc = new WorkflowService({} as any, audit, registry);
    expect(svc.validateGraph(validGraph(), user).valid).toBe(true);
  });

  it('publish() refuses an invalid draft graph with 422', async () => {
    const prisma = {
      workflow: { findUnique: jest.fn().mockResolvedValue({ id: 'w1', status: 'draft', currentDraftVersionId: 'v1', publishedVersionId: null }) },
      workflowVersion: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', versionNumber: 1, graph: { schemaVersion: 1, nodes: [], edges: [] }, changeNotes: null }) },
    } as any;
    const svc = new WorkflowService(prisma, audit, registry);
    await expect(svc.publish('w1', undefined, user)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('publish() freezes the draft and points publishedVersionId at it', async () => {
    const tx = {
      workflowVersion: { update: jest.fn().mockResolvedValue({}) },
      workflow: { update: jest.fn().mockResolvedValue({ id: 'w1', status: 'published', publishedVersionId: 'v1', currentDraftVersionId: null }) },
    };
    const prisma = {
      workflow: { findUnique: jest.fn().mockResolvedValue({ id: 'w1', status: 'ready', currentDraftVersionId: 'v1', publishedVersionId: null }) },
      workflowVersion: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', versionNumber: 1, graph: validGraph(), changeNotes: null }) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    } as any;
    const svc = new WorkflowService(prisma, audit, registry);
    const res = await svc.publish('w1', 'ship it', user);
    expect(res.versionId).toBe('v1');
    expect(tx.workflowVersion.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'published' }) }));
    expect(tx.workflow.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ publishedVersionId: 'v1', currentDraftVersionId: null }) }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'workflows.workflow.published' }));
  });

  it('publish() with no draft raises BadRequest', async () => {
    const prisma = {
      workflow: { findUnique: jest.fn().mockResolvedValue({ id: 'w1', status: 'published', currentDraftVersionId: null, publishedVersionId: 'v1' }) },
    } as any;
    const svc = new WorkflowService(prisma, audit, registry);
    await expect(svc.publish('w1', undefined, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an oversized graph', () => {
    const svc = new WorkflowService({} as any, audit, registry);
    const huge: WorkflowGraph = { schemaVersion: 1, nodes: [{ id: 'n', type: 'trigger.manual', position: { x: 0, y: 0 }, metadata: { blob: 'x'.repeat(600 * 1024) } }], edges: [] };
    expect(() => svc.validateGraph(huge, user)).toThrow(BadRequestException);
  });
});
