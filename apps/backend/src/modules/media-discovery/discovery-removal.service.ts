import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MediaBulkService, type TorrentAction } from '../media/media-bulk.service';

/**
 * Removing a discovered title, and everything that exists because of it.
 *
 * Three rules shape this file, and all three exist because the alternative
 * destroys something nothing else can reproduce.
 *
 * **1. Scope is chosen, never assumed.** "Remove this show" means four different
 * things depending on who is asking: drop it from a listing, stop watching for
 * it, or delete 40 GB of episodes. They escalate, the caller names one, and the
 * least destructive is the default.
 *
 * **2. Library media is matched by external id ONLY.** Title-and-year is a hint
 * good enough to group a listing and nowhere near good enough to delete by: two
 * films genuinely share a title and year, and the cost of being wrong here is a
 * permanently deleted library item. A title carrying no external id reports
 * "cannot identify" rather than guessing, and its files are left alone.
 *
 * **3. Nothing is deleted by this service directly.** File removal goes through
 * `MediaBulkService.deleteFiles`, which already handles sidecars, artwork,
 * subtitles and the source torrent, runs as an audited background job, and
 * removes to Trash rather than unlinking. A second deletion path would be a
 * second set of bugs.
 */

/** Escalating, each including the one before it. */
export type RemovalScope = 'catalog' | 'monitoring' | 'library';

export interface RemovalRequest {
  scope: RemovalScope;
  /** Only consulted at `library` scope. */
  torrentAction?: TorrentAction;
}

export interface RemovalPlan {
  id: string;
  title: string;
  year: number | null;
  mediaType: string;
  /** Rows that disappear from the catalogue itself. */
  catalog: { evaluations: number; releaseDates: number };
  monitoring: {
    /** A generated rule that would be deleted. */
    rule: { id: string; name: string } | null;
    /** A rule discovery generated but a person then edited — never touched. */
    userModifiedRule: { id: string; name: string } | null;
    watchlistItem: { id: string; title: string; status: string } | null;
  };
  library: {
    /** Media items matched by external id. */
    items: { id: string; title: string; path: string }[];
    /** Why no items were matched, when that is not simply "you own none". */
    unmatchedReason: 'no_external_ids' | null;
  };
}

export interface RemovalResult extends RemovalPlan {
  scope: RemovalScope;
  removed: {
    catalogRow: boolean;
    rule: boolean;
    watchlistArchived: boolean;
    libraryItems: number;
    libraryJobId: string | null;
  };
  /** Things deliberately left alone, so the caller can say so rather than imply success. */
  skipped: string[];
}

/** External id providers a media item can be matched on, strongest first. */
const ID_PROVIDERS = ['imdb', 'tmdb', 'tvdb'] as const;

@Injectable()
export class DiscoveryRemovalService {
  private readonly logger = new Logger(DiscoveryRemovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mediaBulk: MediaBulkService,
  ) {}

  /**
   * What each scope would touch, without touching any of it.
   *
   * The UI shows this before asking for confirmation. "Delete 24 episodes"
   * is a decision somebody can make; "Delete" on its own is not.
   */
  async plan(id: string): Promise<RemovalPlan> {
    const media = await this.prisma.discoveredMedia.findUnique({
      where: { id },
      include: { _count: { select: { evaluations: true, releaseDates: true } } },
    });
    if (!media) throw new NotFoundException(`Unknown discovered title: ${id}`);

    const rules = await this.prisma.rssRule.findMany({
      where: { generatedByDiscovery: true, discoveredMediaId: media.id },
      select: { id: true, name: true, userModifiedAt: true },
    });

    const watchlistItem = media.watchlistItemId
      ? await this.prisma.mediaAcquisitionWatchlistItem.findUnique({
          where: { id: media.watchlistItemId },
          select: { id: true, title: true, status: true },
        })
      : null;

    const { items, unmatchedReason } = await this.libraryItems(media.externalIds);

    return {
      id: media.id,
      title: media.title,
      year: media.year,
      mediaType: media.mediaType,
      catalog: {
        evaluations: media._count.evaluations,
        releaseDates: media._count.releaseDates,
      },
      monitoring: {
        rule: rules.find((r) => !r.userModifiedAt) ?? null,
        userModifiedRule: rules.find((r) => r.userModifiedAt) ?? null,
        watchlistItem,
      },
      library: { items, unmatchedReason },
    };
  }

  /**
   * Media items that provably belong to this title.
   *
   * Only an external id counts. `MediaExternalId` is indexed on
   * `(provider, externalId)`, which is both the fast lookup and the honest one —
   * a match here means the same work, not a similar name.
   */
  private async libraryItems(
    externalIds: unknown,
  ): Promise<{ items: { id: string; title: string; path: string }[]; unmatchedReason: 'no_external_ids' | null }> {
    const ids = (externalIds ?? {}) as Record<string, unknown>;
    const pairs = ID_PROVIDERS.flatMap((provider) => {
      const value = ids[provider];
      return typeof value === 'string' && value.trim() ? [{ provider, externalId: value.trim() }] : [];
    });
    if (!pairs.length) return { items: [], unmatchedReason: 'no_external_ids' };

    const links = await this.prisma.mediaExternalId.findMany({
      where: { OR: pairs },
      select: { itemId: true },
    });
    if (!links.length) return { items: [], unmatchedReason: null };

    const items = await this.prisma.mediaItem.findMany({
      where: { id: { in: [...new Set(links.map((l) => l.itemId))] } },
      select: { id: true, title: true, path: true },
      orderBy: { path: 'asc' },
    });
    return { items, unmatchedReason: null };
  }

  /**
   * Perform the removal.
   *
   * Ordered least-recoverable-last: the catalogue row and the rule are cheap to
   * recreate, the files are not. If the library step throws, everything before
   * it has still happened and is reported — the opposite order would delete
   * 40 GB and then fail to tidy a row.
   */
  async remove(
    id: string,
    req: RemovalRequest,
    userId?: string,
    ctx: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<RemovalResult> {
    const plan = await this.plan(id);
    const scope = req.scope;
    const skipped: string[] = [];
    const removed: RemovalResult['removed'] = {
      catalogRow: false,
      rule: false,
      watchlistArchived: false,
      libraryItems: 0,
      libraryJobId: null,
    };

    /*
     * Audited BEFORE anything is destroyed, and with the plan attached.
     *
     * A removal that half-completed and then threw must still leave a record of
     * what was asked for and by whom — recorded afterwards, a crash mid-delete
     * would take the only account of it with it.
     */
    await this.audit.record({
      userId,
      ...ctx,
      action: 'media_discovery.item.removed',
      objectType: 'discovered_media',
      objectId: id,
      metadata: {
        title: plan.title,
        year: plan.year,
        scope,
        torrentAction: scope === 'library' ? (req.torrentAction ?? 'keep') : undefined,
        wouldRemove: {
          rule: plan.monitoring.rule?.name ?? null,
          watchlistItem: plan.monitoring.watchlistItem?.id ?? null,
          libraryItems: plan.library.items.length,
        },
      },
    });

    if (scope === 'monitoring' || scope === 'library') {
      if (plan.monitoring.rule) {
        await this.prisma.rssRule.delete({ where: { id: plan.monitoring.rule.id } });
        removed.rule = true;
      }
      if (plan.monitoring.userModifiedRule) {
        skipped.push(`rule "${plan.monitoring.userModifiedRule.name}" was edited by hand and was left in place`);
      }
      if (plan.monitoring.watchlistItem) {
        /*
         * Archived, not deleted. The watchlist is a record of intent that other
         * things reference — acquisition history, decisions already made — and
         * deleting the row would orphan them to save one row.
         */
        await this.prisma.mediaAcquisitionWatchlistItem.update({
          where: { id: plan.monitoring.watchlistItem.id },
          data: { status: 'archived' },
        });
        removed.watchlistArchived = true;
      }
    }

    if (scope === 'library') {
      if (plan.library.unmatchedReason === 'no_external_ids') {
        skipped.push(
          'library media was not touched: this title carries no external id, and matching on title and year is not proof enough to delete by',
        );
      } else if (plan.library.items.length) {
        const result = await this.mediaBulk.deleteFiles(
          plan.library.items.map((i) => i.id),
          { userId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
          { torrentAction: req.torrentAction ?? 'keep' },
        );
        removed.libraryItems = plan.library.items.length;
        removed.libraryJobId = result.jobId ?? null;
      }
    }

    /*
     * The catalogue row goes last, and takes a suppression with it.
     *
     * Without the suppression the next provider sync re-creates the row within
     * six hours under the same dedupe key, and the removal looks like it never
     * happened.
     */
    await this.suppress(id, 'manual', userId);
    removed.catalogRow = true;

    return { ...plan, scope, removed, skipped };
  }

  /**
   * Drop the catalogue row and record that its identity must not return.
   *
   * Shared with automatic retraction, which passes `retracted` — the two causes
   * are stored apart because only a person's deletion should outlive a template
   * being edited back to something that matches again.
   */
  async suppress(id: string, reason: 'manual' | 'retracted' | 'graduated', userId?: string): Promise<void> {
    const media = await this.prisma.discoveredMedia.findUnique({
      where: { id },
      select: { id: true, dedupeKey: true, title: true, mediaType: true },
    });
    if (!media) return;

    await this.prisma.discoverySuppression.upsert({
      where: { dedupeKey: media.dedupeKey },
      create: {
        dedupeKey: media.dedupeKey,
        title: media.title,
        mediaType: media.mediaType,
        reason,
        suppressedBy: userId ?? null,
      },
      // A person's deletion outranks an automatic retraction, and is not
      // downgraded by a later sweep reaching the same conclusion.
      update: reason === 'manual' ? { reason, suppressedBy: userId ?? null } : {},
    });

    // Evaluations and release dates cascade from the row.
    await this.prisma.discoveredMedia.delete({ where: { id: media.id } });
  }

  /**
   * Remove several titles at one scope.
   *
   * Sequential, not parallel: at `library` scope each removal queues a file
   * deletion job, and firing forty of those at a NAS at once is how a bulk action
   * becomes an outage. The wall-clock cost is a background job's; the caller gets
   * a per-title result either way.
   *
   * **One failure does not abandon the rest.** A bulk action that stops halfway
   * leaves the operator with no idea which half happened, so every title is
   * attempted and reported individually.
   */
  async removeMany(
    ids: string[],
    req: RemovalRequest,
    userId?: string,
    ctx: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<{
    removed: Array<{ id: string; title: string }>;
    failed: Array<{ id: string; reason: string }>;
    skipped: string[];
    libraryItems: number;
  }> {
    const removed: Array<{ id: string; title: string }> = [];
    const failed: Array<{ id: string; reason: string }> = [];
    const skipped: string[] = [];
    let libraryItems = 0;

    for (const id of ids) {
      try {
        const result = await this.remove(id, req, userId, ctx);
        removed.push({ id, title: result.title });
        libraryItems += result.removed.libraryItems;
        skipped.push(...result.skipped.map((s) => `${result.title}: ${s}`));
      } catch (err) {
        failed.push({ id, reason: (err as Error).message });
        this.logger.warn(`Bulk removal failed for ${id}: ${(err as Error).message}`);
      }
    }

    return { removed, failed, skipped, libraryItems };
  }

  /** Let a suppressed title be discovered again on the next sync. */
  async unsuppress(dedupeKey: string, userId?: string): Promise<{ dedupeKey: string }> {
    const existing = await this.prisma.discoverySuppression.findUnique({ where: { dedupeKey } });
    if (!existing) throw new NotFoundException(`Not suppressed: ${dedupeKey}`);
    await this.prisma.discoverySuppression.delete({ where: { dedupeKey } });
    await this.audit.record({
      userId,
      action: 'media_discovery.suppression.cleared',
      objectType: 'discovery_suppression',
      objectId: dedupeKey,
      metadata: { title: existing.title },
    });
    return { dedupeKey };
  }
}
