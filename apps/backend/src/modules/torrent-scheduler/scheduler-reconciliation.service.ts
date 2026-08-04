import { Injectable, Logger } from '@nestjs/common';
import { TorrentState } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { TorrentEngineProvider } from '../../domain/engine/torrent-engine-provider.interface';
import type { EngineActivityPlan, TorrentDecision } from './domain/planner';
import type { SchedulerLimitation } from './domain/capabilities';

/**
 * Turn a plan into provider calls — the first code in the scheduler that can
 * change a torrent.
 *
 * Nothing reaches it yet: the sweep invokes it only for `managed` mode, and
 * `SchedulerModeService` refuses to set that mode. This is deliberate sequencing
 * rather than dead code — the machinery is built and tested before anything can
 * run it, so switching enforcement on later is a one-line change to a guard
 * rather than a new body of untested behaviour.
 *
 * Three properties matter more than throughput:
 *
 *  1. **Pause before resume.** Resuming first would momentarily exceed the very
 *     limit being enforced, and on an engine with its own queue the new torrent
 *     would simply be refused a slot.
 *  2. **Verify, never trust.** A provider call returning without throwing does
 *     not mean the engine did it. A resume in particular can succeed and leave
 *     the torrent `queued` — the engine's own limits winning — which is a
 *     conflict the operator needs told about, not a success to report.
 *  3. **Isolate failures.** One torrent's failure must not abandon the rest of
 *     the plan, and one engine's must not abandon the other engines.
 */

export interface ReconciliationOutcome {
  engineId: string;
  attempted: number;
  applied: number;
  failed: number;
  /** Actions the engine accepted but did not actually perform. */
  unverified: number;
  limitations: SchedulerLimitation[];
  failures: Array<{ hash: string; action: string; error: string }>;
}

/** Verification re-reads state; this bounds how long we wait for it to settle. */
const VERIFY_DELAY_MS = 250;

/** Operators think in kbps; engines take bytes per second. `null` stays null. */
function kbpsToBytes(kbps: number | null | undefined): number | null {
  if (kbps == null) return null;
  return Math.max(0, Math.round((kbps * 1000) / 8));
}

@Injectable()
export class SchedulerReconciliationService {
  private readonly logger = new Logger(SchedulerReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record that the SCHEDULER is the reason a torrent is paused — or that it no
   * longer is.
   *
   * Written only after verification, never on the optimistic path. A row
   * claiming we paused something we failed to pause would let a later sweep
   * resume a torrent a person had stopped.
   */
  private async remember(
    engineId: string,
    hash: string,
    paused: boolean,
    reasonCode: string,
  ): Promise<void> {
    const now = new Date();
    const data = {
      schedulerPausedAt: paused ? now : null,
      reasonCode: paused ? reasonCode : null,
      lastActionAt: now,
    };
    await this.prisma.torrentSchedulerState
      .upsert({ where: { engineId_hash: { engineId, hash } }, create: { engineId, hash, ...data }, update: data })
      // Losing the note is bad but not a reason to fail the action that already
      // happened; the next sweep re-derives from provider state.
      .catch((err) => this.logger.warn(`Could not record scheduler state for ${hash.slice(0, 8)}: ${(err as Error).message}`));
  }

  /**
   * Apply one engine's plan.
   *
   * Sequential on purpose. These are queue-management actions on a shared
   * resource, and firing twenty pauses concurrently at an engine that is already
   * the bottleneck trades a correctness property — that slots are freed before
   * they are filled — for latency nobody asked for.
   */
  async apply(
    plan: EngineActivityPlan,
    provider: TorrentEngineProvider,
    opts: { verify?: boolean; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<ReconciliationOutcome> {
    const verify = opts.verify ?? true;
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    const out: ReconciliationOutcome = {
      engineId: plan.engineId,
      attempted: 0,
      applied: 0,
      failed: 0,
      unverified: 0,
      limitations: [],
      failures: [],
    };

    await this.applyBandwidth(plan, provider, out);

    const pauses = plan.decisions.filter((d) => d.action === 'pause');
    const resumes = plan.decisions.filter((d) => d.action === 'resume');

    // Order is the contract: relinquish slots, then claim them.
    for (const d of pauses) await this.one(d, provider, out, verify, sleep);
    for (const d of resumes) await this.one(d, provider, out, verify, sleep);

    return out;
  }

  /**
   * Push the policy's global rate ceiling to the engine.
   *
   * Applied before any pause or resume, because a torrent resumed into an
   * uncapped engine transfers at full speed for however long the rest of the
   * plan takes.
   *
   * Reserves are NOT enforced, and the limitation says so. A percentage split
   * between download and seed traffic cannot be expressed with a single global
   * upload ceiling — the engines offer one number, not two — so honouring the
   * cap and reporting the split as unavailable is the truthful outcome. Faking
   * it by lowering the global ceiling would throttle downloads to protect
   * seeding, which is the opposite of what the operator asked for.
   */
  private async applyBandwidth(
    plan: EngineActivityPlan,
    provider: TorrentEngineProvider,
    out: ReconciliationOutcome,
  ): Promise<void> {
    const policy = plan.decisions[0]?.bandwidth;
    if (!policy) return;

    if (!provider.setGlobalRateLimits) {
      out.limitations.push({
        engineId: out.engineId,
        code: 'no_global_rate_limit',
        messageKey: 'scheduler.limitation.no_global_rate_limit',
      });
      return;
    }

    if (policy.reserveDownloadPercent != null || policy.reserveSeedPercent != null) {
      out.limitations.push({
        engineId: out.engineId,
        code: 'bandwidth_reserve_unsupported',
        messageKey: 'scheduler.limitation.bandwidth_reserve_unsupported',
      });
    }

    try {
      await provider.setGlobalRateLimits({
        downloadBytesPerSec: kbpsToBytes(policy.maxDownloadRateKbps),
        uploadBytesPerSec: kbpsToBytes(policy.maxUploadRateKbps),
      });
    } catch (err) {
      out.failed += 1;
      out.failures.push({ hash: '-', action: 'set_rate_limits', error: (err as Error).message });
      this.logger.warn(`Could not apply rate limits on ${out.engineId}: ${(err as Error).message}`);
    }
  }

  private async one(
    decision: TorrentDecision,
    provider: TorrentEngineProvider,
    out: ReconciliationOutcome,
    verify: boolean,
    sleep: (ms: number) => Promise<void>,
  ): Promise<void> {
    out.attempted += 1;
    const { hash, action } = decision;

    try {
      if (action === 'pause') await provider.pauseTorrent(hash);
      else if (action === 'resume') await provider.resumeTorrent(hash);
      else return;

      if (!verify) {
        out.applied += 1;
        return;
      }

      // Give the engine a moment; several report the previous state if asked
      // immediately after a command.
      await sleep(VERIFY_DELAY_MS);

      const after = await provider.getTorrent(hash).catch(() => null);
      if (!after) {
        /*
         * The torrent is gone. Removed by a person or by automation while the
         * plan was being applied — a race, not a fault. The desired end state
         * for a pause is "not occupying a slot", and a torrent that no longer
         * exists satisfies that; counting it as a failure would produce alarms
         * for the ordinary case of someone deleting a torrent.
         */
        out.applied += 1;
        await this.remember(out.engineId, hash, false, decision.reasonCode);
        return;
      }

      if (action === 'pause') {
        const paused = after.state === TorrentState.PAUSED || after.state === TorrentState.STOPPED;
        if (paused) {
          out.applied += 1;
          await this.remember(out.engineId, hash, true, decision.reasonCode);
        } else {
          this.unverified(out, decision, `engine still reports ${after.state}`);
        }
        return;
      }

      // Resume. `queued` is the interesting outcome: the call succeeded and the
      // torrent still is not running, because the ENGINE's own queue limits
      // refused it. Reporting that as applied would tell the operator we control
      // a queue that is in fact controlling us.
      if (after.state === TorrentState.QUEUED) {
        out.unverified += 1;
        if (!out.limitations.some((l) => l.code === 'native_queue_conflict')) {
          out.limitations.push({
            engineId: out.engineId,
            code: 'native_queue_conflict',
            messageKey: 'scheduler.limitation.native_queue_conflict',
          });
        }
        this.logger.warn(
          `Resumed ${hash.slice(0, 8)} but the engine queued it — its own queue limits are still in force.`,
        );
        return;
      }

      const running = after.state === TorrentState.DOWNLOADING
        || after.state === TorrentState.SEEDING
        || after.state === TorrentState.CHECKING
        || after.state === TorrentState.ALLOCATING;
      if (running) {
        out.applied += 1;
        await this.remember(out.engineId, hash, false, decision.reasonCode);
      } else {
        this.unverified(out, decision, `engine reports ${after.state}`);
      }
    } catch (err) {
      // One torrent, one failure. The rest of the plan still runs.
      const message = (err as Error).message;
      out.failed += 1;
      out.failures.push({ hash, action, error: message });
      this.logger.warn(`Scheduler ${action} failed for ${hash.slice(0, 8)}: ${message}`);
    }
  }

  private unverified(out: ReconciliationOutcome, d: TorrentDecision, detail: string): void {
    out.unverified += 1;
    this.logger.warn(
      `Scheduler ${d.action} on ${d.hash.slice(0, 8)} was accepted but not confirmed: ${detail}`,
    );
  }
}
