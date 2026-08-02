import { constants } from 'node:fs';
import { copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from './media-metadata.service';
import { MediaProcessingQueueService } from './media-processing-queue.service';
import { assertDestinationFree } from '../../common/file-placement';

/**
 * How many ids one request may name.
 *
 * The Library Browser can only ever select what it has loaded, so a legitimate
 * selection is bounded by paging. A cap keeps a hand-rolled request from
 * naming a whole 500 000-item library as a single transaction — a library-wide
 * operation is a *scope* (`libraryId`), not a list, and the existing endpoints
 * already take that form.
 */
export const MAX_BULK_IDS = 1000;

/**
 * Move one file, tolerating a cross-device destination.
 *
 * `rename` is atomic and instant, and fails with `EXDEV` the moment the two
 * paths are on different filesystems — which, for a library root that is a NAS
 * share and a source on local disk, is the ordinary case rather than the
 * exception. The fallback copies then unlinks, so an interrupted move leaves
 * the original intact rather than a half-written file and no source.
 *
 * An occupied destination is refused outright rather than replaced. Both
 * branches would otherwise destroy it — `rename` replaces by definition, and
 * the EXDEV path is worse still, copying over the occupant and THEN unlinking
 * the source, so one file is lost and the other has moved. Raising here leaves
 * both where they are and lets the caller report the failure.
 */
async function moveFile(from: string, to: string): Promise<void> {
  if (from === to) return;
  await mkdir(dirname(to), { recursive: true });
  await assertDestinationFree(to);
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err;
    await copyFile(from, to, constants.COPYFILE_EXCL);
    await unlink(from);
  }
}

export type BulkOperation =
  | 'refresh_metadata'
  | 'lock'
  | 'unlock'
  | 'generate_nfo'
  | 'remove'
  | 'delete_files'
  | 'move';

export interface BulkResult {
  jobId: string;
  /** How many ids were accepted after de-duplication and existence checks. */
  accepted: number;
  /** Ids that named nothing in this install — reported, never silently dropped. */
  missing: string[];
}

/**
 * Bulk operations over an explicit set of media items.
 *
 * The Media Manager's existing bulk paths are **library-scoped**
 * (`items/reidentify` takes `{ libraryId, matchStatus }`, `nfo/generate` takes
 * one item or a whole library). A browser with multi-selection needs the third
 * shape — *these particular items* — and doing it from the client as N requests
 * would produce N round trips, no single job to watch, and N audit rows for
 * what the operator performed as one action.
 *
 * So each method here does three things the fan-out cannot: resolves the ids
 * once, dispatches **one** detached job, and writes **one** audit record naming
 * the whole set.
 */
@Injectable()
export class MediaBulkService {
  private readonly logger = new Logger(MediaBulkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: MediaProcessingQueueService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Narrow a caller-supplied id list to items that exist.
   *
   * Ids come from a client and are the entire input to a potentially
   * destructive operation, so they are validated against the database rather
   * than trusted. Duplicates collapse — a double-click must not process an item
   * twice — and anything unresolved is *returned* rather than ignored, because
   * silently acting on fewer items than requested is how an operator believes
   * work happened that did not.
   */
  private async resolve(itemIds: string[]): Promise<{ ids: string[]; missing: string[] }> {
    const unique = [...new Set((itemIds ?? []).filter((id) => typeof id === 'string' && id))];
    if (!unique.length) throw new BadRequestException('No items selected.');
    if (unique.length > MAX_BULK_IDS) {
      throw new BadRequestException(
        `Select at most ${MAX_BULK_IDS} items, or run the operation on the whole library.`,
      );
    }

    const found = await this.prisma.mediaItem.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    const present = new Set(found.map((r) => r.id));
    return {
      ids: unique.filter((id) => present.has(id)),
      missing: unique.filter((id) => !present.has(id)),
    };
  }

  /**
   * Items that automation may touch.
   *
   * A locked item is out of every automated path. Bulk skips it **silently** —
   * a lock is a state, not a failure — matching how the rest of the Media
   * Manager treats it; an explicit single-item request is the one that gets a
   * 409.
   */
  private async unlockedOf(ids: string[]): Promise<string[]> {
    const rows = await this.prisma.mediaItem.findMany({
      where: { id: { in: ids }, locked: false },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Re-fetch metadata for a selection.
   *
   * Detached: the browser gets a job id immediately and follows it in the Jobs
   * Center, rather than holding a request open across hundreds of provider
   * lookups.
   */
  async refreshMetadata(
    itemIds: string[],
    ctx: AuditContext,
    fetchOne: (itemId: string) => Promise<unknown>,
  ): Promise<BulkResult> {
    const { ids, missing } = await this.resolve(itemIds);
    const targets = await this.unlockedOf(ids);

    const { jobId } = await this.jobs.runDetached(
      'metadata_fetch',
      { libraryId: null, payload: { itemIds: targets } },
      async (report, signal) => {
        let done = 0;
        let failed = 0;
        for (const id of targets) {
          // Cooperative cancellation: this writes rows, so it stops between
          // items rather than mid-write.
          if (signal.isCancelled()) break;
          try {
            await fetchOne(id);
          } catch (err) {
            // One provider miss must not abandon the rest of the selection.
            failed += 1;
            this.logger.debug(`Bulk metadata failed for ${id}: ${(err as Error).message}`);
          }
          done += 1;
          report((done / Math.max(1, targets.length)) * 100, `${done}/${targets.length}`);
        }
        return { total: targets.length, completed: done, failed };
      },
    );

    await this.record('media.bulk.refresh_metadata', targets, ctx, { requested: ids.length, jobId });
    return { jobId, accepted: targets.length, missing };
  }

  /**
   * Lock or unlock a selection.
   *
   * Synchronous rather than a job: it is one indexed `updateMany`, and making
   * the operator watch a job for a flag flip would be ceremony. It still
   * audits as one action.
   */
  async setLocked(itemIds: string[], locked: boolean, ctx: AuditContext): Promise<BulkResult> {
    const { ids, missing } = await this.resolve(itemIds);
    await this.prisma.mediaItem.updateMany({ where: { id: { in: ids } }, data: { locked } });
    await this.record(locked ? 'media.bulk.lock' : 'media.bulk.unlock', ids, ctx, {});
    return { jobId: '', accepted: ids.length, missing };
  }

  /** Regenerate NFO sidecars for a selection, as one job. */
  async generateNfo(
    itemIds: string[],
    ctx: AuditContext,
    generateOne: (itemId: string) => Promise<unknown>,
  ): Promise<BulkResult> {
    const { ids, missing } = await this.resolve(itemIds);
    const targets = await this.unlockedOf(ids);

    const { jobId } = await this.jobs.runDetached(
      'nfo_generate',
      { libraryId: null, payload: { itemIds: targets } },
      async (report, signal) => {
        let done = 0;
        let failed = 0;
        for (const id of targets) {
          if (signal.isCancelled()) break;
          try {
            await generateOne(id);
          } catch (err) {
            failed += 1;
            this.logger.debug(`Bulk NFO failed for ${id}: ${(err as Error).message}`);
          }
          done += 1;
          report((done / Math.max(1, targets.length)) * 100, `${done}/${targets.length}`);
        }
        return { total: targets.length, completed: done, failed };
      },
    );

    await this.record('media.bulk.generate_nfo', targets, ctx, { requested: ids.length, jobId });
    return { jobId, accepted: targets.length, missing };
  }

  /**
   * Forget a selection: drop the library rows, leave every byte on disk.
   *
   * The safe half of "delete", and deliberately a **separate action** from
   * {@link deleteFiles} rather than a checkbox on it — an operator tidying a
   * library and an operator erasing media are doing different things, and the
   * destructive one should never be one mis-click from the reversible one.
   *
   * Reversible in the sense that matters: the files are untouched, so a rescan
   * brings the items back. That is also the caveat worth showing in the UI —
   * without excluding the folder, this is temporary.
   *
   * Synchronous: one indexed `deleteMany`, with the children removed by the
   * schema's cascades.
   */
  async removeFromLibrary(itemIds: string[], ctx: AuditContext): Promise<BulkResult> {
    const { ids, missing } = await this.resolve(itemIds);
    // Locked means "no automated path touches this". An operator deleting an
    // explicit selection is not an automated path, so a lock does not block it
    // — but it IS recorded, because that is the audit question later.
    const locked = await this.prisma.mediaItem.count({ where: { id: { in: ids }, locked: true } });
    await this.prisma.mediaItem.deleteMany({ where: { id: { in: ids } } });
    await this.record('media.bulk.remove', ids, ctx, { lockedIncluded: locked });
    return { jobId: '', accepted: ids.length, missing };
  }

  /**
   * Erase a selection's media from disk, then drop the rows.
   *
   * Irreversible, so it is a job rather than a request: it touches the
   * filesystem once per file and reports progress, and a half-finished delete
   * must leave the library describing what is actually still there.
   *
   * The row is dropped **only after** its files are gone. The other order —
   * delete rows, then unlink — loses the paths on any failure and leaves
   * orphaned media nothing points at. A file that is already missing counts as
   * success: the desired end state is "not on disk".
   */
  async deleteFiles(itemIds: string[], ctx: AuditContext): Promise<BulkResult> {
    const { ids, missing } = await this.resolve(itemIds);
    const items = await this.prisma.mediaItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, path: true, files: { select: { path: true } } },
    });

    const { jobId } = await this.jobs.runDetached(
      'media_delete_files',
      { libraryId: null, payload: { itemIds: ids } },
      async (report, signal) => {
        let done = 0;
        let failed = 0;
        let removedFiles = 0;
        for (const item of items) {
          if (signal.isCancelled()) break;
          // `path` is the item's own file for a single-file item; `files` may
          // repeat it. De-duplicate so one unlink failure is not counted twice.
          const paths = [...new Set([item.path, ...item.files.map((f) => f.path)].filter(Boolean))];
          let itemFailed = false;
          for (const p of paths) {
            try {
              await unlink(p);
              removedFiles += 1;
            } catch (err) {
              // Already gone is the end state we wanted; anything else is a
              // real failure and must keep the row.
              if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                itemFailed = true;
                this.logger.warn(`Delete failed for ${p}: ${(err as Error).message}`);
              }
            }
          }
          if (itemFailed) {
            failed += 1;
          } else {
            /*
             * Swallowing this would be the worst outcome available: the files
             * are already gone, so a silently-kept row leaves the library
             * advertising media that no longer exists, and the job would still
             * report success. If the row cannot go, say so.
             */
            try {
              await this.prisma.mediaItem.delete({ where: { id: item.id } });
            } catch (err) {
              failed += 1;
              this.logger.error(
                `Deleted files for ${item.id} but could not remove the row: ${(err as Error).message}`,
              );
            }
          }
          done += 1;
          report((done / Math.max(1, items.length)) * 100, `${done}/${items.length}`);
        }
        return { total: items.length, completed: done - failed, failed, removedFiles };
      },
    );

    await this.record('media.bulk.delete_files', ids, ctx, { jobId });
    return { jobId, accepted: items.length, missing };
  }

  /**
   * Move a selection into another library — the rows AND the media.
   *
   * "Move to another library" is only half a reassignment: leaving the files
   * under the old library's root would put them back on that library's next
   * scan, and the item would exist twice. So each file is moved under the
   * target root first, and the stored paths are rewritten to match.
   *
   * `rename` is used where it works and falls back to copy+unlink, because a
   * library root is very often a different filesystem (a NAS share versus local
   * disk) and `EXDEV` is the normal case there, not an error.
   */
  async moveToLibrary(itemIds: string[], targetLibraryId: string, ctx: AuditContext): Promise<BulkResult> {
    const target = await this.prisma.mediaLibrary.findUnique({
      where: { id: targetLibraryId },
      select: { id: true, path: true, name: true },
    });
    if (!target) throw new BadRequestException('Target library not found.');

    const { ids, missing } = await this.resolve(itemIds);
    const items = await this.prisma.mediaItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, path: true, libraryId: true, files: { select: { id: true, path: true } } },
    });
    // Moving an item into the library it already lives in is a no-op, not an
    // error — a mixed selection should move the rest rather than fail.
    const movable = items.filter((i) => i.libraryId !== target.id);

    const { jobId } = await this.jobs.runDetached(
      'media_move',
      { libraryId: target.id, payload: { itemIds: movable.map((i) => i.id) } },
      async (report, signal) => {
        let done = 0;
        let failed = 0;
        for (const item of movable) {
          if (signal.isCancelled()) break;
          try {
            const moves = new Map<string, string>();
            for (const p of [...new Set([item.path, ...item.files.map((f) => f.path)])]) {
              moves.set(p, join(target.path, basename(p)));
            }
            for (const [from, to] of moves) await moveFile(from, to);
            await this.prisma.$transaction([
              this.prisma.mediaItem.update({
                where: { id: item.id },
                data: { libraryId: target.id, path: moves.get(item.path) ?? item.path },
              }),
              ...item.files.map((f) =>
                this.prisma.mediaFile.update({
                  where: { id: f.id },
                  data: { path: moves.get(f.path) ?? f.path },
                }),
              ),
            ]);
          } catch (err) {
            failed += 1;
            this.logger.warn(`Move failed for ${item.id}: ${(err as Error).message}`);
          }
          done += 1;
          report((done / Math.max(1, movable.length)) * 100, `${done}/${movable.length}`);
        }
        return { total: movable.length, completed: done - failed, failed };
      },
    );

    await this.record('media.bulk.move', movable.map((i) => i.id), ctx, {
      targetLibraryId: target.id,
      alreadyThere: items.length - movable.length,
      jobId,
    });
    return { jobId, accepted: movable.length, missing };
  }

  /**
   * One audit row for one operator action.
   *
   * The affected ids are recorded on the row rather than as one row each: the
   * question an audit trail has to answer here is "who ran this, over what",
   * and a thousand rows describing one click answers it worse.
   */
  private async record(
    action: string,
    itemIds: string[],
    ctx: AuditContext,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      userId: ctx.userId,
      action,
      objectType: 'media_item',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { itemIds, count: itemIds.length, ...extra },
    });
  }
}
