import { basename } from 'node:path';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { selectStrategy, type StorageCapabilities } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { parseItemIdentity } from '../media/media-identification.service';
import { kindFromParsed, type MediaKind } from '../media/media-renamer';
import { MediaProbeService } from '../media/media-probe.service';
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
  ) {}

  onModuleInit(): void {
    this.pipeline.register(this.identifyStage());
    this.pipeline.register(this.qualityStage());
    this.pipeline.register(this.readyStage());
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
