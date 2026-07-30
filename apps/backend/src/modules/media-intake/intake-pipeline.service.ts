import { stat } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { nextState, type IntakeState } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MediaIntakeService } from './media-intake.service';

/**
 * One step of the pipeline.
 *
 * A stage is named by the state it ENTERS, not the one it starts from, so the
 * registry reads in the same order as the lifecycle and a resumed run can be
 * addressed by "where it got to".
 */
export interface IntakeStage {
  /** The state this stage produces on success. */
  produces: IntakeState;
  /** Human-readable, used in the timeline. */
  label: string;
  run(ctx: StageContext): Promise<StageResult>;
}

export interface StageContext {
  jobId: string;
  sourcePath: string;
  profileId: string;
  torrentHash: string | null;
  engineId: string | null;
}

export interface StageResult {
  message?: string;
  data?: Record<string, unknown>;
  /** Set to divert into quarantine instead of advancing — see below. */
  quarantine?: { reason: string };
}

/**
 * Drives an intake through its stages.
 *
 * The engine is deliberately dumb about what a stage does. It knows the order,
 * it knows how to record a transition, and it knows that a stage which throws
 * sends the intake to `failed` with the state it was attempting recorded — so a
 * retry resumes there rather than starting over.
 *
 * **Resumability is the point.** The run always starts from the job's CURRENT
 * state and executes only the stages after it, which is what makes a retry
 * cheap and a restart harmless. A pipeline that re-ran from the beginning would
 * re-fetch metadata and artwork that already succeeded, and hammer every
 * provider involved for no reason.
 *
 * A stage may ask for quarantine instead of advancing. That is not the same as
 * failing: a failure is "this did not work, try again", quarantine is "a human
 * must look at this before anything else happens", and conflating them means
 * either retrying something that will never succeed or parking something that
 * merely needed a second attempt.
 */
@Injectable()
export class IntakePipelineService {
  private readonly logger = new Logger(IntakePipelineService.name);

  /**
   * The stage table.
   *
   * Registered rather than hardcoded so a stage can be added without touching
   * the engine — and so the ones that are not built yet are visibly ABSENT
   * rather than stubbed. A stub that returns success would advance an intake
   * past a check that never ran, which is worse than not having the check.
   */
  private readonly stages: IntakeStage[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly intake: MediaIntakeService,
  ) {
    this.register(this.verifyStage());
  }

  register(stage: IntakeStage): void {
    this.stages.push(stage);
    // Keep the table in lifecycle order however it was registered, so a stage
    // contributed by another module cannot land in the wrong place.
    this.stages.sort((a, b) => this.orderOf(a.produces) - this.orderOf(b.produces));
  }

  /** The states this engine can currently produce — the honest capability list. */
  registered(): IntakeState[] {
    return this.stages.map((s) => s.produces);
  }

  /**
   * Run every stage after the job's current state, stopping at the first one
   * that is not registered.
   *
   * Stopping is deliberate. The alternative — skipping a missing stage and
   * carrying on — would silently import something that was never identified.
   */
  async advance(jobId: string): Promise<{ state: IntakeState; ran: string[]; stopped?: string }> {
    const job = await this.prisma.mediaIntakeJob.findUnique({ where: { id: jobId } });
    if (!job) throw new Error('Intake job not found');

    const ctx: StageContext = {
      jobId,
      sourcePath: job.sourcePath,
      profileId: job.profileId,
      torrentHash: job.torrentHash,
      engineId: job.engineId,
    };

    let state = job.state as IntakeState;
    const ran: string[] = [];

    for (;;) {
      const want = nextState(state);
      if (!want) return { state, ran };
      const stage = this.stages.find((s) => s.produces === want);
      if (!stage) {
        // Not an error: the pipeline is incomplete by construction while it is
        // being built, and saying where it stopped is more useful than failing.
        return { state, ran, stopped: want };
      }

      try {
        const result = await stage.run(ctx);
        if (result.quarantine) {
          await this.intake.transition(jobId, 'quarantined', {
            message: result.quarantine.reason,
          });
          return { state: 'quarantined', ran };
        }
        await this.intake.transition(jobId, want, {
          message: result.message ?? stage.label,
          data: result.data,
        });
        state = want;
        ran.push(stage.label);
      } catch (err) {
        // The state being ATTEMPTED is what a retry must resume at, and
        // `transition` records the state we were in — so move to failed from
        // here, where `resumeState` becomes the last good one.
        await this.intake.transition(jobId, 'failed', {
          message: `${stage.label}: ${(err as Error).message}`,
        });
        this.logger.warn(`Intake ${jobId} failed at ${stage.label}: ${(err as Error).message}`);
        return { state: 'failed', ran };
      }
    }
  }

  /**
   * Verification: is there actually something here?
   *
   * The cheapest check that catches the most common real failure — a torrent
   * reported complete whose data is missing, moved by something else, or zero
   * bytes. It quarantines rather than fails, because none of those get better
   * by trying again; they need somebody to look.
   */
  private verifyStage(): IntakeStage {
    return {
      produces: 'verified',
      label: 'Verify payload',
      run: async (ctx) => {
        let info;
        try {
          info = await stat(ctx.sourcePath);
        } catch (err) {
          return { quarantine: { reason: `Source is unreadable: ${(err as Error).message}` } };
        }
        if (info.isFile() && info.size === 0) {
          return { quarantine: { reason: 'Source file is zero bytes' } };
        }
        return {
          message: info.isDirectory() ? 'Directory present' : `File present (${info.size} bytes)`,
          data: { sizeBytes: String(info.size), isDirectory: info.isDirectory() },
        };
      },
    };
  }

  private orderOf(state: IntakeState): number {
    const order: IntakeState[] = [
      'queued', 'downloading', 'completed', 'verified', 'identified',
      'quality_scored', 'ready_to_import', 'importing', 'imported',
      'metadata_ready', 'artwork_ready', 'subtitle_ready', 'seeding', 'archived',
    ];
    const i = order.indexOf(state);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  }
}
