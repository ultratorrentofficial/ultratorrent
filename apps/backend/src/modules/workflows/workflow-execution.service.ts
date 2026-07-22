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

/** Node categories that suspend the run for a time/event/approval/subworkflow. */
const PAUSING = new Set(['delay', 'wait', 'approval', 'subworkflow']);

/** Statuses from which a paused execution can be resumed. */
const WAITING_STATUSES = new Set(['waiting', 'waiting_for_event', 'waiting_for_approval', 'paused']);

/** Guard against runaway subworkflow nesting (self-recursion is also blocked at validate time). */
const MAX_SUBWORKFLOW_DEPTH = 5;

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
      include: { nodes: { orderBy: { createdAt: 'asc' } }, approvals: { orderBy: { requestedAt: 'desc' } } },
    });
    if (!execution) throw new NotFoundException('Execution not found');
    return execution;
  }

  // ── Approval center ─────────────────────────────────────────────────────────
  async listPendingApprovals(take = 50) {
    const approvals = await this.prisma.workflowApproval.findMany({
      where: { status: 'pending' },
      orderBy: { requestedAt: 'asc' },
      take: Math.min(take, 100),
      include: { execution: { select: { workflowId: true, workflowVersionId: true } } },
    });
    return approvals;
  }

  async respondToApproval(approvalId: string, decision: 'approved' | 'rejected', user: AuthenticatedUser, comment?: string) {
    const approval = await this.prisma.workflowApproval.findUnique({ where: { id: approvalId } });
    if (!approval) throw new NotFoundException('Approval not found');
    if (approval.status !== 'pending') throw new BadRequestException(`Approval already ${approval.status}`);
    // Defense in depth: if the gate declared a specific permission, the responder must hold it.
    if (approval.requiredPermission && !(user.permissions ?? []).includes(approval.requiredPermission)) {
      throw new BadRequestException('You lack the permission required to decide this approval');
    }
    await this.prisma.workflowApproval.update({
      where: { id: approvalId },
      data: { status: decision, respondedById: user.id, respondedAt: new Date(), comment: comment ?? null },
    });
    await this.audit.record({
      userId: user.id, action: `workflows.approval.${decision}`,
      objectType: 'workflow_approval', objectId: approvalId,
      metadata: { executionId: approval.workflowExecutionId },
    });
    await this.resume(approval.workflowExecutionId, decision === 'approved' ? 'approved' : 'rejected');
    return { status: decision };
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
    // Accumulated variables survive across durable pauses (persisted in outputSummary.vars).
    const savedVars = ((execution.outputSummary as { vars?: Record<string, unknown> } | null)?.vars) ?? {};
    const context: Record<string, unknown> = {
      trigger: (execution.inputContext ?? {}) as Record<string, unknown>,
      vars: savedVars,
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
          // Single-active-wait model (matches the schema's execution-level resumeAt/expiresAt):
          // arm this wait and stop; siblings resume after it resolves.
          await this.saveVars(executionId, context.vars as Record<string, unknown>);
          await this.armWait(executionId, node, category, context);
          return;
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

    await this.saveVars(executionId, context.vars as Record<string, unknown>);
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

  /**
   * Arm a durable wait at `node` and stop the run. Delay → time-based resume; wait → event or
   * timeout resume; approval → an approval-center gate; subworkflow → a child execution whose
   * completion resumes the parent. Exactly one node waits at a time (schema model).
   */
  private async armWait(
    executionId: string, node: WorkflowNode, category: string, context: Record<string, unknown>,
  ): Promise<void> {
    const now = Date.now();
    const timeoutS = Number(node.timeoutSeconds ?? 0);
    const expiresAt = timeoutS > 0 ? new Date(now + timeoutS * 1000) : null;
    await this.persistNode(executionId, node, 'waiting', []);

    if (category === 'delay') {
      const resumeAt = new Date(now + Number(node.config?.duration ?? 0) * 1000);
      await this.setWaiting(executionId, 'waiting', { resumeAt, expiresAt: null });
      return;
    }
    if (category === 'wait') {
      await this.setWaiting(executionId, 'waiting_for_event', { resumeAt: null, expiresAt });
      return;
    }
    if (category === 'approval') {
      const def = this.registry.get(node.type);
      await this.prisma.workflowApproval.create({
        data: {
          workflowExecutionId: executionId,
          status: 'pending',
          requiredPermission: (node.config?.requiredPermission as string | undefined) ?? null,
          riskLevel: def?.destructive ? 'destructive' : 'normal',
          expiresAt,
        },
      });
      await this.setWaiting(executionId, 'waiting_for_approval', { resumeAt: null, expiresAt });
      return;
    }
    // subworkflow: start a version-pinned child; its completion resumes this parent.
    const childWorkflowId = String(node.config?.workflowId ?? '');
    const parent = await this.prisma.workflowExecution.findUnique({ where: { id: executionId }, select: { depth: true } });
    const depth = (parent?.depth ?? 0) + 1;
    if (!childWorkflowId || depth > MAX_SUBWORKFLOW_DEPTH) {
      // Can't invoke — resume immediately down the failure path (or fail if unwired).
      await this.setWaiting(executionId, 'waiting', { resumeAt: null, expiresAt: null });
      await this.resumeNode(executionId, node.id, 'failure');
      return;
    }
    await this.setWaiting(executionId, 'waiting', { resumeAt: null, expiresAt });
    await this.start(childWorkflowId, {
      triggerSource: 'subworkflow',
      context: { ...(context.trigger as object), __parentExecutionId: executionId, __parentNodeId: node.id },
    }).catch(() => this.resumeNode(executionId, node.id, 'failure'));
  }

  private async setWaiting(executionId: string, status: string, times: { resumeAt: Date | null; expiresAt: Date | null }): Promise<void> {
    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: { status, resumeAt: times.resumeAt, expiresAt: times.expiresAt, heartbeatAt: new Date() },
    });
  }

  /**
   * Resume a paused execution: advance its single waiting node down `port` and continue the
   * durable run. Idempotent — a no-op if the execution isn't waiting or has no waiting node.
   */
  async resume(executionId: string, port: string): Promise<void> {
    const execution = await this.prisma.workflowExecution.findUnique({ where: { id: executionId }, select: { status: true } });
    if (!execution || !WAITING_STATUSES.has(execution.status)) return;
    const waitingNode = await this.prisma.workflowNodeExecution.findFirst({
      where: { workflowExecutionId: executionId, status: 'waiting' }, select: { id: true, nodeId: true },
    });
    if (!waitingNode) return;
    await this.resumeNode(executionId, waitingNode.nodeId, port);
  }

  private async resumeNode(executionId: string, nodeId: string, port: string): Promise<void> {
    await this.prisma.workflowNodeExecution.updateMany({
      where: { workflowExecutionId: executionId, nodeId },
      data: { status: 'succeeded', outputSummary: { firedPorts: [port] } as object, completedAt: new Date() },
    });
    await this.prisma.workflowExecution.update({
      where: { id: executionId }, data: { status: 'running', resumeAt: null, expiresAt: null },
    });
    await this.runExecution(executionId);
  }

  private async saveVars(executionId: string, vars: Record<string, unknown>): Promise<void> {
    if (!vars || Object.keys(vars).length === 0) return;
    const row = await this.prisma.workflowExecution.findUnique({ where: { id: executionId }, select: { outputSummary: true } });
    const merged = { ...((row?.outputSummary as object) ?? {}), vars };
    await this.prisma.workflowExecution.update({ where: { id: executionId }, data: { outputSummary: merged as object } });
  }

  private async finalize(executionId: string, status: string, reason?: string): Promise<void> {
    const now = new Date();
    const row = await this.prisma.workflowExecution.findUnique({
      where: { id: executionId }, select: { outputSummary: true, inputContext: true },
    });
    const prevSummary = (row?.outputSummary as object) ?? {};
    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: {
        status,
        completedAt: status === 'completed' || status === 'completed_with_warnings' ? now : null,
        failedAt: status === 'failed' ? now : null,
        cancelledAt: status === 'cancelled' ? now : null,
        outputSummary: (reason ? { ...prevSummary, reason } : prevSummary) as object,
      },
    });
    await this.audit.record({
      action: `workflows.execution.${status}`, objectType: 'workflow_execution', objectId: executionId,
      result: status === 'failed' ? 'failure' : 'success',
    });

    // If this was a subworkflow child, resume the parent node down success/failure.
    const input = (row?.inputContext as { __parentExecutionId?: string; __parentNodeId?: string } | null) ?? {};
    if (input.__parentExecutionId && input.__parentNodeId) {
      const ok = status === 'completed' || status === 'completed_with_warnings';
      await this.resumeNode(input.__parentExecutionId, input.__parentNodeId, ok ? 'out' : 'failure')
        .catch((err) => this.logger.error(`Parent resume failed: ${(err as Error).message}`));
    }
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
