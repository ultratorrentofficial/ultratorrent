import {
  BadRequestException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { paginate, parsePage } from '../../common/pagination';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { WorkflowNodeRegistry } from './node-registry.service';
import { validateWorkflowGraph, WORKFLOW_LIMITS } from './domain/workflow-validator';
import { simulateWorkflow, type SimulationContext } from './domain/workflow-simulator';
import { graphChecksum } from './domain/workflow-checksum';
import { WORKFLOW_GRAPH_SCHEMA_VERSION, isWorkflowGraphShape } from './domain/workflow-graph.types';
import type { WorkflowGraph } from './domain/workflow-graph.types';
import { WorkflowSM } from './domain/workflow-status';
import type { WorkflowStatus } from './domain/workflow-status';
import {
  CreateWorkflowDto, UpdateWorkflowDto, WorkflowListQueryDto,
} from './dto/workflow.dto';

/** Serialized-graph size ceiling — rejects abusive payloads before deep validation. */
const MAX_GRAPH_BYTES = 512 * 1024;

const EMPTY_GRAPH: WorkflowGraph = { schemaVersion: WORKFLOW_GRAPH_SCHEMA_VERSION, nodes: [], edges: [] };

/**
 * CRUD + draft-versioning + publish for workflows. Versioning invariants (non-negotiable):
 * a workflow has at most one **mutable draft** version (`currentDraftVersionId`); publishing
 * freezes that draft (status `published`, immutable) and points `publishedVersionId` at it;
 * the next edit forks a fresh draft from the published graph. Published versions are never
 * mutated, so running executions stay pinned to the exact version they started on.
 */
@Injectable()
export class WorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: WorkflowNodeRegistry,
  ) {}

  // ── Read ────────────────────────────────────────────────────────────────────
  async list(query: WorkflowListQueryDto) {
    const params = parsePage(query.page, query.pageSize, 25, 200);
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (typeof query.enabled === 'boolean') where.enabled = query.enabled;
    if (query.workspaceKey) where.workspaceKey = query.workspaceKey;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    return paginate(this.prisma.workflow, {
      where,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, name: true, description: true, workspaceKey: true, enabled: true,
        status: true, tags: true, publishedVersionId: true, currentDraftVersionId: true,
        updatedAt: true, createdAt: true,
      },
    }, params);
  }

  async get(id: string) {
    const workflow = await this.prisma.workflow.findUnique({ where: { id } });
    if (!workflow) throw new NotFoundException('Workflow not found');
    const [draft, published] = await Promise.all([
      workflow.currentDraftVersionId
        ? this.prisma.workflowVersion.findUnique({ where: { id: workflow.currentDraftVersionId } })
        : null,
      workflow.publishedVersionId
        ? this.prisma.workflowVersion.findUnique({ where: { id: workflow.publishedVersionId } })
        : null,
    ]);
    return { workflow, draftVersion: draft, publishedVersion: published };
  }

  // ── Create / update metadata ─────────────────────────────────────────────────
  async create(dto: CreateWorkflowDto, user: AuthenticatedUser) {
    const checksum = graphChecksum(EMPTY_GRAPH);
    const workflow = await this.prisma.$transaction(async (tx) => {
      const wf = await tx.workflow.create({
        data: {
          name: dto.name,
          description: dto.description ?? null,
          workspaceKey: dto.workspaceKey ?? null,
          tags: dto.tags ?? [],
          status: 'draft',
          enabled: false,
          createdById: user.id,
          updatedById: user.id,
        },
      });
      const version = await tx.workflowVersion.create({
        data: {
          workflowId: wf.id,
          versionNumber: 1,
          status: 'draft',
          graph: EMPTY_GRAPH as unknown as object,
          checksum,
          createdById: user.id,
        },
      });
      return tx.workflow.update({ where: { id: wf.id }, data: { currentDraftVersionId: version.id } });
    });
    await this.audit.record({
      userId: user.id, action: 'workflows.workflow.created',
      objectType: 'workflow', objectId: workflow.id, metadata: { name: workflow.name },
    });
    return workflow;
  }

  async updateMeta(id: string, dto: UpdateWorkflowDto, user: AuthenticatedUser) {
    await this.mustExist(id);
    const workflow = await this.prisma.workflow.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.workspaceKey !== undefined ? { workspaceKey: dto.workspaceKey } : {}),
        ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
        updatedById: user.id,
      },
    });
    await this.audit.record({
      userId: user.id, action: 'workflows.workflow.updated',
      objectType: 'workflow', objectId: id,
    });
    return workflow;
  }

  // ── Draft graph editing ──────────────────────────────────────────────────────
  /** Save the (mutable) draft graph, forking a new draft from the published version if needed. */
  async saveDraft(id: string, graph: WorkflowGraph, changeNotes: string | undefined, user: AuthenticatedUser) {
    const workflow = await this.mustExist(id);
    this.assertGraphSize(graph);
    if (!isWorkflowGraphShape(graph)) throw new BadRequestException('Malformed workflow graph');

    const checksum = graphChecksum(graph);
    const validation = validateWorkflowGraph(graph, this.registry, {
      grantedPermissions: new Set(user.permissions ?? []),
      selfWorkflowId: id,
    });
    const versionStatus = validation.valid ? 'ready' : 'validation_failed';
    const triggerSummary = this.summarizeTriggers(graph);

    const draft = await this.ensureDraftVersion(workflow, user);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.workflowVersion.update({
        where: { id: draft.id },
        data: {
          graph: graph as unknown as object,
          checksum,
          status: versionStatus,
          triggerSummary: triggerSummary as unknown as object,
          requiredPermissions: this.collectRequiredPermissions(graph),
          changeNotes: changeNotes ?? draft.changeNotes ?? null,
        },
      });
      return tx.workflow.update({
        where: { id },
        data: { status: validation.valid ? 'ready' : 'validation_failed', updatedById: user.id },
      });
    });
    await this.audit.record({
      userId: user.id, action: 'workflows.draft.saved',
      objectType: 'workflow', objectId: id,
      result: validation.valid ? 'success' : 'failure',
      metadata: { versionId: draft.id, checksum, errors: validation.errors.length },
    });
    return { workflow: updated, versionId: draft.id, validation };
  }

  /** Stateless validation of an arbitrary graph (used by the editor before saving). */
  validateGraph(graph: WorkflowGraph, user: AuthenticatedUser, selfWorkflowId?: string) {
    this.assertGraphSize(graph);
    if (!isWorkflowGraphShape(graph)) throw new BadRequestException('Malformed workflow graph');
    return validateWorkflowGraph(graph, this.registry, {
      grantedPermissions: new Set(user.permissions ?? []),
      selfWorkflowId,
    });
  }

  // ── Publish / lifecycle ──────────────────────────────────────────────────────
  async publish(id: string, changeNotes: string | undefined, user: AuthenticatedUser) {
    const workflow = await this.mustExist(id);
    if (!workflow.currentDraftVersionId) {
      throw new BadRequestException('No draft changes to publish');
    }
    const draft = await this.prisma.workflowVersion.findUnique({ where: { id: workflow.currentDraftVersionId } });
    if (!draft) throw new BadRequestException('Draft version missing');

    const graph = draft.graph as unknown as WorkflowGraph;
    const validation = validateWorkflowGraph(graph, this.registry, {
      grantedPermissions: new Set(user.permissions ?? []),
      selfWorkflowId: id,
    });
    if (!validation.valid) {
      throw new UnprocessableEntityException({ message: 'Workflow is invalid', validation });
    }

    const published = await this.prisma.$transaction(async (tx) => {
      await tx.workflowVersion.update({
        where: { id: draft.id },
        data: {
          status: 'published',
          publishedAt: new Date(),
          changeNotes: changeNotes ?? draft.changeNotes ?? null,
          requiredPermissions: this.collectRequiredPermissions(graph),
        },
      });
      return tx.workflow.update({
        where: { id },
        // Freeze the draft as the published version; next edit forks a new draft.
        data: {
          status: 'published',
          publishedVersionId: draft.id,
          currentDraftVersionId: null,
          enabled: true,
          updatedById: user.id,
        },
      });
    });
    await this.audit.record({
      userId: user.id, action: 'workflows.workflow.published',
      objectType: 'workflow', objectId: id, result: 'success',
      metadata: { versionId: draft.id, versionNumber: draft.versionNumber },
    });
    return { workflow: published, versionId: draft.id };
  }

  async setEnabled(id: string, enabled: boolean, user: AuthenticatedUser) {
    const workflow = await this.mustExist(id);
    if (enabled && !workflow.publishedVersionId) {
      throw new BadRequestException('Publish the workflow before enabling it');
    }
    if (workflow.enabled === enabled) return workflow; // idempotent
    const next = enabled ? 'published' : 'disabled';
    WorkflowSM.assertTransition(workflow.status as WorkflowStatus, next);
    const updated = await this.prisma.workflow.update({
      where: { id }, data: { enabled, status: next, updatedById: user.id },
    });
    await this.audit.record({
      userId: user.id, action: enabled ? 'workflows.workflow.enabled' : 'workflows.workflow.disabled',
      objectType: 'workflow', objectId: id,
    });
    return updated;
  }

  async archive(id: string, user: AuthenticatedUser) {
    const workflow = await this.mustExist(id);
    WorkflowSM.assertTransition(workflow.status as WorkflowStatus, 'archived');
    const updated = await this.prisma.workflow.update({
      where: { id }, data: { status: 'archived', enabled: false, archivedAt: new Date(), updatedById: user.id },
    });
    await this.audit.record({
      userId: user.id, action: 'workflows.workflow.archived', objectType: 'workflow', objectId: id,
    });
    return updated;
  }

  async remove(id: string, user: AuthenticatedUser) {
    await this.mustExist(id);
    const active = await this.prisma.workflowExecution.count({
      where: { workflowId: id, status: { in: ['queued', 'scheduled', 'running', 'retrying', 'waiting', 'waiting_for_event', 'waiting_for_approval', 'paused', 'cancelling'] } },
    });
    if (active > 0) throw new BadRequestException(`Cannot delete a workflow with ${active} active execution(s)`);
    await this.prisma.workflow.delete({ where: { id } });
    await this.audit.record({
      userId: user.id, action: 'workflows.workflow.deleted', objectType: 'workflow', objectId: id,
    });
    return { deleted: true };
  }

  // ── Simulation (dry-run, no side effects) ────────────────────────────────────
  /**
   * Dry-run the workflow: evaluate conditions/branches/variables and render action inputs
   * with **no provider ever called**. Validates first (a graph must be publishable-shaped to
   * simulate meaningfully) and returns both the validation and the trace.
   */
  async simulate(id: string, override: SimulationContext & { graph?: WorkflowGraph }, user: AuthenticatedUser) {
    const workflow = await this.mustExist(id);
    let graph = override.graph;
    if (graph) {
      this.assertGraphSize(graph);
      if (!isWorkflowGraphShape(graph)) throw new BadRequestException('Malformed workflow graph');
    } else {
      const versionId = workflow.currentDraftVersionId ?? workflow.publishedVersionId;
      if (!versionId) throw new BadRequestException('Workflow has no graph to simulate');
      const version = await this.prisma.workflowVersion.findUnique({ where: { id: versionId } });
      graph = version?.graph as unknown as WorkflowGraph;
      if (!graph) throw new BadRequestException('Workflow graph not found');
    }
    const validation = validateWorkflowGraph(graph, this.registry, {
      grantedPermissions: new Set(user.permissions ?? []),
      selfWorkflowId: id,
    });
    const result = simulateWorkflow(graph, { trigger: override.trigger, vars: override.vars }, this.registry);
    await this.audit.record({
      userId: user.id, action: 'workflows.workflow.simulated',
      objectType: 'workflow', objectId: id,
      metadata: { steps: result.steps.length, wouldExecute: result.wouldExecute.length },
    });
    return { validation, simulation: result };
  }

  // ── Catalog ──────────────────────────────────────────────────────────────────
  /** The node palette + engine limits — drives the editor and keeps it catalog-accurate. */
  catalog() {
    return {
      schemaVersion: WORKFLOW_GRAPH_SCHEMA_VERSION,
      nodes: this.registry.list(),
      limits: WORKFLOW_LIMITS,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private async mustExist(id: string) {
    const workflow = await this.prisma.workflow.findUnique({ where: { id } });
    if (!workflow) throw new NotFoundException('Workflow not found');
    if (workflow.status === 'archived') throw new ForbiddenException('Workflow is archived');
    return workflow;
  }

  /** Return the current mutable draft, forking a new one from the published version if absent. */
  private async ensureDraftVersion(
    workflow: { id: string; currentDraftVersionId: string | null; publishedVersionId: string | null },
    user: AuthenticatedUser,
  ) {
    if (workflow.currentDraftVersionId) {
      const existing = await this.prisma.workflowVersion.findUnique({ where: { id: workflow.currentDraftVersionId } });
      if (existing && existing.status !== 'published') return existing;
    }
    const max = await this.prisma.workflowVersion.aggregate({
      where: { workflowId: workflow.id }, _max: { versionNumber: true },
    });
    const base = workflow.publishedVersionId
      ? await this.prisma.workflowVersion.findUnique({ where: { id: workflow.publishedVersionId } })
      : null;
    const draft = await this.prisma.workflowVersion.create({
      data: {
        workflowId: workflow.id,
        versionNumber: (max._max.versionNumber ?? 0) + 1,
        status: 'draft',
        graph: (base?.graph ?? EMPTY_GRAPH) as unknown as object,
        checksum: base?.checksum ?? graphChecksum(EMPTY_GRAPH),
        createdById: user.id,
      },
    });
    await this.prisma.workflow.update({ where: { id: workflow.id }, data: { currentDraftVersionId: draft.id } });
    return draft;
  }

  private collectRequiredPermissions(graph: WorkflowGraph): string[] {
    const perms = new Set<string>();
    for (const node of graph.nodes) {
      const def = this.registry.get(node.type);
      if (def?.requiredPermission) perms.add(def.requiredPermission);
    }
    return [...perms];
  }

  private summarizeTriggers(graph: WorkflowGraph) {
    const triggers = graph.nodes
      .filter((n) => this.registry.get(n.type)?.category === 'trigger')
      .map((n) => n.type);
    return { triggers };
  }

  private assertGraphSize(graph: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(graph ?? {}), 'utf8');
    if (bytes > MAX_GRAPH_BYTES) {
      throw new BadRequestException(`Graph exceeds the ${MAX_GRAPH_BYTES}-byte limit`);
    }
  }
}
