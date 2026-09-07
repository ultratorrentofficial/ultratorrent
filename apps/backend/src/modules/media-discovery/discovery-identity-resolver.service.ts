import { Injectable, Logger } from '@nestjs/common';
import { canonicalizeTitle, sameCanonicalTitle } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * Does this discovered title already exist in UltraTorrent?
 *
 * Every writer in the auto-monitor path used to answer this for itself, and each
 * answered it differently: the watchlist compared a raw lowercased title against
 * a normalized column, the rule generator compared display names, and the merge
 * keyed on a normalized title that still had the year inside it. So "The
 * Terminal List" and "The Terminal List (2022)" were three different works
 * depending on which writer you asked, and both got monitored.
 *
 * This is the one answer. It runs BEFORE anything is created.
 *
 * **External ids are proof; titles are a hint.** That rule already governs the
 * provider merge (`discovery-identity.ts`) and it governs this too — an id match
 * ends the search, a title match only ever fills the gap where a hand-added
 * entry carries no ids at all, which is the common case and the one that broke.
 */

/** Strongest first. Matches `ID_PRIORITY` in the provider merge. */
const ID_PRIORITY = ['imdb', 'tmdb', 'tvdb', 'tvmaze'] as const;

export type ExistingState =
  /** Nothing here represents this work. Only this may create a new monitored show. */
  | 'none'
  /** A watchlist entry and a rule both exist. */
  | 'already_monitored'
  /** Partly set up — a watchlist entry with no rule, or a rule with no entry. */
  | 'monitoring_incomplete'
  /** Present in the library, but nothing is watching for more of it. */
  | 'exists_not_monitored';

export type MatchedBy = 'external_id' | 'canonical_title' | 'library_external_id' | null;

export interface ResolvedIdentity {
  state: ExistingState;
  matchedBy: MatchedBy;
  /** Which id namespace proved it, when an id did. */
  matchedIdNamespace: string | null;
  watchlistItem: { id: string; status: string; rssRuleId: string | null; title: string } | null;
  rssRule: { id: string; name: string; generatedByDiscovery: boolean; userModifiedAt: Date | null } | null;
  /** Library media provably this work. Empty is not proof of absence. */
  libraryItemIds: string[];
  /** Human-readable, for the inbox card and the audit row. */
  detail: string;
}

export interface ResolvableMedia {
  id?: string;
  mediaType: string;
  title: string;
  year: number | null;
  externalIds: Record<string, string | undefined> | unknown;
}

@Injectable()
export class DiscoveryIdentityResolverService {
  private readonly logger = new Logger(DiscoveryIdentityResolverService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** `movie` stays a movie; anything episodic is monitored as a whole series. */
  private watchlistType(mediaType: string): string {
    return mediaType === 'movie' ? 'movie' : 'series';
  }

  private ids(raw: unknown): Array<{ ns: string; value: string }> {
    const obj = (raw ?? {}) as Record<string, unknown>;
    return ID_PRIORITY.flatMap((ns) => {
      const v = obj[ns];
      return typeof v === 'string' && v.trim() ? [{ ns, value: v.trim() }] : [];
    });
  }

  /**
   * The forms a legacy `normalizedTitle` could have been stored in.
   *
   * `WatchlistItem.normalizedTitle` has always been `title.toLowerCase().trim()`
   * — the raw title, year suffix and punctuation included. Rather than rewrite
   * every historical row and risk a SQL backfill that disagrees with the
   * JavaScript canonicalizer, the probe asks for every encoding the same work
   * could be sitting under. It is an indexed equality lookup either way.
   */
  private legacyTitleVariants(title: string, year: number | null): string[] {
    const base = title.trim();
    const variants = new Set<string>([base.toLowerCase()]);
    if (year != null) {
      variants.add(`${base} (${year})`.toLowerCase());
      variants.add(`${base} [${year}]`.toLowerCase());
      variants.add(`${base}.${year}`.toLowerCase());
      variants.add(`${base} ${year}`.toLowerCase());
    }
    return [...variants];
  }

  /**
   * The most selective word in a title, for narrowing a candidate set.
   *
   * The longest token rather than the first: "The Terminal List" probed on `the`
   * would drag back every title beginning with an article, and the point of the
   * probe is to make the canonical comparison cheap. Short tokens are skipped
   * for the same reason.
   */
  private probeToken(normalizedTitle: string): string {
    const tokens = normalizedTitle.split(' ').filter(Boolean);
    if (!tokens.length) return '';
    return tokens.reduce((best, t) => (t.length > best.length ? t : best), '');
  }

  async resolve(media: ResolvableMedia): Promise<ResolvedIdentity> {
    const canon = canonicalizeTitle(media.title, media.year);
    const type = this.watchlistType(media.mediaType);
    const ids = this.ids(media.externalIds);

    let matchedBy: MatchedBy = null;
    let matchedIdNamespace: string | null = null;

    // --- 1. the watchlist, by external id --------------------------------
    let watchlistItem = null as ResolvedIdentity['watchlistItem'];
    for (const { ns, value } of ids) {
      const hit = await this.prisma.mediaAcquisitionWatchlistItem.findFirst({
        where: { type, externalIds: { path: [ns], equals: value } },
        select: { id: true, status: true, rssRuleId: true, title: true },
      });
      if (hit) {
        watchlistItem = hit;
        matchedBy = 'external_id';
        matchedIdNamespace = ns;
        break;
      }
    }

    /*
     * --- 2. the watchlist, by canonical title ---------------------------
     *
     * Only reached when no id matched, which is the normal case for an entry
     * somebody added by hand — those carry no ids at all, and that is exactly
     * the entry the old code walked straight past.
     */
    if (!watchlistItem && canon.normalizedTitle) {
      /*
       * Two nets, because the column holds whatever a title looked like when it
       * was saved. The exact variants cover the common encodings with an indexed
       * equality lookup; the token probe catches the rest — a dotted release
       * name, an odd separator — at the cost of a bounded scan. Both are only
       * candidate sets; the canonical comparison below is the decision.
       */
      const probe = this.probeToken(canon.normalizedTitle);
      const candidates = await this.prisma.mediaAcquisitionWatchlistItem.findMany({
        where: {
          type,
          OR: [
            { normalizedTitle: { in: this.legacyTitleVariants(canon.title, canon.year) } },
            ...(probe ? [{ normalizedTitle: { contains: probe, mode: 'insensitive' as const } }] : []),
          ],
        },
        select: { id: true, status: true, rssRuleId: true, title: true, year: true },
        take: 200,
      });
      // Verified canonically rather than trusted: the query is a cheap net, this
      // is the actual test, and it is the one that knows about years.
      const hit = candidates.find((c) =>
        sameCanonicalTitle(canon, canonicalizeTitle(c.title, c.year)),
      );
      if (hit) {
        watchlistItem = { id: hit.id, status: hit.status, rssRuleId: hit.rssRuleId, title: hit.title };
        matchedBy = 'canonical_title';
      }
    }

    // --- 3. an RSS rule for this work ------------------------------------
    const rssRule = await this.findRule(media, canon, watchlistItem?.rssRuleId ?? null);
    if (!matchedBy && rssRule) matchedBy = 'canonical_title';

    // --- 4. library media, by external id only ---------------------------
    const libraryItemIds = await this.libraryItems(ids);
    if (!matchedBy && libraryItemIds.length) {
      matchedBy = 'library_external_id';
      matchedIdNamespace = ids[0]?.ns ?? null;
    }

    const state = this.stateOf(watchlistItem, rssRule, libraryItemIds);
    return {
      state,
      matchedBy,
      matchedIdNamespace,
      watchlistItem,
      rssRule,
      libraryItemIds,
      detail: this.describe(state, matchedBy, matchedIdNamespace, watchlistItem, rssRule, libraryItemIds),
    };
  }

  /**
   * A rule that already represents this work.
   *
   * Three ways, strongest first: the rule the watchlist entry already points at,
   * a rule discovery generated for this exact title, and finally a rule whose
   * NAME canonicalises to the same work. That last one is what was missing — the
   * old check compared display names exactly, so a hand-made "Tulsa King" never
   * collided with a generated "Tulsa King (2022)" and a second rule was created.
   */
  private async findRule(
    media: ResolvableMedia,
    canon: { normalizedTitle: string; year: number | null },
    linkedRuleId: string | null,
  ): Promise<ResolvedIdentity['rssRule']> {
    const select = { id: true, name: true, generatedByDiscovery: true, userModifiedAt: true } as const;

    if (linkedRuleId) {
      const linked = await this.prisma.rssRule.findUnique({ where: { id: linkedRuleId }, select });
      if (linked) return linked;
    }

    if (media.id) {
      const mine = await this.prisma.rssRule.findFirst({
        where: { generatedByDiscovery: true, discoveredMediaId: media.id },
        select,
      });
      if (mine) return mine;
    }

    /*
     * Canonical name comparison, done in memory.
     *
     * There is no normalized column on `RssRule` to query, and inventing one
     * would mean a backfill of user-authored names. The candidate set is narrowed
     * by a case-insensitive prefix on the title without its year, which every
     * form of the name shares, and each candidate is then canonicalised properly.
     */
    const prefix = this.probeToken(canon.normalizedTitle);
    if (!prefix) return null;
    const candidates = await this.prisma.rssRule.findMany({
      where: { name: { contains: prefix, mode: 'insensitive' } },
      select,
      take: 200,
    });
    return (
      candidates.find((c) => sameCanonicalTitle(canon, canonicalizeTitle(c.name))) ?? null
    );
  }

  /**
   * Library media, matched by external id and nothing else.
   *
   * The same rule `DiscoveryRemovalService` uses, for the same reason: title and
   * year group a listing, they do not prove two files are the same work, and
   * being wrong here means claiming somebody already owns a show they do not.
   */
  private async libraryItems(ids: Array<{ ns: string; value: string }>): Promise<string[]> {
    if (!ids.length) return [];
    const links = await this.prisma.mediaExternalId.findMany({
      where: { OR: ids.map(({ ns, value }) => ({ provider: ns, externalId: value })) },
      select: { itemId: true },
      take: 500,
    });
    return [...new Set(links.map((l) => l.itemId))];
  }

  private stateOf(
    watchlistItem: ResolvedIdentity['watchlistItem'],
    rssRule: ResolvedIdentity['rssRule'],
    libraryItemIds: string[],
  ): ExistingState {
    if (watchlistItem && rssRule) return 'already_monitored';
    if (watchlistItem || rssRule) return 'monitoring_incomplete';
    if (libraryItemIds.length) return 'exists_not_monitored';
    return 'none';
  }

  private describe(
    state: ExistingState,
    matchedBy: MatchedBy,
    ns: string | null,
    watchlistItem: ResolvedIdentity['watchlistItem'],
    rssRule: ResolvedIdentity['rssRule'],
    libraryItemIds: string[],
  ): string {
    const how =
      matchedBy === 'external_id' || matchedBy === 'library_external_id'
        ? `matched by ${ns?.toUpperCase() ?? 'external'} id`
        : matchedBy === 'canonical_title'
          ? 'matched by title and year'
          : '';
    switch (state) {
      case 'already_monitored':
        return `Already monitored (${how}) — watchlist entry and rule "${rssRule?.name}" both exist`;
      case 'monitoring_incomplete':
        return watchlistItem
          ? `On the watchlist but with no acquisition rule (${how})`
          : `An acquisition rule "${rssRule?.name}" exists with no watchlist entry (${how})`;
      case 'exists_not_monitored':
        return `${libraryItemIds.length} item(s) already in your library (${how}), but nothing is monitoring for more`;
      default:
        return 'Not present in UltraTorrent';
    }
  }
}
