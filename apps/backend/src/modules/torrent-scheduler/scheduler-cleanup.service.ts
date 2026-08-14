import { Injectable, Logger } from '@nestjs/common';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { planStagingCleanup, type StagingCleanupPlan } from './domain/staging-cleanup';

export interface CleanupOutcome {
  hash: string;
  removed: boolean;
  deletedFiles: number;
  keptFiles: number;
  error?: string;
}

/**
 * Carry out a scheduler decision to remove an aged-out torrent and delete the
 * copy it was seeding from intake staging.
 *
 * Kept out of the planner on purpose. The planner is pure and decides *what
 * should happen*; deleting bytes needs a provider, a filesystem and the intake
 * configuration, and the existing code refused destructive post-seed actions
 * precisely because a queue planner is the wrong place to acquire that
 * authority. This service is that authority, and everything it does is bounded
 * by {@link planStagingCleanup}.
 *
 * Order matters: **files first, then the torrent entry.** Removing the torrent
 * first would drop the only record of which files it owned, so a failure
 * midway would strand the staging copy with nothing left pointing at it. Doing
 * it this way, a failure leaves the torrent in place and the next sweep tries
 * again.
 */
@Injectable()
export class SchedulerCleanupService {
  private readonly logger = new Logger(SchedulerCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Intake's deletable territory and the library's protected territory.
   *
   * Every configured intake root counts, not just `stagingRoot`: a torrent that
   * failed or was quarantined has its copy under those roots and is just as much
   * intake's to clean up.
   */
  private async roots(): Promise<{ staging: string[]; libraries: string[] }> {
    const [profiles, libraries] = await Promise.all([
      this.prisma.storageProfile.findMany({
        select: { stagingRoot: true, tempRoot: true, failedRoot: true, quarantineRoot: true },
      }),
      this.prisma.mediaLibrary.findMany({ select: { path: true } }),
    ]);
    const staging = profiles
      .flatMap((p: { stagingRoot: string | null; tempRoot: string | null; failedRoot: string | null; quarantineRoot: string | null }) =>
        [p.stagingRoot, p.tempRoot, p.failedRoot, p.quarantineRoot])
      .filter((r): r is string => !!r && r.trim().length > 0)
      .map((r: string) => r.trim());
    return { staging, libraries: libraries.map((l: { path: string }) => l.path).filter(Boolean) };
  }

  /**
   * Absolute path for one of the engine's file entries.
   *
   * Both shipped providers report a path RELATIVE to the torrent's save path
   * (qBittorrent's `/torrents/files` returns `name`). Testing containment on a
   * relative path would match no root at all and quietly spare every file, so
   * the join is not cosmetic — it is what makes the safety rule apply.
   */
  private absolute(savePath: string, filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.join(savePath, filePath);
  }

  async cleanUp(engineId: string, hash: string, reasonCode: string): Promise<CleanupOutcome> {
    const out: CleanupOutcome = { hash, removed: false, deletedFiles: 0, keptFiles: 0 };
    try {
      const provider = await this.registry.resolve(engineId);
      const snapshot = await this.prisma.torrentSnapshot.findFirst({
        where: { engineId, hash: { equals: hash, mode: 'insensitive' } },
        select: { savePath: true, name: true },
      });
      const files = await provider.getFiles(hash);
      const { staging, libraries } = await this.roots();

      const plan: StagingCleanupPlan = planStagingCleanup({
        paths: files.map((f) => this.absolute(snapshot?.savePath ?? '', f.path)),
        stagingRoots: staging,
        libraryRoots: libraries,
      });

      for (const target of plan.deletable) {
        try {
          await fs.rm(target, { force: true });
          out.deletedFiles++;
        } catch (err) {
          // One unlink failing must not abandon the rest, and must not stop the
          // torrent from being removed — a file already gone is the common case.
          this.logger.warn(`Could not delete "${target}": ${(err as Error).message}`);
        }
      }
      out.keptFiles = plan.kept.length;

      await this.pruneEmptyDirs(plan.deletable, staging);

      // `removeTorrent`, never `removeTorrentAndData`: deletion already happened
      // above under the containment rule. Asking the engine to delete would hand
      // that decision back to a client that knows nothing about library roots.
      await provider.removeTorrent(hash);
      out.removed = true;

      await this.audit.record({
        action: 'torrents.remove',
        objectType: 'torrent',
        objectId: hash,
        result: 'success',
        metadata: {
          reason: `scheduler: ${reasonCode}`,
          name: snapshot?.name,
          deletedFiles: out.deletedFiles,
          keptFiles: out.keptFiles,
          keptReasons: [...new Set(plan.kept.map((k) => k.reason))],
        },
      });
      this.logger.log(
        `Aged-out torrent ${hash.slice(0, 8)} removed: `
          + `${out.deletedFiles} staging file(s) deleted, ${out.keptFiles} kept`,
      );
    } catch (err) {
      out.error = (err as Error).message;
      this.logger.warn(`Cleanup failed for ${hash.slice(0, 8)}: ${out.error}`);
      await this.audit.record({
        action: 'torrents.remove',
        objectType: 'torrent',
        objectId: hash,
        result: 'failure',
        metadata: { reason: `scheduler: ${reasonCode}`, error: out.error },
      });
    }
    return out;
  }

  /**
   * Remove directories the deletion emptied, stopping at the staging root.
   *
   * Bounded by `rmdir` refusing a non-empty directory, so nothing that still
   * holds a file can be taken; and bounded above by the staging root itself,
   * which must survive for the next import to land in.
   */
  private async pruneEmptyDirs(deleted: string[], stagingRoots: string[]): Promise<void> {
    const roots = stagingRoots.map((r) => path.resolve(r));
    const seen = new Set<string>();
    for (const file of deleted) {
      let dir = path.dirname(path.resolve(file));
      while (!seen.has(dir) && !roots.includes(dir) && dir !== path.dirname(dir)) {
        seen.add(dir);
        // Only inside a staging root — never walk up out of intake's territory.
        if (!roots.some((r) => dir === r || dir.startsWith(`${r}${path.sep}`))) break;
        try {
          await fs.rmdir(dir);
        } catch {
          break; // not empty, or gone: either way stop climbing
        }
        dir = path.dirname(dir);
      }
    }
  }
}
