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
   * The rule's name: the show's title, and nothing else.
   *
   * The title is CANONICAL, so a provider that wrote "Tulsa King (2022)" still
   * yields "Tulsa King" — the year is lifted out rather than carried through in
   * a different shape.
   *
   * This used to append the year, so that two works genuinely sharing a title
   * stayed distinguishable in the rules list. That trade is now the other way
   * round: a rule is read far more often than two same-titled works collide, and
   * the year made every rule name noisier for a case that is rare.
   *
   * The collision is still handled, just differently. Two works with one title
   * produce one rule name, the second is refused by the uniqueness guard, and
   * `generate()` reports it and links the watchlist entry to the existing rule
   * rather than silently taking it over. Nothing is lost quietly — it is
   * surfaced, which is what the clash path was built for.
   *
   * The name has never affected MATCHING: the show is identified by each
   * candidate's `pattern`, which carries the canonical title independently.
   */
  ruleName(media: { title: string; year: number | null }): string {
    return canonicalizeTitle(media.title, media.year).title;
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

    /*
     * The canonical title, WITHOUT the year, is what the matcher compares
     * against a release name — a release is named "Show.S01E01...", not
     * "Show (2026).S01E01...". `ruleName()` drops the year too, so the rule
     * reads as the show it follows rather than as a catalogue entry.
     */
    const subject = {
      title: canonicalizeTitle(media.title, media.year).title,
      mediaType: media.mediaType,
    };
    const candidates = input.acquisition
      ? this.acquisitionTemplates.toRuleCandidates(input.acquisition, 'placeholder', subject)
      : [];

    /*
     * A candidate with no pattern matches EVERY item in the feed that passes its
     * quality rules — `showTitleMatch` returns true for an empty pattern, which
     * is correct for a hand-made whole-feed rule and catastrophic for one
     * generated for a single show. This is the last gate before the insert, and
     * it exists because the consequence is not a rule that fails to work but a
     * rule that downloads everything.
     */
    const unbounded = candidates.filter((c) => !String(c.pattern ?? '').trim());
    if (unbounded.length) {
      return {
        ruleId: null,
        outcome: 'skipped',
        reason: `Refusing to create a rule whose match preferences carry no show title — it would match every item in the feed (${unbounded.length} of ${candidates.length} candidates)`,
      };
    }

    /*
     * Never create a rule that cannot match anything.
     *
     * `rss.module.ts` uses a rule's match candidates if it has any and its
     * include/exclude regex otherwise, and `legacyEvaluation()` returns
     * `matched: false` for a rule with neither — deliberately, so a filterless
     * rule cannot grab an entire feed. This generator sets no regex, so a rule
     * built without candidates would be enabled, `autoDownload: true`, and
     * permanently inert, with nothing indicating a fault.
     *
     * The evaluator already refuses to reach this point with an unready
     * template. This is the second lock, on the door that actually writes.
     */
    if (!candidates.some((c) => c.enabled)) {
      return {
        ruleId: null,
        outcome: 'skipped',
        reason:
          'No enabled match preferences: a rule built from this template would match nothing, so none was created',
      };
    }

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
