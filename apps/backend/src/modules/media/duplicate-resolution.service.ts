import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../files/file-path.service';
import { FilesService } from '../files/files.service';
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

    const actions: PlannedAction[] = [];
    const removedVideos: string[] = [];
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
      removedVideos.push(p);
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

    // Sidecars follow the video they describe. Trashing the video and leaving its
    // .nfo and -thumb.jpg behind orphans metadata that now describes nothing — the
    // same orphaning the renamer's sidecar pass exists to prevent.
    const warnings: string[] = [];
    const orphanedSubtitles: OrphanedSubtitle[] = [];
    const keepSidecars = await this.sidecarsOf(keepPath);
    const keptSubLangs = new Set(
      keepSidecars
        .filter((f) => SUBTITLE_EXT.has(path.extname(f).toLowerCase()))
        .map((f) => this.subtitleLanguage(f)),
    );

    for (const video of removedVideos) {
      for (const sc of await this.sidecarsOf(video)) {
        const ext = path.extname(sc).toLowerCase();
        if (SUBTITLE_EXT.has(ext)) {
          const lang = this.subtitleLanguage(sc);
          // A subtitle the keeper does not already have is CONTENT that exists
          // nowhere else. It is neither trashed nor silently left: it is reported.
          if (!keptSubLangs.has(lang)) {
            orphanedSubtitles.push({ path: sc, language: lang });
            continue;
          }
        }
        const st = await stat(sc).catch(() => null);
        if (!st?.isFile()) continue;
        actions.push({
          itemId: '',
          actionType: 'trash_sidecar',
          sourcePath: sc,
          fileSize: st.size,
        });
      }
    }

    if (orphanedSubtitles.length) {
      warnings.push(
        `${orphanedSubtitles.length} subtitle(s) exist only beside a copy being removed and will be left in place: ` +
          orphanedSubtitles.map((o) => path.basename(o.path)).join(', '),
      );
    }

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
        preview: { keepPath, actions, blockers, warnings, orphanedSubtitles } as unknown as object,
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
      metadata: { resolutionId, status, trashed, skipped, failed, reclaimed },
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
        mediaTitle: preview.keepPath.split('/').pop() ?? 'Duplicate cleanup',
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

    return { resolutionId, status, trashed, skipped, failed, reclaimedBytes: reclaimed };
  }

  /**
   * Files this feature sent to Trash, newest first.
   *
   * Correlated with the resolution journal by path rather than by a new column on
   * `TrashItem`: the Trash surface already exists and works (list/restore/purge), and
   * the action journal already records every path the Duplicate Center removed, so a
   * parallel origin field would be a second source of truth for something already
   * knowable. Restore goes through the existing `/files/trash/restore` route.
   */
  async trashedByCleanup(limit = 100) {
    const actions = await this.prisma.mediaDuplicateResolutionAction.findMany({
      where: { status: 'completed', actionType: { in: ['trash', 'trash_sidecar'] } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      select: { id: true, sourcePath: true, actionType: true, createdAt: true, resolutionId: true },
    });
    if (!actions.length) return [];

    const items = await this.prisma.trashItem.findMany({
      where: { originalPath: { in: actions.map((a) => a.sourcePath!).filter(Boolean) } },
      select: { id: true, originalPath: true, name: true, size: true, deletedAt: true },
    });
    const byPath = new Map(items.map((t) => [t.originalPath, t]));

    return actions.map((a) => {
      const t = a.sourcePath ? byPath.get(a.sourcePath) : undefined;
      return {
        actionId: a.id,
        resolutionId: a.resolutionId,
        actionType: a.actionType,
        originalPath: a.sourcePath,
        removedAt: a.createdAt,
        // Null when the retention window has already purged it — the journal
        // outlives the Trash entry, and saying "gone" is better than implying it is
        // still restorable.
        trashItemId: t?.id ?? null,
        name: t?.name ?? null,
        size: t ? Number(t.size) : null,
        deletedAt: t?.deletedAt ?? null,
        restorable: !!t,
      };
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
  async bulkResolve(resolutionIds: string[], ctx: ResolutionContext = {}) {
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
        const r = await this.resolve(id, ctx);
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
      metadata: { total: results.length, succeeded, failed: results.length - succeeded, reclaimed },
    });

    return { succeeded, failed: results.length - succeeded, reclaimedBytes: reclaimed, results };
  }
}
