import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../files/file-path.service';
import { FilesService } from '../files/files.service';
import { AuditService } from '../audit/audit.service';

export interface ResolutionContext {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface PlannedAction {
  itemId: string;
  actionType: 'trash';
  sourcePath: string;
  /** Size at preview time — revalidated before the file is touched. */
  fileSize: number;
}

export interface ResolutionPreview {
  resolutionId: string;
  groupId: string;
  groupVersion: number;
  keepItemId: string;
  keepPath: string;
  actions: PlannedAction[];
  expectedSavingsBytes: number;
  blockers: string[];
}

/**
 * Resolving a duplicate group: plan first, then execute the plan that was approved.
 *
 * Three properties this is built around, each of them a defect observed in the
 * existing show-folder merge and recorded in `docs/DUPLICATES_REDESIGN_REVIEW.md`:
 *
 * 1. **The plan that executes is the plan that was approved.** The show merge
 *    recomputes its plan at execute time, so if the disk changed between preview and
 *    confirm, the operator approved something other than what runs. Here the preview
 *    is persisted and execution reads it back, pinned to the group `version` it was
 *    built against — a group that has since been re-detected refuses rather than
 *    acting on a membership nobody reviewed.
 *
 * 2. **Every path is revalidated at execution**, not merely at preview. Existence,
 *    size, hard-root confinement and library-root protection are all re-checked
 *    immediately before the file is touched, because a preview is a statement about
 *    the past.
 *
 * 3. **The journal is written before the filesystem is touched.** A database
 *    transaction cannot roll back a file that has already moved, so recovery needs a
 *    record of intent that survives a crash mid-operation. Each action row goes to
 *    `running` before its step and `completed`/`failed` after.
 *
 * Deletion is always Trash, never `rm` — `FilesService.remove({ permanent: false })`
 * writes a `TrashItem` the operator can restore from.
 */
@Injectable()
export class DuplicateResolutionService {
  private readonly logger = new Logger(DuplicateResolutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly filePath: FilePathService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Build and persist a resolution plan. Touches no files.
   *
   * `keepItemId` lets the operator override the recommendation. It is required when
   * the group requires review — the engine deliberately withholds a recommendation
   * there, and inventing one at preview time would defeat that.
   */
  async preview(groupId: string, keepItemId: string | undefined, ctx: ResolutionContext = {}): Promise<ResolutionPreview> {
    const group = await this.prisma.mediaDuplicateGroup.findUnique({
      where: { id: groupId },
      include: { items: { include: { files: true } } },
    });
    if (!group) throw new NotFoundException('Duplicate group not found');
    if (group.status === 'resolved') throw new ConflictException('This group has already been resolved.');
    if (group.items.length < 2) throw new BadRequestException('A group needs at least two members to resolve.');

    const keepId = keepItemId ?? group.recommendedItemId;
    if (!keepId) {
      throw new BadRequestException(
        'This group needs review — choose which copy to keep before previewing a cleanup.',
      );
    }
    // A candidate id from the client is untrusted input: it must belong to THIS group,
    // or a caller could nominate an unrelated item and have everything else trashed.
    const keep = group.items.find((i) => i.id === keepId);
    if (!keep) throw new BadRequestException('The chosen copy is not a member of this group.');

    const blockers: string[] = [];
    const libs = await this.prisma.mediaLibrary.findMany({ select: { path: true } });
    const roots = new Set(libs.map((l) => path.resolve(l.path)));

    const actions: PlannedAction[] = [];
    for (const item of group.items) {
      if (item.id === keepId) continue;
      const p = item.files[0]?.path ?? item.path;
      try {
        this.filePath.assertWithinHardRoots(p);
      } catch {
        blockers.push(`"${p}" is outside the allowed storage roots.`);
        continue;
      }
      if (roots.has(path.resolve(p))) {
        blockers.push(`"${p}" is a library root, not a media file — refusing to delete it.`);
        continue;
      }
      actions.push({
        itemId: item.id,
        actionType: 'trash',
        sourcePath: p,
        fileSize: Number(item.files[0]?.size ?? 0),
      });
    }

    if (!actions.length && !blockers.length) {
      blockers.push('Nothing to clean up — the group has no redundant copies.');
    }

    const keepPath = keep.files[0]?.path ?? keep.path;
    try {
      this.filePath.assertWithinHardRoots(keepPath);
    } catch {
      blockers.push(`The copy being kept ("${keepPath}") is outside the allowed storage roots.`);
    }

    const expected = actions.reduce((a, x) => a + x.fileSize, 0);
    const resolution = await this.prisma.mediaDuplicateResolution.create({
      data: {
        groupId,
        status: 'pending',
        keepItemId: keepId,
        groupVersion: group.version,
        preview: { keepPath, actions, blockers } as unknown as object,
        expectedSavingsBytes: BigInt(expected),
        createdById: ctx.userId ?? null,
      },
    });

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.duplicates.preview',
      objectType: 'media_duplicate_group',
      objectId: groupId,
      result: blockers.length ? 'failure' : 'success',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { resolutionId: resolution.id, keepItemId: keepId, trashCount: actions.length, expected },
    });

    return {
      resolutionId: resolution.id,
      groupId,
      groupVersion: group.version,
      keepItemId: keepId,
      keepPath,
      actions,
      expectedSavingsBytes: expected,
      blockers,
    };
  }

  /**
   * Execute a previously previewed plan.
   *
   * Reads the stored preview rather than accepting one from the client, refuses a
   * stale plan, revalidates every path immediately before touching it, and journals
   * each step before attempting it.
   */
  async resolve(resolutionId: string, ctx: ResolutionContext = {}) {
    const resolution = await this.prisma.mediaDuplicateResolution.findUnique({
      where: { id: resolutionId },
      include: { group: true },
    });
    if (!resolution) throw new NotFoundException('Resolution not found');
    if (resolution.status !== 'pending') {
      throw new ConflictException(`This plan is already ${resolution.status}.`);
    }

    const preview = resolution.preview as unknown as { keepPath: string; actions: PlannedAction[]; blockers: string[] } | null;
    if (!preview) throw new BadRequestException('This plan has no stored preview.');
    if (preview.blockers?.length) {
      throw new BadRequestException(`Refusing to resolve: ${preview.blockers.join(' ')}`);
    }

    // Optimistic concurrency. Detection bumps `version` whenever a group is
    // re-detected, so a plan built against an older version describes a membership
    // the operator reviewed and the system no longer has.
    if (resolution.group.version !== resolution.groupVersion) {
      await this.prisma.mediaDuplicateResolution.update({
        where: { id: resolutionId },
        data: { status: 'failed', failedAt: new Date(), errorSummary: 'stale_plan' },
      });
      throw new ConflictException(
        'This group changed since the preview was generated. Review it again before cleaning up.',
      );
    }

    // The kept copy must still be there. Trashing the redundant copies when the
    // keeper has vanished would leave no copy at all.
    const keepExists = await stat(preview.keepPath).then(() => true).catch(() => false);
    if (!keepExists) {
      await this.prisma.mediaDuplicateResolution.update({
        where: { id: resolutionId },
        data: { status: 'failed', failedAt: new Date(), errorSummary: 'keeper_missing' },
      });
      throw new ConflictException('The copy being kept no longer exists on disk. Nothing was changed.');
    }

    await this.prisma.mediaDuplicateResolution.update({
      where: { id: resolutionId },
      data: { status: 'running', startedAt: new Date() },
    });

    const libs = await this.prisma.mediaLibrary.findMany({ select: { path: true } });
    const roots = new Set(libs.map((l) => path.resolve(l.path)));

    let trashed = 0;
    let failed = 0;
    let skipped = 0;
    let reclaimed = 0;

    for (const action of preview.actions) {
      // Journal BEFORE the filesystem step: a crash between here and the next write
      // leaves a `running` row naming exactly what was in flight.
      const row = await this.prisma.mediaDuplicateResolutionAction.create({
        data: {
          resolutionId,
          actionType: action.actionType,
          status: 'running',
          sourcePath: action.sourcePath,
          metadata: { itemId: action.itemId, expectedSize: action.fileSize } as unknown as object,
        },
      });

      try {
        // Revalidate against the world as it is NOW, not as the preview described it.
        this.filePath.assertWithinHardRoots(action.sourcePath);
        if (roots.has(path.resolve(action.sourcePath))) {
          throw new Error('refusing to delete a library root');
        }
        const st = await stat(action.sourcePath).catch(() => null);
        if (!st) {
          await this.prisma.mediaDuplicateResolutionAction.update({
            where: { id: row.id },
            data: { status: 'skipped', errorMessage: 'file no longer exists' },
          });
          skipped++;
          continue;
        }
        // A size change means the file was replaced or is still being written. The
        // operator approved trashing a specific file, not whatever now sits there.
        if (action.fileSize > 0 && st.size !== action.fileSize) {
          await this.prisma.mediaDuplicateResolutionAction.update({
            where: { id: row.id },
            data: { status: 'skipped', errorMessage: `size changed since preview (${action.fileSize} → ${st.size})` },
          });
          skipped++;
          continue;
        }

        await this.files.remove({ path: this.filePath.safety.toRelative(action.sourcePath), permanent: false }, ctx);
        reclaimed += st.size;
        trashed++;
        await this.prisma.mediaDuplicateResolutionAction.update({
          where: { id: row.id },
          data: { status: 'completed' },
        });
      } catch (err) {
        failed++;
        this.logger.warn(`Duplicate cleanup failed for "${action.sourcePath}": ${(err as Error).message}`);
        await this.prisma.mediaDuplicateResolutionAction.update({
          where: { id: row.id },
          data: { status: 'failed', errorMessage: (err as Error).message },
        });
      }
    }

    // Partial success is reported as partial. An HTTP 200 carrying failures that the
    // UI renders as "done" is how an operator learns to distrust the tool.
    const status = failed > 0 ? (trashed > 0 ? 'partial' : 'failed') : 'completed';
    await this.prisma.mediaDuplicateResolution.update({
      where: { id: resolutionId },
      data: {
        status,
        actualSavingsBytes: BigInt(reclaimed),
        completedAt: status === 'completed' || status === 'partial' ? new Date() : null,
        failedAt: status === 'failed' ? new Date() : null,
        errorSummary: failed ? `${failed} action(s) failed` : null,
      },
    });

    if (status !== 'failed') {
      await this.prisma.mediaDuplicateGroup.update({
        where: { id: resolution.groupId },
        data: { status: 'resolved', resolvedById: ctx.userId ?? null, resolvedAt: new Date() },
      });
    }

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.duplicates.resolved',
      objectType: 'media_duplicate_group',
      objectId: resolution.groupId,
      result: status === 'completed' ? 'success' : 'failure',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { resolutionId, status, trashed, skipped, failed, reclaimed },
    });

    return { resolutionId, status, trashed, skipped, failed, reclaimedBytes: reclaimed };
  }
}
