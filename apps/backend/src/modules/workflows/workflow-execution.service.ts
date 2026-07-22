import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AutomationEngine } from '../automation/automation.module';
import { WorkflowNodeRegistry } from './node-registry.service';
import { planExecution, type NodeRunState, type NodeRunStatus } from './domain/execution-planner';
import { evaluateCondition } from './domain/condition-eval';
import { renderConfig, renderValue } from './domain/template';
import { EXECUTION_ACTIVE } from './domain/workflow-status';
import type { WorkflowGraph, WorkflowNode } from './domain/workflow-graph.types';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/** Node categories that suspend the run for a time/event/approval — resumed by Phase 7. */
const PAUSING = new Set(['delay', 'wait', 'approval']);

/** Widened (string-keyed) view of the active-status set for comparing raw DB status columns. */
const ACTIVE_STATUSES: ReadonlySet<string> = EXECUTION_ACTIVE;

export interface StartExecutionInput {
  triggerType?: string;
  triggerSource?: 'event' | 'manual' | 'scheduled' | 'subworkflow' | 'webhook';
  triggerEventId?: string;
  correlationId?: string;
  context?: Record<string, unknown>;
  identityUserId?: string;
}

/**
 * The **durable workflow executor**. An execution is pinned to the immutable
 * `WorkflowVersion` it started on; all progress is persisted to `workflow_node_executions`,
 * so the run is **restart-safe** — {@link planExecution} recomputes the next wave purely from
 * the database. Actions are dispatched by **reusing the Automation Engine** (never
 * reimplemented). Retries, per-node timeouts, and cooperative cancellation are honored.
 *
 * Phase-6 scope: the synchronous node set (trigger/condition/branch/action/variable/transform/
 * parallel/join/end). Delay/wait/approval nodes are persisted as durable pause points
 * (`waiting`/`waiting_for_approval` with `resumeAt`/`expiresAt`) and resumed in Phase 7; the
 * Jobs-Center parent/child-job linking is deepened in Phase 8.
 */
@Injectable()
export class WorkflowExecutionService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: WorkflowNodeRegistry,
    private readonly automation: AutomationEngine,
  ) {}

  /** On boot, resume executions interrupted by a process restart (crash-safe). */
  async onModuleInit(): Promise<void> {
    try {
      const orphans = await this.prisma.workflowExecution.findMany({
        where: { status: { in: ['queued', 'running', 'retrying'] } },
        select: { id: true },
        take: 100,
      });
      for (const { id } of orphans) {
        // A node left 'running' by a crash can't be safely re-dispatched (side effects are not
        // idempotent) — mark it failed, then let the graph's error policy decide on resume.
        await this.prisma.workflowNodeExecution.updateMany({
          where: { workflowExecutionId: id, status: 'running' },
          data: { status: 'failed', errorCode: 'interrupted', errorMessage: 'Process restarted mid-node' },
        });
        this.runExecution(id).catch((err) => this.logger.error(`Resume ${id} failed: ${(err as Error).message}`));
      }
      if (orphans.length) this.logger.log(`Resuming ${orphans.length} interrupted workflow execution(s)`);
    } catch (err) {
      this.logger.error(`Boot recovery failed: ${(err as Error).message}`);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  async start(workflowId: string, input: StartExecutionInput): Promise<{ executionId: string }> {
    const workflow = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) throw new NotFoundException('Workflow not found');
    if (!workflow.publishedVersionId) throw new BadRequestException('Workflow has no published version to run');

    const execution = await this.prisma.workflowExecution.create({
      data: {
        workflowId,
        workflowVersionId: workflow.publishedVersionId, // version-pinned
        status: 'queued',
        triggerType: input.triggerType ?? null,
        triggerSource: input.triggerSource ?? 'manual',
        triggerEventId: input.triggerEventId ?? null,
        correlationId: input.correlationId ?? null,
        inputContext: (input.context ?? {}) as object,
        executionIdentityUserId: input.identityUserId ?? null,
      },
    });
    await this.audit.record({
      userId: input.identityUserId, action: 'workflows.execution.started',
      objectType: 'workflow_execution', objectId: execution.id,
      metadata: { workflowId, source: input.triggerSource ?? 'manual' },
    });
    // Fire-and-forget the run; progress is durable so a crash mid-run is recoverable.
    this.runExecution(execution.id).catch((err) => this.logger.error(`Run ${execution.id}: ${(err as Error).message}`));
    return { executionId: execution.id };
  }

  async startManual(workflowId: string, context: Record<string, unknown>, user: AuthenticatedUser) {
    return this.start(workflowId, { triggerSource: 'manual', triggerType: 'manual', context, identityUserId: user.id });
  }

  async cancel(executionId: string, user: AuthenticatedUser) {
    const execution = await this.prisma.workflowExecution.findUnique({ where: { id: executionId } });
    if (!execution) throw new NotFoundException('Execution not found');
    if (!ACTIVE_STATUSES.has(execution.status)) {
      throw new BadRequestException(`Execution is ${execution.status} and cannot be cancelled`);
    }
    await this.prisma.workflowExecution.update({ where: { id: executionId }, data: { status: 'cancelling' } });
    await this.audit.record({
      userId: user.id, action: 'workflows.execution.cancelled', objectType: 'workflow_execution', objectId: executionId,
    });
    return { status: 'cancelling' };
  }

  async listExecutions(workflowId: string, take = 25) {
    return this.prisma.workflowExecution.findMany({
      where: { workflowId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 100),
      select: {
        id: true, status: true, triggerSource: true, triggerType: true,
        startedAt: true, completedAt: true, failedAt: true, createdAt: true,
      },
    });
  }

  async getExecution(executionId: string) {
    const execution = await this.prisma.workflowExecution.findUnique({
      where: { id: executionId },
      include: { nodes: { orderBy: { createdAt: 'asc' } } },
    });
    if (!execution) throw new NotFoundException('Execution not found');
    return execution;
  }

  // ── The durable run loop ──────────────────────────────────────────────────
  async runExecution(executionId: string): Promise<void> {
    const execution = await this.prisma.workflowExecution.findUnique({ where: { id: executionId } });
    if (!execution || !ACTIVE_STATUSES.has(execution.status)) return;

    const version = await this.prisma.workflowVersion.findUnique({ where: { id: execution.workflowVersionId } });
    const graph = version?.graph as unknown as WorkflowGraph | undefined;
    if (!graph) { await this.finalize(executionId, 'failed', 'missing_version'); return; }

    const byId = new Map<string, WorkflowNode>(graph.nodes.map((n) => [n.id, n]));
    // Nodes that actually wire up a `failure` output — only these survive a failed action.
    const failureBranchNodes = new Set(
      graph.edges.filter((e) => (e.sourcePort ?? 'out') === 'failure').map((e) => e.sourceNodeId),
    );
    const states = await this.loadStates(executionId);
    const context: Record<string, unknown> = {
      trigger: (execution.inputContext ?? {}) as Record<string, unknown>,
      vars: {},
      ...((execution.inputContext ?? {}) as Record<string, unknown>),
    };
    const lookup = {
      isJoin: (t: string) => this.registry.get(t)?.category === 'join',
      isTrigger: (t: string) => this.registry.get(t)?.category === 'trigger',
    };

    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: { status: 'running', startedAt: execution.startedAt ?? new Date(), heartbeatAt: new Date() },
    });

    let warnings = false;
    let failed = false;
    const maxIterations = graph.nodes.length * 3 + 5;

    for (let iter = 0; iter < maxIterations; iter++) {
      // Cooperative cancellation.
      const live = await this.prisma.workflowExecution.findUnique({ where: { id: executionId }, select: { status: true } });
      if (live?.status === 'cancelling') { await this.finalize(executionId, 'cancelled'); return; }

      const view = planExecution(graph, states, lookup);

      // Prune dead branches.
      for (const deadId of view.dead) {
        if (states.get(deadId)?.status === 'skipped') continue;
        await this.persistNode(executionId, byId.get(deadId)!, 'skipped', []);
        states.set(deadId, { status: 'skipped', firedPorts: [] });
      }

      if (view.ready.length === 0) {
        if (view.quiescent) break;
        // Nothing ready but not quiescent → only paused nodes remain (handled below); stop.
        if (view.dead.length === 0) break;
        continue;
      }

      for (const nodeId of view.ready) {
        const node = byId.get(nodeId)!;
        const def = this.registry.get(node.type);
        const category = def?.category ?? 'unknown';

        if (PAUSING.has(category)) {
          await this.pauseAt(executionId, node, category);
          return; // durable pause — resumed in Phase 7
        }

        const outcome = await this.processNode(node, category, context, failureBranchNodes.has(nodeId));
        states.set(nodeId, { status: outcome.status, firedPorts: outcome.firedPorts });
        await this.persistNode(executionId, node, outcome.status, outcome.firedPorts, outcome.error, outcome.attempt);
        if (outcome.warning) warnings = true;
        if (outcome.status === 'failed' && !outcome.handledByFailureBranch) { failed = true; break; }
      }
      if (failed) break;
      await this.prisma.workflowExecution.update({ where: { id: executionId }, data: { heartbeatAt: new Date() } });
    }

    await this.finalize(executionId, failed ? 'failed' : warnings ? 'completed_with_warnings' : 'completed');
  }

  // ── Node processing ───────────────────────────────────────────────────────
  private async processNode(
    node: WorkflowNode,
    category: string,
    context: Record<string, unknown>,
    hasFailureEdge: boolean,
  ): Promise<{ status: NodeRunStatus; firedPorts: string[]; warning?: boolean; error?: string; attempt?: number; handledByFailureBranch?: boolean }> {
    const def = this.registry.get(node.type);
    const outs = def?.ports.outputs ?? ['out'];

    switch (category) {
      case 'trigger':
        return { status: 'succeeded', firedPorts: ['out'] };
      case 'condition': {
        const cond = readCondition(node);
        const result = cond ? evaluateCondition(cond, context) : true;
        return { status: 'succeeded', firedPorts: [result ? 'true' : 'false'] };
      }
      case 'branch':
        return { status: 'succeeded', firedPorts: [chooseBranch(node, context, outs)] };
      case 'variable': {
        const key = String(node.config?.key ?? '');
        if (key) (context.vars as Record<string, unknown>)[key] = renderValue(node.config?.value, context);
        return { status: 'succeeded', firedPorts: ['out'] };
      }
      case 'end':
        return { status: 'succeeded', firedPorts: [] };
      case 'action':
        return this.dispatchAction(node, def?.actionId, context, hasFailureEdge);
      default:
        // transform / parallel / join: pure pass-through.
        return { status: 'succeeded', firedPorts: outs.length ? outs : ['out'] };
    }
  }

  /** Dispatch an action via the Automation Engine, honoring retry + timeout policy. */
  private async dispatchAction(
    node: WorkflowNode,
    actionId: string | undefined,
    context: Record<string, unknown>,
    hasFailureEdge: boolean,
  ): Promise<{ status: NodeRunStatus; firedPorts: string[]; error?: string; attempt?: number; handledByFailureBranch?: boolean }> {
    if (!actionId) return { status: 'failed', firedPorts: [], error: 'no_action_id' };
    const params = renderConfig(node.config ?? {}, context);
    const maxAttempts = Math.max(1, Number(node.retryPolicy?.maxAttempts ?? 1));
    const timeoutMs = Number(node.timeoutSeconds ?? 0) * 1000;

    let lastError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await withTimeout(this.automation.runWorkflowAction(actionId, params, context), timeoutMs);
        return { status: 'succeeded', firedPorts: ['out'], attempt };
      } catch (err) {
        lastError = (err as Error).message;
        if (attempt >= maxAttempts) break;
      }
    }
    // Exhausted: route to the failure branch if one is wired, else fail the node/execution.
    return {
      status: 'failed',
      firedPorts: hasFailureEdge ? ['failure'] : [],
      error: lastError,
      attempt: maxAttempts,
      handledByFailureBranch: hasFailureEdge,
    };
  }

  // ── Persistence helpers ───────────────────────────────────────────────────
  private async loadStates(executionId: string): Promise<Map<string, NodeRunState>> {
    const rows = await this.prisma.workflowNodeExecution.findMany({ where: { workflowExecutionId: executionId } });
    const map = new Map<string, NodeRunState>();
    for (const r of rows) {
      const fired = ((r.outputSummary as { firedPorts?: string[] } | null)?.firedPorts) ?? [];
      map.set(r.nodeId, { status: r.status as NodeRunStatus, firedPorts: fired });
    }
    return map;
  }

  private async persistNode(
    executionId: string, node: WorkflowNode, status: NodeRunStatus, firedPorts: string[],
    error?: string, attempt?: number,
  ): Promise<void> {
    const existing = await this.prisma.workflowNodeExecution.findFirst({
      where: { workflowExecutionId: executionId, nodeId: node.id }, select: { id: true },
    });
    const data = {
      status,
      attempt: attempt ?? 1,
      outputSummary: { firedPorts } as object,
      errorMessage: error ?? null,
      errorCode: error ? 'action_failed' : null,
      completedAt: ['succeeded', 'failed', 'skipped'].includes(status) ? new Date() : null,
      startedAt: new Date(),
    };
    if (existing) {
      await this.prisma.workflowNodeExecution.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.workflowNodeExecution.create({
        data: { workflowExecutionId: executionId, nodeId: node.id, nodeType: node.type, ...data },
      });
    }
  }

  private async pauseAt(executionId: string, node: WorkflowNode, category: string): Promise<void> {
    const now = Date.now();
    const resumeAt = category === 'delay'
      ? new Date(now + Number(node.config?.duration ?? 0) * 1000)
      : null;
    const expiresAt = node.timeoutSeconds ? new Date(now + Number(node.timeoutSeconds) * 1000) : null;
    await this.persistNode(executionId, node, 'waiting', []);
    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: {
        status: category === 'approval' ? 'waiting_for_approval' : 'waiting',
        resumeAt, expiresAt, heartbeatAt: new Date(),
      },
    });
  }

  private async finalize(executionId: string, status: string, reason?: string): Promise<void> {
    const now = new Date();
    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: {
        status,
        completedAt: status === 'completed' || status === 'completed_with_warnings' ? now : null,
        failedAt: status === 'failed' ? now : null,
        cancelledAt: status === 'cancelled' ? now : null,
        outputSummary: reason ? ({ reason } as object) : undefined,
      },
    });
    await this.audit.record({
      action: `workflows.execution.${status}`, objectType: 'workflow_execution', objectId: executionId,
      result: status === 'failed' ? 'failure' : 'success',
    });
  }
}

// ── small pure helpers (shared shape with the simulator) ─────────────────────
function readCondition(node: WorkflowNode) {
  const c = (node.config ?? {}) as Record<string, unknown>;
  const field = (c.field ?? (c.condition as Record<string, unknown> | undefined)?.field) as string | undefined;
  const op = (c.operator ?? c.op ?? (c.condition as Record<string, unknown> | undefined)?.op) as string | undefined;
  if (!field || !op) return null;
  const value = c.value ?? (c.condition as Record<string, unknown> | undefined)?.value;
  return { field, op, value };
}

function chooseBranch(node: WorkflowNode, ctx: unknown, outs: string[]): string {
  const branches = (node.config?.branches as Array<{ port: string; field: string; operator: string; value: unknown }> | undefined) ?? [];
  for (const b of branches) {
    if (b.field && b.operator && evaluateCondition({ field: b.field, op: b.operator, value: b.value }, ctx)) return b.port;
  }
  return outs.includes('default') ? 'default' : outs[0] ?? 'default';
}

/** Reject after `ms` (0 = no timeout). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Action timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
