import { Injectable, Logger } from '@nestjs/common';
import { canonicalizeTitle, sameCanonicalTitle } from '@ultratorrent/shared';
import type { AcquisitionRuleTemplate, AcquisitionRuleTemplateCandidate, Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AcquisitionTemplateService } from './acquisition-template.service';

/**
 * Generating the title-specific RSS rule an auto-monitored discovery needs.
 *
 * The rule's job is to CARRY THE PREFERENCES. Monitoring itself is done by the
 * existing sweeps: `AcquisitionMatchPreferenceService.resolveCandidates()` reads
 * a watchlist item's linked rule first, so a generated rule slots into the top
 * rung of a resolution order that already existed, with no change to it.
 *
 * Three constraints shape everything here:
 *
 *  - **`RssRule.feedId` is required**, so a rule cannot exist without a feed.
 *    That is why a discovery template names one and cannot be enabled without it.
 *  - **Rule names are unique, case-insensitively.** A generated name can collide
 *    with a rule somebody made by hand, and taking that over would be discovery
 *    quietly seizing an operator's configuration.
 *  - **A generated rule a person has edited is theirs.** `userModifiedAt` is the
 *    line; past it, re-application leaves the rule alone.
 */

export interface RuleGenerationInput {
  media: { id: string; title: string; year: number | null; mediaType: string; externalIds: Record<string, string> };
  template: { id: string; rssFeedId: string | null; storageProfileId: string | null };
  acquisition?: (AcquisitionRuleTemplate & { candidates: AcquisitionRuleTemplateCandidate[] }) | null;
  /** Rendered staging directory, when the discovery template asked for one. */
  savePath?: string | null;
}

export type RuleOutcome = 'created' | 'reused' | 'skipped';

export interface RuleGenerationResult {
  ruleId: string | null;
  outcome: RuleOutcome;
  reason?: string;
}

@Injectable()
export class DiscoveryRuleService {
  private readonly logger = new Logger(DiscoveryRuleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acquisitionTemplates: AcquisitionTemplateService,
  ) {}

  /**
   * The rule name for a title.
   *
   * The year is part of it because two works genuinely share titles — the whole
   * reason the identity gate exists — and two rules called "The Odyssey" would be
   * indistinguishable in the rules list.
   */
  ruleName(media: { title: string; year: number | null }): string {
    return media.year ? `${media.title} (${media.year})` : media.title;
  }

  async generate(input: RuleGenerationInput, userId?: string): Promise<RuleGenerationResult> {
    const { media, template } = input;
    if (!template.rssFeedId) {
      return { ruleId: null, outcome: 'skipped', reason: 'The discovery template has no RSS feed' };
    }

    // Already generated for this title? Reuse it rather than making a second.
    const mine = await this.prisma.rssRule.findFirst({
      where: { generatedByDiscovery: true, discoveredMediaId: media.id },
      select: { id: true },
    });
    if (mine) return { ruleId: mine.id, outcome: 'reused' };

    const name = this.ruleName(media);

    /*
     * A collision is decided on canonical IDENTITY, not on display text.
     *
     * This compared names exactly, so a hand-made rule called "Tulsa King" did
     * not collide with a generated "Tulsa King (2022)" — the protection below
     * never fired and a second rule was created for a show somebody was already
     * managing. The narrowing query is a cheap net; the canonical comparison is
     * the actual test.
     */
    const canon = canonicalizeTitle(media.title, media.year);
    const tokens = canon.normalizedTitle.split(' ').filter(Boolean);
    const probe = tokens.reduce((best, t) => (t.length > best.length ? t : best), '');
    const nearby = probe
      ? await this.prisma.rssRule.findMany({
          where: { name: { contains: probe, mode: 'insensitive' } },
          select: { id: true, generatedByDiscovery: true, name: true },
          take: 200,
        })
      : [];
    const clash = nearby.find((r) => sameCanonicalTitle(canon, canonicalizeTitle(r.name))) ?? null;
    if (clash) {
      /*
       * A name collision is never resolved by taking the rule over.
       *
       * If a person already made a rule for this show, adopting it would replace
       * their preferences with a template's and leave no trace that it happened.
       * The watchlist entry still links to it — which is the useful half — and
       * the discovery is reported so somebody can look.
       */
      return {
        ruleId: clash.id,
        outcome: 'skipped',
        reason: clash.generatedByDiscovery
          ? `A generated rule named "${clash.name}" already exists`
          : `A rule named "${clash.name}" already exists and was not created by discovery — left untouched`,
      };
    }

    const candidates = input.acquisition
      ? this.acquisitionTemplates.toRuleCandidates(input.acquisition, 'placeholder')
      : [];

    let created: { id: string };
    try {
      created = await this.prisma.rssRule.create({
      data: {
        feedId: template.rssFeedId,
        name,
        /*
         * `managed_intake` with a storage profile, never a savePath the template
         * spelled. The intake pipeline resolves the destination from the profile;
         * a generated rule that pointed straight at a folder would bypass the
         * staging-and-organise flow every hand-made rule now uses.
         */
        importMode: 'managed_intake',
        storageProfileId: template.storageProfileId,
        savePath: input.savePath ?? null,
        autoDownload: true,
        isEnabled: true,
        mediaType: media.mediaType === 'movie' ? 'movie' : 'tv',
        generatedByDiscovery: true,
        discoveryTemplateId: template.id,
        acquisitionTemplateId: input.acquisition?.id ?? null,
        acquisitionTemplateVersion: input.acquisition?.version ?? null,
        discoveredMediaId: media.id,
        matchCandidates: candidates.length
          ? { create: candidates.map(({ rssRuleId: _drop, ...c }) => c) }
          : undefined,
      },
        select: { id: true },
      });
    } catch (err) {
      /*
       * Lost a race, rather than failed.
       *
       * A partial unique index allows at most one generated rule per discovered
       * title, so two concurrent passes — TMDB and TVmaze reaching the same show,
       * or a manual evaluate overlapping the hourly tick — end with one insert
       * and one `P2002`. That is the constraint doing its job; the loser resolves
       * to the row the winner wrote instead of reporting a failure nobody can act
       * on. The resolver is the fast path, this is the guarantee.
       */
      if ((err as { code?: string }).code === 'P2002') {
        const winner = await this.prisma.rssRule.findFirst({
          where: { generatedByDiscovery: true, discoveredMediaId: media.id },
          select: { id: true },
        });
        if (winner) {
          this.logger.log(`Rule for "${name}" was created concurrently — reusing ${winner.id}`);
          return { ruleId: winner.id, outcome: 'reused' };
        }
      }
      throw err;
    }

    await this.audit.record({
      userId,
      action: 'media_discovery.rule.generated',
      objectType: 'rss_rule',
      objectId: created.id,
      metadata: {
        name,
        discoveredMediaId: media.id,
        discoveryTemplateId: template.id,
        acquisitionTemplateId: input.acquisition?.id ?? null,
        candidates: candidates.length,
      },
    });

    return { ruleId: created.id, outcome: 'created' };
  }

  /**
   * Rules a template change could safely re-apply to.
   *
   * Generated, from this template, and **never edited by a person**. The
   * `userModifiedAt` filter is the whole point: past that line the operator's
   * edit is the more specific intent, and reverting it on the next sync would be
   * the worst kind of automation — silent, and correct-looking.
   */
  reappliable(acquisitionTemplateId: string) {
    return this.prisma.rssRule.findMany({
      where: {
        generatedByDiscovery: true,
        acquisitionTemplateId,
        userModifiedAt: null,
      },
      select: { id: true, name: true, acquisitionTemplateVersion: true },
    });
  }

  /** Rules from this template that a person has taken over. Reported, never touched. */
  userOwned(acquisitionTemplateId: string) {
    return this.prisma.rssRule.findMany({
      where: {
        generatedByDiscovery: true,
        acquisitionTemplateId,
        userModifiedAt: { not: null },
      },
      select: { id: true, name: true, userModifiedAt: true },
    });
  }
}

/** Prisma's nested-create shape rejects the FK the mapper fills in. */
export type CandidateCreate = Omit<Prisma.RssRuleMatchCandidateUncheckedCreateInput, 'rssRuleId'>;
