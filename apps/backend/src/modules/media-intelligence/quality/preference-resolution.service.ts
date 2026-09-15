import { Injectable, Logger } from '@nestjs/common';
import type { NormalizedPreferenceLadder } from '@ultratorrent/shared';

import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AcquisitionMatchPreferenceService } from '../../media-acquisition/acquisition-match-preference.service';
import { emptyLadder, ladderAppliesTo, normalizeLadder, type LadderMediaKind } from './preference-ladder';

/**
 * Which acquisition preferences govern a piece of owned media.
 *
 * This service answers *whose ladder applies*; it never decides what the
 * ladder contains. `AcquisitionMatchPreferenceService.resolveCandidates()`
 * owns the cascade — global ordered ladder first, then the show's own RSS rule
 * candidates, then per-media-type profiles — and re-implementing any part of
 * that here would let Media Intelligence judge media against preferences
 * Acquisition itself would not have used.
 *
 * **Performance note.** In this codebase the primary ladder is GLOBAL, so the
 * same rungs govern almost every title. A reconciliation sweep therefore
 * resolves it once via {@link globalLadder} and reuses it for thousands of
 * entities; the per-entity path exists for the minority case where the global
 * ladder is empty and a show's own rule or profile takes over.
 */
@Injectable()
export class QualityPreferenceResolver {
  private readonly logger = new Logger(QualityPreferenceResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly preferences: AcquisitionMatchPreferenceService,
  ) {}

  /**
   * The global ladder, which governs unless it is empty.
   *
   * Resolved once per sweep by the caller. Returns an empty ladder rather than
   * throwing when nothing is configured — "no preferences" is a legitimate
   * state that must surface as `unknown`, never as a failure.
   */
  async globalLadder(kind: LadderMediaKind = 'tv'): Promise<NormalizedPreferenceLadder> {
    try {
      const rungs = await this.preferences.defaults();
      // Scoped by media kind, exactly as acquisition scopes its own. A ladder
      // of episode matchers does not govern a film; claiming otherwise
      // manufactures a size failure on every feature-length title.
      if (!ladderAppliesTo(rungs, kind)) return emptyLadder();
      return normalizeLadder(rungs, 'global_ladder', 'Global Auto-Download Preferences');
    } catch (err) {
      this.logger.warn(`Could not read the global ladder: ${(err as Error).message}`);
      return emptyLadder();
    }
  }

  /**
   * The effective ladder for one entity.
   *
   * `globalFallback` is the already-resolved global ladder; when it has rungs
   * it IS the answer, exactly as acquisition would decide, and no per-entity
   * query is issued at all. Only an empty global ladder makes this reach for
   * the watchlist item behind the media.
   */
  async ladderFor(
    entity: { showId?: string | null; imdbId?: string | null; kind?: LadderMediaKind },
    globalFallback: NormalizedPreferenceLadder,
  ): Promise<NormalizedPreferenceLadder> {
    if (globalFallback.rungs.length) return globalFallback;

    const item = await this.watchlistItemFor(entity);
    if (!item) return emptyLadder();

    try {
      const rungs = await this.preferences.resolveCandidates(item as never);
      if (!rungs.length) return emptyLadder();
      if (!ladderAppliesTo(rungs, entity.kind ?? 'tv')) return emptyLadder();
      // With the global ladder empty, whatever came back is the show's own rule
      // or a profile tier. Name it from the item so the UI can say which.
      const source = item.rssRuleId ? 'linked_rule' : 'acquisition_profile';
      const label = await this.labelFor(item);
      return normalizeLadder(rungs, source, label);
    } catch (err) {
      this.logger.warn(`Could not resolve preferences for "${item.title}": ${(err as Error).message}`);
      return emptyLadder();
    }
  }

  /**
   * The watchlist item governing this media, if any.
   *
   * Two joins, in the order the rest of the codebase uses them: the explicit
   * `libraryShowId` binding first, then the external id. A title match is
   * deliberately NOT attempted — acquisition does that with canonical keys and
   * alias lists, and a looser guess here could attach the wrong show's policy
   * to a title, which is worse than reporting no preferences at all.
   */
  private async watchlistItemFor(entity: { showId?: string | null; imdbId?: string | null }) {
    if (entity.showId) {
      const byShow = await this.prisma.mediaAcquisitionWatchlistItem
        .findFirst({ where: { libraryShowId: entity.showId } })
        .catch(() => null);
      if (byShow) return byShow;
    }
    if (entity.imdbId) {
      return this.prisma.mediaAcquisitionWatchlistItem
        .findFirst({ where: { externalIds: { path: ['imdb'], equals: entity.imdbId } } })
        .catch(() => null);
    }
    return null;
  }

  /** A name the operator will recognise for the governing policy. */
  private async labelFor(item: { rssRuleId: string | null; title: string }): Promise<string | null> {
    if (!item.rssRuleId) return 'Auto-Download Profiles';
    const rule = await this.prisma.rssRule
      .findUnique({ where: { id: item.rssRuleId }, select: { name: true } })
      .catch(() => null);
    return rule?.name ? `Rule: ${rule.name}` : `Rule for ${item.title}`;
  }
}
