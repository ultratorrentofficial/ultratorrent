import { Injectable, Logger } from '@nestjs/common';
import { canonicalizeTitle, sameCanonicalTitle } from '@ultratorrent/shared';
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
  /**
   * Settings blob stamped on a FRESHLY created item, overriding the default
   * discovery origin. Used by callers that are not Media Discovery (e.g. the
   * Add-Series workflow) so the item records its true provenance rather than
   * falsely claiming `createdByDiscovery`. Ignored when an item already exists.
   */
  createSettings?: Record<string, unknown>;
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
          settings: target.createSettings ?? { discoveredMediaId: media.id, createdByDiscovery: true },
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
     * The two tables normalize titles DIFFERENTLY, and neither used to drop a
     * presentation year.
     *
     * The watchlist stores `title.toLowerCase().trim()` — raw, punctuation and
     * `(2022)` included. Discovery stores a canonical, year-free normalization.
     * Comparing them directly missed both punctuation AND the year, which is how
     * a hand-added "The Terminal List" failed to match a discovered "The
     * Terminal List (2022)" and a second entry was created.
     *
     * So: query every legacy encoding the same work could be stored under — an
     * indexed equality lookup — then confirm canonically in memory, where years
     * are compared properly.
     */
    const canon = canonicalizeTitle(media.title, media.year);
    if (!canon.normalizedTitle) return null;

    const base = canon.title.trim();
    const variants = new Set<string>([base.toLowerCase()]);
    if (canon.year != null) {
      variants.add(`${base} (${canon.year})`.toLowerCase());
      variants.add(`${base} [${canon.year}]`.toLowerCase());
      variants.add(`${base} ${canon.year}`.toLowerCase());
      variants.add(`${base}.${canon.year}`.toLowerCase());
    }

    // The longest token, so a probe on "the" does not drag back the whole table.
    const probe = canon.normalizedTitle
      .split(' ')
      .filter(Boolean)
      .reduce((best, t) => (t.length > best.length ? t : best), '');
    const candidates = await this.prisma.mediaAcquisitionWatchlistItem.findMany({
      where: {
        type,
        OR: [
          { normalizedTitle: { in: [...variants] } },
          ...(probe ? [{ normalizedTitle: { contains: probe, mode: 'insensitive' as const } }] : []),
        ],
      },
      select: { id: true, status: true, externalIds: true, rssRuleId: true, title: true, year: true },
      take: 50,
    });
    const hit = candidates.find((c) => sameCanonicalTitle(canon, canonicalizeTitle(c.title, c.year)));
    return hit
      ? { id: hit.id, status: hit.status, externalIds: hit.externalIds, rssRuleId: hit.rssRuleId }
      : null;
  }

  /**
   * Read-only identity lookup: the watchlist entry this media is already
   * represented by, if any, WITHOUT creating one. Exposes {@link findExisting}
   * for callers that preview a provisioning decision before acting (the
   * Add-Series dry-run) — the same external-ids-first, canonical-title-fallback
   * resolution {@link linkOrCreate} uses, so a plan and the act it describes
   * agree on what already exists.
   */
  async resolveExisting(
    media: LinkableMedia,
  ): Promise<{ id: string; status: string; rssRuleId: string | null } | null> {
    const hit = await this.findExisting(media);
    return hit ? { id: hit.id, status: hit.status, rssRuleId: hit.rssRuleId ?? null } : null;
  }

  /** True when the discovery knows an id the watchlist entry does not. */
  private missingIds(stored: unknown, incoming: Record<string, string>): boolean {
    const have = (stored ?? {}) as Record<string, string>;
    return ID_PRIORITY.some((ns: IdNamespace) => incoming[ns] && !have[ns]);
  }
}
