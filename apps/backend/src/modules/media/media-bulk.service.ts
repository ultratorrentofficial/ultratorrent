import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from './media-metadata.service';
import { MediaProcessingQueueService } from './media-processing-queue.service';

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

export type BulkOperation = 'refresh_metadata' | 'lock' | 'unlock' | 'generate_nfo';

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
