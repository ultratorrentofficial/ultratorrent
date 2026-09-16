import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MODULE_IDS } from '@ultratorrent/shared';

import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ModuleRegistryService } from '../../module-registry/module-registry.service';
import { RemediationPlanExecutorService } from './plan-executor.service';

/**
 * What drives approved plans forward.
 *
 * Not a second job framework, and not a worker pool. The platform's job
 * engine cannot host this: a handler there must run to completion inside one
 * process lifetime, nothing ever picks up a `queued` row, and every
 * interrupted job is failed out on boot. A plan spans an approval that may
 * sit for hours, so it owns its own state and this sweep advances it — the
 * same shape the intake pipeline already uses, where `advance()` always
 * restarts from the persisted state and runs only what comes next.
 *
 * **Restart safety comes from the database, not from memory.** Nothing here
 * holds a plan in a variable between ticks. A process that dies mid-execution
 * leaves a row in `executing` with a step journalled `running`; the next tick
 * sees it, and because the step's idempotency key is derived from the
 * recommendation rather than the attempt, a re-run collides rather than
 * acting twice.
 *
 * **Bounded on purpose.** A batch cap keeps one sweep from trying to execute
 * an entire approved backlog in a single tick — the "turn on automation and
 * flood the system" failure this phase is built to avoid. There is no
 * automatic mode, so the only way a plan reaches `approved` is a human
 * decision, but a backlog of human decisions is still a backlog.
 */
@Injectable()
export class RemediationSweepService {
  private readonly logger = new Logger(RemediationSweepService.name);
  /** Guards against overlapping ticks while a source domain is slow. */
  private running = false;

  /**
   * Plans advanced per tick.
   *
   * Small deliberately. Each one issues a real source action, and a sweep
   * that drains fifty approvals into a provider at once is indistinguishable
   * from an outage to whoever is on the other end.
   */
  private static readonly BATCH = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
    private readonly executor: RemediationPlanExecutorService,
  ) {}

  /*
   * Guards on this module's own id, matching the Phase 1 reconciler: the
   * dependency on Media Manager is declared in the manifest and enforced by
   * the registry, and checking it here would be a second, divergent copy of
   * that rule that also kept running after an operator switched Intelligence
   * off.
   */
  private get enabled(): boolean {
    return this.registry.getStatus(MODULE_IDS.MEDIA_INTELLIGENCE)?.enabled ?? false;
  }

  /**
   * One minute. Fast enough that an approval feels acted on, slow enough that
   * a blocked or waiting plan costs one indexed query per tick.
   */
  @Interval('media_intelligence_remediation', 60_000)
  tick(): void {
    if (!this.enabled || this.running) return;
    this.running = true;
    void this.sweep()
      .catch((err) => this.logger.warn(`Remediation sweep failed: ${(err as Error).message}`))
      .finally(() => {
        this.running = false;
      });
  }

  /** Execute what is approved, then verify what is awaiting source truth. */
  async sweep(): Promise<{ executed: number; verified: number }> {
    let executed = 0;
    let verified = 0;

    /*
     * Approved first. Ordered oldest-first so a queue drains in the order
     * decisions were made rather than by whatever the planner happened to
     * return — fairness without inventing a priority score.
     */
    const approved = await this.prisma.mediaRemediationPlan.findMany({
      where: { status: 'approved' },
      select: { id: true, approvedById: true },
      orderBy: { createdAt: 'asc' },
      take: RemediationSweepService.BATCH,
    });
    for (const plan of approved) {
      /*
       * Attributed to the approver, not to a system identity. There is no
       * autonomous actor in this platform, and inventing one here would be
       * exactly the fake principal Phase 6 refused to introduce — the
       * approval IS the authority this action runs under.
       */
      const outcome = await this.executor
        .execute(plan.id, plan.approvedById ?? undefined)
        .catch((err) => {
          this.logger.warn(`Plan ${plan.id} execution errored: ${(err as Error).message}`);
          return null;
        });
      if (outcome && outcome.status !== 'not_claimed') executed += 1;
    }

    /*
     * Then the ones waiting on source truth. Kept in the same sweep so a
     * plan that executed on the previous tick is verified on the next,
     * rather than needing a second timer with its own failure modes.
     */
    const verifying = await this.prisma.mediaRemediationPlan.findMany({
      where: { status: 'verifying' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: RemediationSweepService.BATCH,
    });
    for (const plan of verifying) {
      const outcome = await this.executor.verify(plan.id).catch((err) => {
        this.logger.warn(`Plan ${plan.id} verification errored: ${(err as Error).message}`);
        return null;
      });
      if (outcome && outcome.status !== 'not_claimed') verified += 1;
    }

    if (executed || verified) {
      this.logger.log(`Remediation sweep: ${executed} executed, ${verified} verified.`);
    }
    return { executed, verified };
  }
}
