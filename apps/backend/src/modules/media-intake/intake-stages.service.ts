import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { selectStrategy, type StorageCapabilities } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { parseItemIdentity } from '../media/media-identification.service';
import { kindFromParsed, type MediaKind } from '../media/media-renamer';
import { MediaProbeService } from '../media/media-probe.service';
import { MediaService } from '../media/media.service';
import { ImportStrategyService } from './import-strategy.service';
import { IntakePipelineService, type IntakeStage, type StageContext } from './intake-pipeline.service';
import { StorageCapabilityDetector } from './storage-capability-detector.service';
import { MediaIntakeService } from './media-intake.service';

/**
 * The stages that run before a file is in a library.
 *
 * All three work on a **path**, which is what makes them possible at all: a
 * `MediaItem` does not exist until a library scan has found the file, so
 * anything needing an item id has to wait until after the import.
 *
 * Registered against the pipeline at boot rather than being hardcoded into it,
 * so the engine stays ignorant of what any particular stage does — and so the
 * stages that are still missing remain visibly absent.
 */
@Injectable()
export class IntakeStagesService implements OnModuleInit {
  private readonly logger = new Logger(IntakeStagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: IntakePipelineService,
    private readonly probe: MediaProbeService,
    private readonly capabilities: StorageCapabilityDetector,
    private readonly intake: MediaIntakeService,
    private readonly media: MediaService,
    private readonly strategies: ImportStrategyService,
  ) {}

  onModuleInit(): void {
    this.pipeline.register(this.identifyStage());
    this.pipeline.register(this.qualityStage());
    this.pipeline.register(this.readyStage());
    this.pipeline.register(this.importingStage());
    this.pipeline.register(this.importedStage());
  }

  /**
   * Decide what this is and where it belongs.
   *
   * A **filename parse**, not the creation of an item — `parseItemIdentity` and
   * `kindFromParsed` are the same functions the rename engine uses to build a
   * destination, so intake and a library scan agree about what a release is
   * rather than each having an opinion.
   *
   * Quarantines when the profile has no library for the kind it found. That is
   * a configuration gap a human has to close, not something a retry fixes, and
   * importing into "whichever library exists" would put a film in a TV tree.
   */
  private identifyStage(): IntakeStage {
    return {
      produces: 'identified',
      label: 'Identify release',
      run: async (ctx: StageContext) => {
        const parsed = parseItemIdentity(ctx.sourcePath);
        const kind = kindFromParsed(parsed);
        const profile = await this.prisma.storageProfile.findUnique({
          where: { id: ctx.profileId },
          include: { movieLibrary: true, tvLibrary: true, musicLibrary: true },
        });
        if (!profile) return { quarantine: { reason: 'Storage profile no longer exists' } };

        const library = this.libraryFor(kind, profile);
        if (!library) {
          return {
            quarantine: {
              reason: `Parsed as "${kind}" but the profile has no library for it. `
                + `Set one on the storage profile, then release this item.`,
            },
          };
        }

        await this.prisma.mediaIntakeJob.update({
          where: { id: ctx.jobId },
          data: { libraryId: library.id },
        });
        return {
          message: `${kind}: ${parsed.title ?? basename(ctx.sourcePath)} → ${library.name}`,
          data: {
            kind,
            title: parsed.title ?? null,
            season: parsed.season ?? null,
            episode: parsed.episode ?? null,
            libraryId: library.id,
          },
        };
      },
    };
  }

  /**
   * Score the file from the file, not from its name.
   *
   * `ffprobe` reads the real resolution, codec and bitrate; a release name
   * claiming 1080p is a claim. The score feeds the import decision, which is
   * why this runs BEFORE the import — an upgrade over an existing copy is
   * decided on measured quality.
   *
   * A missing or failing probe does not stop the intake. ffprobe is optional in
   * this deployment, and refusing to import because a nice-to-have measurement
   * was unavailable would be a worse outcome than importing unscored.
   */
  private qualityStage(): IntakeStage {
    return {
      produces: 'quality_scored',
      label: 'Score quality',
      run: async (ctx: StageContext) => {
        if (!(await this.probe.isAvailable())) {
          return { message: 'ffprobe unavailable; imported without a quality score' };
        }
        try {
          const tech = await this.probe.probe(ctx.sourcePath);
          const score = this.scoreOf(tech);
          await this.prisma.mediaIntakeJob.update({
            where: { id: ctx.jobId },
            data: { qualityScore: score },
          });
          return {
            message: `${tech.resolution ?? 'unknown'} ${tech.videoCodec ?? ''}`.trim(),
            data: { ...tech, score } as Record<string, unknown>,
          };
        } catch (err) {
          // Deliberately not a failure — see above.
          this.logger.debug(`Probe failed for ${ctx.sourcePath}: ${(err as Error).message}`);
          return { message: `Could not probe the file: ${(err as Error).message}` };
        }
      },
    };
  }

  /**
   * Work out how the import will be done, and record it before doing it.
   *
   * Capabilities are measured against the real source and destination roots, so
   * the strategy reflects this pair of locations rather than a general belief
   * about the install. The choice and its reason are persisted here — before
   * execution — so an intake that dies mid-import still says what it was
   * attempting.
   */
  private readyStage(): IntakeStage {
    return {
      produces: 'ready_to_import',
      label: 'Plan the import',
      run: async (ctx: StageContext) => {
        const job = await this.prisma.mediaIntakeJob.findUnique({ where: { id: ctx.jobId } });
        const profile = await this.prisma.storageProfile.findUnique({
          where: { id: ctx.profileId },
        });
        if (!job?.libraryId || !profile) {
          return { quarantine: { reason: 'No destination library was resolved' } };
        }
        const library = await this.prisma.mediaLibrary.findUnique({ where: { id: job.libraryId } });
        if (!library) return { quarantine: { reason: 'Destination library no longer exists' } };

        const caps = await this.capabilities.probe(
          profile.id, profile.stagingRoot, library.path, ctx.engineId,
        );
        const { strategy, reason } = selectStrategy(caps as StorageCapabilities, {
          override: profile.defaultStrategy as never,
          // Seeding must survive unless an operator explicitly chose otherwise.
          requireSeeding: profile.defaultStrategy !== 'move',
        });
        await this.intake.recordStrategy(ctx.jobId, strategy, reason);
        return {
          message: `${strategy} — ${reason}`,
          data: { strategy, reason, destinationRoot: library.path, capabilities: { ...caps } },
        };
      },
    };
  }

  /**
   * Mark the import as begun.
   *
   * A separate state rather than part of the placement, so a process that dies
   * mid-copy leaves `importing` behind — which reads as "this was interrupted,
   * check it" rather than `ready_to_import`, which would read as "never
   * started" and invite a second attempt on a half-copied file.
   */
  private importingStage(): IntakeStage {
    return {
      produces: 'importing',
      label: 'Begin import',
      run: async () => ({ message: 'Placement started' }),
    };
  }

  /**
   * Put the file in the library.
   *
   * The DESTINATION comes from the rename engine, not from this module. The
   * library already owns a naming preset and template, and a second opinion
   * about what a file should be called is how intake and a scan end up
   * disagreeing about the same release. `buildPlan` in `preview` mode computes
   * paths without touching anything; the placement itself is then done by the
   * strategy chosen in the previous stage.
   *
   * Idempotent by destination: a retry after a partial run skips files that are
   * already where they belong, so resuming cannot double-place or fail on an
   * existing target.
   */
  private importedStage(): IntakeStage {
    return {
      produces: 'imported',
      label: 'Place into library',
      run: async (ctx: StageContext) => {
        const job = await this.prisma.mediaIntakeJob.findUnique({ where: { id: ctx.jobId } });
        const library = job?.libraryId
          ? await this.prisma.mediaLibrary.findUnique({ where: { id: job.libraryId } })
          : null;
        if (!job || !library) return { quarantine: { reason: 'Destination library is gone' } };

        // `preview` so the plan is computed and nothing is moved by the renamer
        // itself — the strategy executor owns every byte that moves.
        const plan = await this.media.buildPlan({
          path: ctx.sourcePath,
          preset: library.preset as never,
          mode: 'preview' as never,
          libraryPath: library.path,
          template: library.template ?? undefined,
        } as never);

        const targets = plan.items.filter((i) => !i.skipped && !i.unchanged && i.destination);
        if (!targets.length) {
          return { quarantine: { reason: 'The rename engine produced nothing to place' } };
        }

        const caps = await this.capabilities.probe(
          job.profileId, ctx.sourcePath, library.path, ctx.engineId,
        );
        const placed: string[] = [];
        const skipped: string[] = [];
        let fellBack = false;
        for (const item of targets) {
          /*
           * Already there? Skip it.
           *
           * This is what makes a retry safe. `buildPlan` computes the
           * destination from the SOURCE, which is still in staging after a
           * partial run, so its `unchanged` flag stays false and cannot be
           * relied on here — without this check a resumed import would place
           * the same file twice and `link()` would throw EEXIST on the second.
           */
          const already = await stat(item.destination!).then(() => true).catch(() => false);
          if (already) {
            skipped.push(item.destination!);
            placed.push(item.destination!);
            continue;
          }
          const outcome = await this.strategies.execute({
            source: item.source,
            destination: item.destination!,
            capabilities: caps,
            requested: (job.strategy as never) ?? undefined,
            torrentHash: job.torrentHash,
            engineId: job.engineId,
          });
          placed.push(outcome.destination);
          fellBack = fellBack || outcome.fellBack;
          if (!outcome.sourcePreserved) {
            this.logger.warn(
              `Intake ${ctx.jobId} used ${outcome.strategy}; the source is gone and seeding has ended.`,
            );
          }
        }

        await this.prisma.mediaIntakeJob.update({
          where: { id: ctx.jobId },
          data: { importedPath: placed[0] ?? null },
        });
        return {
          message: `Placed ${placed.length - skipped.length} file(s)`
            + (skipped.length ? `, ${skipped.length} already present` : '')
            + (fellBack ? ' (a strategy fell back)' : ''),
          data: { placed, skipped, fellBack },
        };
      },
    };
  }

  /** Which library a parsed kind belongs in, or null when the profile has none. */
  private libraryFor(
    kind: MediaKind,
    profile: {
      movieLibrary: { id: string; name: string } | null;
      tvLibrary: { id: string; name: string } | null;
      musicLibrary: { id: string; name: string } | null;
    },
  ): { id: string; name: string } | null {
    switch (kind) {
      case 'movie':
        return profile.movieLibrary;
      case 'tv':
      case 'anime':
        return profile.tvLibrary;
      case 'music':
      case 'audiobook':
        return profile.musicLibrary;
      default:
        // `general` is genuinely unknown. Guessing a library for it is how a
        // sample or a scene extra ends up filed as a film.
        return null;
    }
  }

  /**
   * A single comparable number, from measured facts.
   *
   * Height dominates because it is the difference people actually notice;
   * bitrate breaks ties within a resolution, which is where the real difference
   * between two 1080p releases lives. Deliberately crude — its only job is to
   * order two candidates for the same title consistently.
   */
  private scoreOf(tech: { height?: number; bitrateKbps?: number }): number {
    const height = tech.height ?? 0;
    const bitrate = Math.min(tech.bitrateKbps ?? 0, 100_000);
    return height * 100 + bitrate / 1000;
  }
}
