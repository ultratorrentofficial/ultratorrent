import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AcquisitionWatchlistService } from '../media-acquisition/watchlist.service';
import { ID_PRIORITY, type IdNamespace } from './discovery-identity';

/**
 * Turning an auto-monitored discovery into a watchlist entry.
 *
 * `MediaAcquisitionWatchlistItem` remains authoritative and
 * `AcquisitionWatchlistService` remains the only writer — this goes through
 * `create`/`update` rather than the table, so the audit row, the realtime
 * broadcast and the series-title collapsing all still happen. Discovery is a new
 * reason to add something to the watchlist, not a second watchlist.
 *
 * The hard part is not creating; it is **not** creating. A title discovered every
 * six hours for months must produce exactly one entry, and must never quietly
 * undo something a person did to it.
 */

export type LinkOutcome = 'created' | 'updated' | 'unchanged';

export interface LinkResult {
  watchlistItemId: string;
  outcome: LinkOutcome;
  /** Set when the outcome deserves an explanation in the decision trace. */
  note?: string;
}

export interface LinkableMedia {
  id: string;
  mediaType: string;
  title: string;
  year: number | null;
  externalIds: Record<string, string>;
}

export interface LinkTarget {
  /** Library the storage profile files this media type into, when it has one. */
  targetLibraryId?: string | null;
  /** Generated rule, when Phase 13 has produced one. */
  rssRuleId?: string | null;
}

/**
 * Watchlist statuses that mean a person has already decided about this title.
 *
 * Re-activating one would be discovery overruling the operator: `paused` and
 * `archived` are things somebody chose, and a background sweep that undid them
 * would be indistinguishable from a bug.
 */
const OPERATOR_DECIDED = new Set(['paused', 'archived', 'completed']);

@Injectable()
export class DiscoveryWatchlistService {
  private readonly logger = new Logger(DiscoveryWatchlistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly watchlist: AcquisitionWatchlistService,
  ) {}

  /** `movie` stays a movie; anything episodic is monitored as a whole series. */
  watchlistType(mediaType: string): string {
    return mediaType === 'movie' ? 'movie' : 'series';
  }

  async linkOrCreate(media: LinkableMedia, target: LinkTarget = {}, userId?: string): Promise<LinkResult> {
    const existing = await this.findExisting(media);

    if (!existing) {
      const item = await this.watchlist.create(
        {
          type: this.watchlistType(media.mediaType),
          title: media.title,
          year: media.year ?? undefined,
          externalIds: media.externalIds,
          targetLibraryId: target.targetLibraryId ?? undefined,
          rssRuleId: target.rssRuleId ?? undefined,
          settings: { discoveredMediaId: media.id, createdByDiscovery: true },
        },
        userId,
      );
      return { watchlistItemId: item.id, outcome: 'created' };
    }

    /*
     * An entry a person has paused, archived or completed is left ALONE beyond
     * gaining any ids it was missing. Re-activating it would be a background
     * sweep overruling a deliberate decision, and from the operator's side that
     * is indistinguishable from a bug.
     */
    const decided = OPERATOR_DECIDED.has(existing.status);

    const newIds = this.missingIds(existing.externalIds, media.externalIds);
    const wantsRule = Boolean(target.rssRuleId) && !existing.rssRuleId;

    if (!newIds && !wantsRule) {
      return {
        watchlistItemId: existing.id,
        outcome: 'unchanged',
        ...(decided ? { note: `Already on the watchlist and ${existing.status} — left as it is` } : {}),
      };
    }

    /*
     * Only the two things discovery may contribute are sent.
     *
     * `update` copies exactly the fields it is given, so omitting status,
     * priority, profile and target library is what protects an operator's
     * customisation. Sending them "unchanged" would still overwrite anything
     * edited between this read and the write.
     */
    await this.watchlist.update(
      existing.id,
      {
        ...(newIds ? { externalIds: media.externalIds } : {}),
        // A rule is only ever ATTACHED, never replaced: a watchlist item already
        // pointing at a rule is pointing at one somebody chose.
        ...(wantsRule ? { rssRuleId: target.rssRuleId } : {}),
      },
      userId,
    );

    return {
      watchlistItemId: existing.id,
      outcome: 'updated',
      ...(decided ? { note: `Already on the watchlist and ${existing.status} — only its ids were updated` } : {}),
    };
  }

  /**
   * The watchlist entry this discovery is already represented by, if any.
   *
   * External ids first, because they are proof. The title fallback exists for the
   * common case of an entry a person added by hand, which carries no ids at all.
   */
  private async findExisting(media: LinkableMedia) {
    const type = this.watchlistType(media.mediaType);

    const idFilters: Prisma.MediaAcquisitionWatchlistItemWhereInput[] = ID_PRIORITY.filter(
      (ns) => media.externalIds[ns],
    ).map((ns) => ({ externalIds: { path: [ns], equals: media.externalIds[ns] } }));

    if (idFilters.length) {
      const byId = await this.prisma.mediaAcquisitionWatchlistItem.findFirst({
        where: { type, OR: idFilters },
        select: { id: true, status: true, externalIds: true, rssRuleId: true },
      });
      if (byId) return byId;
    }

    /*
     * The two tables normalize titles DIFFERENTLY.
     *
     * The watchlist stores `title.toLowerCase().trim()`; discovery stores the
     * punctuation-stripped `normalizeTitle()`. Comparing the two columns directly
     * would miss every title containing punctuation — "SILA: The Life Within
     * Everything" is `sila: the …` on one side and `sila the …` on the other. So
     * the discovery title is normalized the WATCHLIST's way for this comparison.
     */
    const normalized = media.title.toLowerCase().trim();
    return this.prisma.mediaAcquisitionWatchlistItem.findFirst({
      where: {
        type,
        normalizedTitle: normalized,
        // A null year on either side is missing information, not a mismatch: a
        // hand-added entry frequently has none.
        ...(media.year != null ? { OR: [{ year: media.year }, { year: null }] } : {}),
      },
      select: { id: true, status: true, externalIds: true, rssRuleId: true },
    });
  }

  /** True when the discovery knows an id the watchlist entry does not. */
  private missingIds(stored: unknown, incoming: Record<string, string>): boolean {
    const have = (stored ?? {}) as Record<string, string>;
    return ID_PRIORITY.some((ns: IdNamespace) => incoming[ns] && !have[ns]);
  }
}
