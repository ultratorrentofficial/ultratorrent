import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../files/file-path.service';
import { FilesService } from '../files/files.service';
import { TrashService } from '../files/trash.service';
import { AuditService } from '../audit/audit.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NOTIFICATION_BUS_CHANNEL,
  NOTIFICATION_EVENTS,
  WS_EVENTS,
  type DuplicateResolutionEventPayload,
} from '@ultratorrent/shared';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { LANG_TAG, SUBTITLE_EXT } from './media-renamer';

/**
 * Ceiling on one bulk call. Not a performance limit — a blast-radius limit: an
 * operator who mis-clicks should lose a reviewable number of files, not a library.
 */
export const MAX_BULK_GROUPS = 100;

export interface ResolutionContext {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface PlannedAction {
  itemId: string;
  /** `trash` is the video; `trash_sidecar` is a file named after it. */
  actionType: 'trash' | 'trash_sidecar';
  sourcePath: string;
  /** Size at preview time — revalidated before the file is touched. */
  fileSize: number;
}

/**
 * A subtitle that exists only beside the copy being removed.
 *
 * These are deliberately NOT trashed and NOT silently orphaned — they are reported.
 * A `.nfo` or `-thumb.jpg` describes its video and is worthless once the video is
 * gone, but a subtitle is CONTENT: a live group planned to keep a 1080p release and
 * trash an organised copy that carried `…- Jane Foster.por.srt`, the only Portuguese
 * subtitle for that episode anywhere in the library. Deleting it is data loss;
 * leaving it unmentioned is a silent orphan. So the operator is told.
 */
export interface OrphanedSubtitle {
  path: string;
  language: string | null;
}

export interface ResolutionPreview {
  resolutionId: string;
  groupId: string;
  groupVersion: number;
  keepItemId: string;
  keepPath: string;
  actions: PlannedAction[];
  /** Subtitles unique to a removed copy — left on disk, surfaced for a decision. */
  orphanedSubtitles: OrphanedSubtitle[];
  expectedSavingsBytes: number;
  blockers: string[];
  warnings: string[];
}

/**
 * Preview for removing ONE specific copy while keeping the rest.
 *
 * The inverse of {@link ResolutionPreview}, which keeps one copy and trashes the
 * rest. This exists for a group of three-plus where the operator wants to thin out
 * particular copies rather than collapse the whole group to a single keeper.
 */
export interface ItemDeletionPreview {
  resolutionId: string;
  groupId: string;
  groupVersion: number;
  deleteItemId: string;
  deletePath: string;
  /** Every copy NOT being removed — the guarantee that a survivor remains. */
  survivorPaths: string[];
  actions: PlannedAction[];
  orphanedSubtitles: OrphanedSubtitle[];
  expectedSavingsBytes: number;
  blockers: string[];
  warnings: string[];
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
    private readonly trash: TrashService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly eventBus: EventEmitter2,
  ) {}

  /** One cleanup lifecycle event, scoped by the `media_manager.` name prefix. */
  private emitResolution(
    event: string,
    resolutionId: string,
    extra: Partial<DuplicateResolutionEventPayload> = {},
  ): void {
    this.realtime.broadcast(event, {
      resolutionId,
      status: 'running',
      at: new Date().toISOString(),
      ...extra,
    } as DuplicateResolutionEventPayload);
  }


  /**
   * Files named after `videoPath` that belong to it: `.nfo`, `-thumb.jpg`,
   * `.en.srt`, `-mediainfo.xml`.
   *
   * Matched STRUCTURALLY — basename plus an optional `-`/`.` suffix — which is the
   * same rule the renamer's sidecar pass uses, so the two agree about what belongs to
   * what. That rule is also what keeps SHOW-LEVEL files out: `poster.jpg`,
   * `fanart.jpg`, `tvshow.nfo`, `season01-poster.jpg` and `theme.mp3` are named after
   * the FOLDER, not the episode, so they never match and are never touched.
   */
  private async sidecarsOf(videoPath: string): Promise<string[]> {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    const entries = await readdir(dir).catch(() => [] as string[]);
    return entries
      .filter((name) => {
        const full = path.join(dir, name);
        if (full === videoPath) return false;
        const stem = path.basename(name, path.extname(name));
        if (!stem.startsWith(base)) return false;
        const suffix = stem.slice(base.length);
        // Same name, or the video's name plus a marker. A bare extra character means
        // a DIFFERENT file ("Episode 2" vs "Episode 20").
        return suffix === '' || /^[-.]/.test(suffix);
      })
      .map((name) => path.join(dir, name));
  }

  /** `foo.por.srt` → `por`. Null when the name carries no language tag. */
  private subtitleLanguage(p: string): string | null {
    const stem = path.basename(p, path.extname(p));
    const m = LANG_TAG.exec(stem);
    return m ? m[1].toLowerCase() : null;
  }

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

    // ONLY the media file is removed. Companion files — artwork, NFO, subtitles —
    // are deliberately left in place: the operator asked for the redundant *media*
    // to go, not its metadata. A stray `.nfo` beside a kept copy is harmless, and a
    // deleted subtitle or poster is not recoverable content the operator did not
    // ask to lose.
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

    // Retained only for the stored-plan shape; sidecars are no longer removed, so a
    // cleanup can never orphan a subtitle.
    const warnings: string[] = [];
    const orphanedSubtitles: OrphanedSubtitle[] = [];

    const expected = actions.reduce((a, x) => a + x.fileSize, 0);
    const resolution = await this.prisma.mediaDuplicateResolution.create({
      data: {
        // Explicit rather than left to the column default: show-folder merges share
        // this table, and `resolve` refuses anything that is not a group plan.
        scope: 'group',
        groupId,
        status: 'pending',
        keepItemId: keepId,
        groupVersion: group.version,
        // `survivorPaths` generalises the keeper-existence guard `resolve` runs: for
        // a keep-one plan the only survivor is the keeper, so it is a one-element
        // list. The single-file deletion path (below) stores every copy it is NOT
        // removing here, and the same guard then means "at least one copy survives".
        preview: {
          mode: 'keep_one',
          keepPath,
          survivorPaths: [keepPath],
          actions,
          blockers,
          warnings,
          orphanedSubtitles,
        } as unknown as object,
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
      metadata: {
        resolutionId: resolution.id,
        keepItemId: keepId,
        trashCount: actions.length,
        orphanedSubtitles: orphanedSubtitles.length,
        expected,
      },
    });

    return {
      resolutionId: resolution.id,
      groupId,
      groupVersion: group.version,
      keepItemId: keepId,
      keepPath,
      actions,
      orphanedSubtitles,
      expectedSavingsBytes: expected,
      blockers,
      warnings,
    };
  }

  /**
   * Build and persist a plan that trashes ONE named copy and keeps the others.
   *
   * The inverse of {@link preview}. Where `preview` keeps a single copy and trashes
   * the rest, this trashes a single copy and keeps the rest — the operation behind a
   * per-file **Delete** button, for a group of three-plus where the operator wants
   * to remove specific copies without collapsing the group to one.
   *
   * The survivor guarantee: a group always has >= 2 members, so removing one leaves
   * >= 1. The plan records the survivor paths, and `resolve` refuses if none still
   * exists — so even a race that removed the other copies first cannot leave zero.
   *
   * Subtitle safety is generalised too: a language is safe to trash on the removed
   * copy only if **some surviving copy** still has it. A language that exists nowhere
   * among the survivors is content, and is reported as orphaned rather than deleted.
   */
  async previewItemDeletion(
    groupId: string,
    deleteItemId: string,
    ctx: ResolutionContext = {},
  ): Promise<ItemDeletionPreview> {
    const group = await this.prisma.mediaDuplicateGroup.findUnique({
      where: { id: groupId },
      include: { items: { include: { files: true } } },
    });
    if (!group) throw new NotFoundException('Duplicate group not found');
    if (group.status === 'resolved') throw new ConflictException('This group has already been resolved.');
    if (group.items.length < 2) throw new BadRequestException('A group needs at least two members to resolve.');

    // Untrusted client input: the id must belong to THIS group, or a caller could
    // nominate an unrelated item for deletion.
    const target = group.items.find((i) => i.id === deleteItemId);
    if (!target) throw new BadRequestException('The chosen copy is not a member of this group.');

    const survivors = group.items.filter((i) => i.id !== deleteItemId);
    if (!survivors.length) {
      // Unreachable given the >= 2 check above, but the invariant this method exists
      // to protect is "never delete the last copy", so it is asserted, not assumed.
      throw new BadRequestException('Refusing to delete the only copy in the group.');
    }

    const blockers: string[] = [];
    const libs = await this.prisma.mediaLibrary.findMany({ select: { path: true } });
    const roots = new Set(libs.map((l) => path.resolve(l.path)));

    const deletePath = target.files[0]?.path ?? target.path;
    const actions: PlannedAction[] = [];
    try {
      this.filePath.assertWithinHardRoots(deletePath);
      if (roots.has(path.resolve(deletePath))) {
        blockers.push(`"${deletePath}" is a library root, not a media file — refusing to delete it.`);
      } else {
        actions.push({
          itemId: target.id,
          actionType: 'trash',
          sourcePath: deletePath,
          fileSize: Number(target.files[0]?.size ?? 0),
        });
      }
    } catch {
      blockers.push(`"${deletePath}" is outside the allowed storage roots.`);
    }

    // ONLY the media file is removed; its artwork, NFO and subtitles are left in
    // place. Retained only for the stored-plan shape.
    const warnings: string[] = [];
    const orphanedSubtitles: OrphanedSubtitle[] = [];
    if (!actions.length && !blockers.length) {
      blockers.push('Nothing to delete — that copy has no file on disk.');
    }

    const survivorPaths = survivors.map((s) => s.files[0]?.path ?? s.path);
    const expected = actions.reduce((a, x) => a + x.fileSize, 0);
    const resolution = await this.prisma.mediaDuplicateResolution.create({
      data: {
        scope: 'group',
        groupId,
        status: 'pending',
        // No keeper: this removes one copy and keeps several, so there is no single
        // "kept" item to name.
        keepItemId: null,
        groupVersion: group.version,
        preview: {
          mode: 'delete_item',
          deleteItemId,
          deletePath,
          survivorPaths,
          actions,
          blockers,
          warnings,
          orphanedSubtitles,
        } as unknown as object,
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
      metadata: {
        resolutionId: resolution.id,
        deleteItemId,
        mode: 'delete_item',
        trashCount: actions.length,
        orphanedSubtitles: orphanedSubtitles.length,
        expected,
      },
    });

    return {
      resolutionId: resolution.id,
      groupId,
      groupVersion: group.version,
      deleteItemId,
      deletePath,
      survivorPaths,
      actions,
      orphanedSubtitles,
      expectedSavingsBytes: expected,
      blockers,
      warnings,
    };
  }

  /**
   * Execute a previously previewed plan.
   *
   * Reads the stored preview rather than accepting one from the client, refuses a
   * stale plan, revalidates every path immediately before touching it, and journals
   * each step before attempting it.
   */
  async resolve(resolutionId: string, ctx: ResolutionContext = {}, opts: { permanent?: boolean } = {}) {
    // Permanent skips Trash: these are large media files, and an operator who is
    // sure does not want a redundant 30 GB copy sitting in Trash for the retention
    // window. `permanent` is a confirm-time choice, not part of the stored plan — it
    // changes HOW the approved files are removed, never WHICH ones.
    const permanent = opts.permanent === true;
    const resolution = await this.prisma.mediaDuplicateResolution.findUnique({
      where: { id: resolutionId },
      include: { group: true },
    });
    // Show-folder merges share this table but not this code path, and their stored
    // plan has an entirely different shape — running one through here would read
    // `actions` that mean something else.
    if (!resolution || resolution.scope !== 'group' || !resolution.group || !resolution.groupId) {
      throw new NotFoundException('Resolution not found');
    }
    const groupId = resolution.groupId;
    if (resolution.status !== 'pending') {
      throw new ConflictException(`This plan is already ${resolution.status}.`);
    }

    const preview = resolution.preview as unknown as {
      mode?: 'keep_one' | 'delete_item';
      keepPath?: string;
      survivorPaths?: string[];
      actions: PlannedAction[];
      blockers: string[];
    } | null;
    if (!preview) throw new BadRequestException('This plan has no stored preview.');
    if (preview.blockers?.length) {
      throw new BadRequestException(`Refusing to resolve: ${preview.blockers.join(' ')}`);
    }
    const isItemDeletion = preview.mode === 'delete_item';

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

    // At least one surviving copy must still be there. Trashing the redundant copies
    // when every survivor has vanished would leave no copy at all. For a keep-one
    // plan the sole survivor is the keeper; for a single-file deletion it is any of
    // the copies not being removed. Older stored plans carry only `keepPath`.
    const survivorPaths = preview.survivorPaths ?? (preview.keepPath ? [preview.keepPath] : []);
    const anySurvives =
      survivorPaths.length > 0 &&
      (await Promise.all(survivorPaths.map((p) => stat(p).then(() => true).catch(() => false)))).some(Boolean);
    if (!anySurvives) {
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
    this.emitResolution(WS_EVENTS.MEDIA_DUPLICATE_RESOLUTION_STARTED, resolutionId, {
      groupId: resolution.groupId,
      status: 'started',
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

        // `storage` scope, matching the assertWithinHardRoots check above and the
        // one preview ran: a library may legitimately sit outside the admin's
        // narrowed Default Root Path, and a browse preference must not decide
        // which libraries can be maintained.
        await this.files.remove(
          { path: this.filePath.storageSafety.toRelative(action.sourcePath), permanent },
          ctx,
          'storage',
        );
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

    // A keep-one cleanup collapses the group to a single copy, so the group is
    // resolved. A single-file deletion may leave TWO-plus copies still duplicated —
    // marking it resolved would hide a group that is still a duplicate. So it is left
    // open, and the next detection run reconciles it against what is now on disk.
    if (status !== 'failed' && !isItemDeletion) {
      await this.prisma.mediaDuplicateGroup.update({
        where: { id: groupId },
        data: { status: 'resolved', resolvedById: ctx.userId ?? null, resolvedAt: new Date() },
      });
    }

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.duplicates.resolved',
      objectType: 'media_duplicate_group',
      objectId: groupId,
      result: status === 'completed' ? 'success' : 'failure',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { resolutionId, status, trashed, skipped, failed, reclaimed, permanent },
    });

    // Partial gets its OWN event rather than riding on `completed` with a count
    // attached: a rule that notifies on completion should not be silently notifying
    // on half-completion too.
    const wsEvent =
      status === 'completed'
        ? WS_EVENTS.MEDIA_DUPLICATE_RESOLUTION_COMPLETED
        : status === 'partial'
          ? WS_EVENTS.MEDIA_DUPLICATE_RESOLUTION_PARTIAL
          : WS_EVENTS.MEDIA_DUPLICATE_RESOLUTION_FAILED;
    this.emitResolution(wsEvent, resolutionId, {
      groupId: resolution.groupId,
      status,
      trashed,
      skipped,
      failed,
      reclaimedBytes: reclaimed,
    });

    this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, {
      event:
        status === 'completed'
          ? NOTIFICATION_EVENTS.MEDIA_DUPLICATE_CLEANUP_COMPLETED
          : NOTIFICATION_EVENTS.MEDIA_DUPLICATE_CLEANUP_FAILED,
      payload: {
        // Name the surviving copy for a keep-one plan; for a deletion there is no
        // single keeper, so fall back to a stable label.
        mediaTitle: (preview.keepPath ?? survivorPaths[0])?.split('/').pop() ?? 'Duplicate cleanup',
        groupId: resolution.groupId,
        resolutionId,
        status,
        trashed,
        skipped,
        failed,
        reclaimedBytes: reclaimed,
        reviewUrl: '/media/duplicates',
      },
      at: new Date().toISOString(),
    });

    return { resolutionId, status, trashed, skipped, failed, reclaimedBytes: reclaimed, permanent };
  }

  /**
   * Files this feature put in Trash that are STILL THERE, newest first.
   *
   * This is a live recoverability view, not a history log. A row appears only when
   * a matching Trash entry actually exists, so a file the operator chose to delete
   * permanently never shows up here, and one the retention sweep has taken is gone
   * rather than lingering as a "no longer in Trash" tombstone. Anyone wanting the
   * full history has the resolution journal and the audit log; padding this surface
   * with unrecoverable entries only made it ambiguous which rows meant anything.
   *
   * Correlated with the journal by path rather than a new column on `TrashItem`,
   * so there is no second source of truth — but note the two sides store DIFFERENT
   * path shapes: the journal keeps an absolute path (`/downloads/TV/x.mkv`) while
   * `TrashItem.originalPath` is root-relative (`/TV/x.mkv`). Comparing them raw
   * matched nothing, which is why every row used to render as unrecoverable.
   */
  async trashedByCleanup(limit = 100) {
    const actions = await this.prisma.mediaDuplicateResolutionAction.findMany({
      where: { status: 'completed', actionType: { in: ['trash', 'trash_sidecar'] } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      select: { id: true, sourcePath: true, actionType: true, createdAt: true, resolutionId: true },
    });
    if (!actions.length) return [];

    // Rebase each journal path onto its storage root before comparing. A path that
    // no longer resolves inside the hard roots (root reconfigured since cleanup ran)
    // simply has no live Trash entry, which is the honest answer.
    const relById = new Map<string, string>();
    for (const a of actions) {
      if (!a.sourcePath) continue;
      try {
        relById.set(a.id, this.filePath.storageSafety.toRelative(a.sourcePath));
      } catch {
        /* outside the allowed roots — not recoverable through Trash */
      }
    }
    if (!relById.size) return [];

    const items = await this.prisma.trashItem.findMany({
      where: { originalPath: { in: [...new Set(relById.values())] } },
      select: { id: true, originalPath: true, name: true, size: true, deletedAt: true },
    });
    if (!items.length) return [];
    const byPath = new Map(items.map((t) => [t.originalPath, t]));

    const retentionDays = await this.trash.retentionDays();
    const now = Date.now();

    return actions.flatMap((a) => {
      const rel = relById.get(a.id);
      const t = rel ? byPath.get(rel) : undefined;
      if (!t) return [];
      // Withhold anything already past its window; the sweep is about to remove it
      // and a zeroed countdown next to a Restore button is a lie.
      const expiresAt = this.trash.expiryOf(t.deletedAt, retentionDays);
      if (expiresAt && Date.parse(expiresAt) <= now) return [];
      return [
        {
          actionId: a.id,
          resolutionId: a.resolutionId,
          actionType: a.actionType,
          originalPath: a.sourcePath,
          removedAt: a.createdAt,
          trashItemId: t.id,
          name: t.name,
          size: Number(t.size),
          deletedAt: t.deletedAt,
          /** When the retention sweep will take it; `null` if retention is off. */
          expiresAt,
          restorable: true,
        },
      ];
    });
  }

  // --- bulk ------------------------------------------------------------------

  /**
   * Groups that are safe to clean without opening each one.
   *
   * Eligibility is decided by the SERVER, never by the client: a group qualifies only
   * if the recommendation engine both declined to flag it for review AND nominated a
   * keeper. Those two go together by design — the engine sets `recommendedItemId` to
   * null whenever it forces review, precisely so a bulk path cannot sweep up the
   * cases a human was meant to see.
   */
  async quickCleanCandidates(limit = MAX_BULK_GROUPS) {
    const groups = await this.prisma.mediaDuplicateGroup.findMany({
      where: { status: 'open', requiresReview: false, recommendedItemId: { not: null } },
      orderBy: { potentialSavingsBytes: 'desc' },
      take: Math.min(limit, MAX_BULK_GROUPS),
      include: { items: { select: { id: true, title: true, path: true } } },
    });
    return {
      groups: groups.map((g) => ({
        id: g.id,
        title: g.items[0]?.title ?? null,
        reason: g.reason,
        confidence: g.confidence,
        fileCount: g.items.length,
        recommendedItemId: g.recommendedItemId,
        potentialSavingsBytes: Number(g.potentialSavingsBytes),
        version: g.version,
      })),
      totalGroups: groups.length,
      totalFiles: groups.reduce((a, g) => a + Math.max(0, g.items.length - 1), 0),
      totalSavingsBytes: groups.reduce((a, g) => a + Number(g.potentialSavingsBytes), 0),
      cap: MAX_BULK_GROUPS,
    };
  }

  /**
   * Build a plan for each group. Touches nothing.
   *
   * A review-required group is REFUSED rather than quietly dropped: silently omitting
   * it would let a caller believe a bulk selection was fully planned when part of it
   * was ignored. `includeReviewRequired` exists for the operator who has explicitly
   * chosen a keeper per group, and even then each such group must carry one.
   */
  async bulkPreview(
    groupIds: string[],
    keepByGroup: Record<string, string> = {},
    ctx: ResolutionContext = {},
  ) {
    if (!groupIds.length) throw new BadRequestException('No groups selected.');
    if (groupIds.length > MAX_BULK_GROUPS) {
      throw new BadRequestException(`Select at most ${MAX_BULK_GROUPS} groups at a time.`);
    }

    const results: Array<{
      groupId: string;
      ok: boolean;
      message?: string;
      resolutionId?: string;
      trashCount?: number;
      expectedSavingsBytes?: number;
      orphanedSubtitles?: number;
    }> = [];

    for (const groupId of groupIds) {
      try {
        const plan = await this.preview(groupId, keepByGroup[groupId], ctx);
        if (plan.blockers.length) {
          results.push({ groupId, ok: false, message: plan.blockers.join(' ') });
          continue;
        }
        results.push({
          groupId,
          ok: true,
          resolutionId: plan.resolutionId,
          trashCount: plan.actions.length,
          expectedSavingsBytes: plan.expectedSavingsBytes,
          orphanedSubtitles: plan.orphanedSubtitles.length,
        });
      } catch (err) {
        results.push({ groupId, ok: false, message: (err as Error).message });
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    return {
      succeeded,
      failed: results.length - succeeded,
      totalSavingsBytes: results.reduce((a, r) => a + (r.expectedSavingsBytes ?? 0), 0),
      totalFiles: results.reduce((a, r) => a + (r.trashCount ?? 0), 0),
      results,
    };
  }

  /**
   * Execute previously previewed plans.
   *
   * Every plan is run independently and every outcome is reported. A failure part-way
   * through does not abort the rest, and — the point of the standardised envelope —
   * a response carrying failures is never indistinguishable from a clean run.
   */
  async bulkResolve(resolutionIds: string[], ctx: ResolutionContext = {}, opts: { permanent?: boolean } = {}) {
    if (!resolutionIds.length) throw new BadRequestException('No plans to run.');
    if (resolutionIds.length > MAX_BULK_GROUPS) {
      throw new BadRequestException(`Run at most ${MAX_BULK_GROUPS} plans at a time.`);
    }

    const results: Array<{
      resolutionId: string;
      ok: boolean;
      status?: string;
      message?: string;
      trashed?: number;
      skipped?: number;
      failed?: number;
      reclaimedBytes?: number;
    }> = [];

    for (const id of resolutionIds) {
      try {
        const r = await this.resolve(id, ctx, { permanent: opts.permanent === true });
        results.push({
          resolutionId: id,
          // `partial` is NOT ok. A run that trashed some files and failed on others
          // is a problem the operator has to see, not a success with a footnote.
          ok: r.status === 'completed',
          status: r.status,
          trashed: r.trashed,
          skipped: r.skipped,
          failed: r.failed,
          reclaimedBytes: r.reclaimedBytes,
        });
      } catch (err) {
        results.push({ resolutionId: id, ok: false, status: 'failed', message: (err as Error).message });
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    const reclaimed = results.reduce((a, r) => a + (r.reclaimedBytes ?? 0), 0);

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.duplicates.bulk_resolved',
      objectType: 'media_duplicate_group',
      objectId: 'bulk',
      result: succeeded === results.length ? 'success' : 'failure',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { total: results.length, succeeded, failed: results.length - succeeded, reclaimed, permanent: opts.permanent === true },
    });

    return { succeeded, failed: results.length - succeeded, reclaimedBytes: reclaimed, results };
  }
}
