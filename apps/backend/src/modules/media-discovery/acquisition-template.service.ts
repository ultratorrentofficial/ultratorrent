import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AcquisitionRuleTemplateCandidate, Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { escapeRegex } from '../../common/escape-regex';

/**
 * HOW a discovered title should be acquired: an ordered ladder of release
 * preferences.
 *
 * A template is **not a second match engine**. Its candidates mirror
 * `RssRuleMatchCandidate` field for field, so generating a rule is a column copy
 * and the one matcher in `rss/match-engine.ts` remains the only thing that
 * decides whether a release qualifies. The mirror is the point; a parity test
 * fails if the two models drift.
 */

/** The match types `match-engine.ts` implements. */
export const MATCH_TYPES = [
  'exact_text',
  'contains_text',
  'regex',
  'wildcard',
  'smart_episode_match',
  'smart_movie_match',
  'fuzzy_match',
] as const;

/**
 * The quality keys the match engine actually reads.
 *
 * Checked strictly. `hdr` and `audio` are deliberately absent: the engine does
 * not consume them, so accepting them would give an operator a preference that
 * silently does nothing — the worst kind of setting, because it looks configured.
 * Dolby Vision and Atmos are expressed as `requiredTerms`, which the engine does
 * honour.
 */
export const QUALITY_KEYS = ['quality', 'source', 'codec', 'resolution', 'season', 'episode', 'year'] as const;
const SIZE_KEYS = ['minBytes', 'maxBytes'] as const;

export interface CandidateInput {
  priorityOrder?: number;
  name?: string;
  description?: string | null;
  enabled?: boolean;
  matchType?: string;
  pattern?: string | null;
  requiredTerms?: string[];
  excludedTerms?: string[];
  qualityRules?: Record<string, unknown>;
  sizeRules?: Record<string, unknown>;
  feedScope?: Record<string, unknown>;
}

export interface AcquisitionTemplateInput {
  name?: string;
  description?: string | null;
  mediaType?: string;
  enabled?: boolean;
  rssFeedId?: string | null;
  storageProfileId?: string | null;
  pathTemplate?: string | null;
  requiredTerms?: string[];
  excludedTerms?: string[];
  upgradePolicy?: string;
  candidates?: CandidateInput[];
}

const MEDIA_TYPES = ['tv', 'movie', 'anime', 'any'];
const UPGRADE_POLICIES = ['inherit', 'never', 'always'];

@Injectable()
export class AcquisitionTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.acquisitionRuleTemplate.findMany({
      orderBy: { name: 'asc' },
      include: { candidates: { orderBy: { priorityOrder: 'asc' } } },
    });
  }

  async get(id: string) {
    const row = await this.prisma.acquisitionRuleTemplate.findUnique({
      where: { id },
      include: { candidates: { orderBy: { priorityOrder: 'asc' } } },
    });
    if (!row) throw new NotFoundException('Acquisition template not found');
    return row;
  }

  async create(input: AcquisitionTemplateInput, userId?: string) {
    if (!input.name?.trim()) throw new BadRequestException('A name is required.');
    this.assertValid(input);

    const created = await this.prisma.acquisitionRuleTemplate.create({
      data: {
        ...(this.columns(input) as Prisma.AcquisitionRuleTemplateUncheckedCreateInput),
        name: input.name.trim(),
        createdBy: userId ?? null,
        candidates: { create: this.candidateRows(input.candidates ?? []) },
      },
      include: { candidates: { orderBy: { priorityOrder: 'asc' } } },
    });
    await this.audit.record({
      userId,
      action: 'media_discovery.acquisition_template.created',
      objectType: 'acquisition_rule_template',
      objectId: created.id,
      metadata: { name: created.name, candidates: created.candidates.length },
    });
    return created;
  }

  /**
   * Replace a template, bumping its version when the ladder itself changes.
   *
   * `version` is what lets a later sync tell a generated rule built from THIS
   * ladder from one built from an older ladder — the basis for offering to
   * re-apply a template without blindly rewriting hundreds of rules.
   */
  async update(id: string, input: AcquisitionTemplateInput, userId?: string) {
    const current = await this.get(id);
    this.assertValid({ ...current, ...input } as AcquisitionTemplateInput);

    const laddersDiffer =
      input.candidates !== undefined &&
      JSON.stringify(this.candidateRows(input.candidates)) !==
        JSON.stringify(this.candidateRows(current.candidates as unknown as CandidateInput[]));

    const updated = await this.prisma.$transaction(async (tx) => {
      if (input.candidates !== undefined) {
        // Replaced wholesale rather than diffed: the ladder is ordered, and a
        // partial update of an ordered list is where off-by-one priorities come
        // from. The candidates carry no runtime state worth preserving.
        await tx.acquisitionRuleTemplateCandidate.deleteMany({ where: { templateId: id } });
      }
      return tx.acquisitionRuleTemplate.update({
        where: { id },
        data: {
          ...(this.columns(input) as Prisma.AcquisitionRuleTemplateUncheckedUpdateInput),
          ...(laddersDiffer ? { version: { increment: 1 } } : {}),
          ...(input.candidates !== undefined
            ? { candidates: { create: this.candidateRows(input.candidates) } }
            : {}),
        },
        include: { candidates: { orderBy: { priorityOrder: 'asc' } } },
      });
    });

    await this.audit.record({
      userId,
      action: 'media_discovery.acquisition_template.updated',
      objectType: 'acquisition_rule_template',
      objectId: id,
      metadata: { name: updated.name, versionBumped: laddersDiffer, version: updated.version },
    });
    return updated;
  }

  async remove(id: string, userId?: string) {
    await this.get(id);
    await this.prisma.acquisitionRuleTemplate.delete({ where: { id } });
    await this.audit.record({
      userId,
      action: 'media_discovery.acquisition_template.deleted',
      objectType: 'acquisition_rule_template',
      objectId: id,
    });
    return { id };
  }

  // --- the mapping Phase 13 uses ------------------------------------------
  /**
   * A template's ladder as `RssRuleMatchCandidate` rows for one rule.
   *
   * A straight column copy, deliberately. The template's own
   * `requiredTerms`/`excludedTerms` are appended to every rung, because they are
   * template-wide constraints ("never a CAM") rather than a preference of one
   * rung — a rung that dropped them would be a hole in the constraint.
   */
  /**
   * Clone a ladder onto one rule — for ONE title.
   *
   * `subject` is what makes the result a rule about a show rather than a rule
   * about everything. `smart_episode_match` identifies the show through its
   * `pattern`, and `showTitleMatch` treats an EMPTY pattern as "matches
   * anything" — deliberately, so a hand-made rule can grab a whole feed. A
   * ladder is generic and cannot know which show it is being applied to, so it
   * carries no pattern, and cloning it verbatim produced per-show rules that
   * matched every item in the feed passing their quality rules.
   */
  toRuleCandidates(
    template: { requiredTerms: unknown; excludedTerms: unknown; candidates: AcquisitionRuleTemplateCandidate[] },
    rssRuleId: string,
    subject?: { title: string; mediaType: string },
  ): Prisma.RssRuleMatchCandidateUncheckedCreateInput[] {
    const globalRequired = asStrings(template.requiredTerms);
    const globalExcluded = asStrings(template.excludedTerms);

    return [...template.candidates]
      .sort((a, b) => a.priorityOrder - b.priorityOrder)
      .map((c, index) => ({
        rssRuleId,
        // Re-numbered from zero: a template edited over time can leave gaps, and
        // the rule's ladder should read 0,1,2 whatever the template's numbering
        // drifted to.
        priorityOrder: index,
        name: c.name,
        description: c.description,
        enabled: c.enabled,
        matchType: subject ? matchTypeFor(c.matchType, subject.mediaType) : c.matchType,
        /*
         * The show's own title, never the ladder's.
         *
         * For the smart types the pattern IS the title, and a ladder cannot know
         * it. For the text and pattern types a ladder value is an explicit
         * choice and is kept — but an empty one falls back to the title, because
         * the one thing a per-show rule must never be is unbounded.
         */
        pattern: subject ? patternFor(c, subject.title) : c.pattern,
        requiredTerms: unique([...asStrings(c.requiredTerms), ...globalRequired]) as Prisma.InputJsonValue,
        excludedTerms: unique([...asStrings(c.excludedTerms), ...globalExcluded]) as Prisma.InputJsonValue,
        qualityRules: (c.qualityRules ?? {}) as Prisma.InputJsonValue,
        sizeRules: (c.sizeRules ?? {}) as Prisma.InputJsonValue,
        feedScope: (c.feedScope ?? {}) as Prisma.InputJsonValue,
      }));
  }

  // --- validation ----------------------------------------------------------
  private assertValid(input: AcquisitionTemplateInput): void {
    if (input.mediaType && !MEDIA_TYPES.includes(input.mediaType)) {
      throw new BadRequestException(`mediaType must be one of ${MEDIA_TYPES.join(', ')}.`);
    }
    if (input.upgradePolicy && !UPGRADE_POLICIES.includes(input.upgradePolicy)) {
      throw new BadRequestException(`upgradePolicy must be one of ${UPGRADE_POLICIES.join(', ')}.`);
    }
    (input.candidates ?? []).forEach((c, i) => this.assertCandidate(c, i));
  }

  private assertCandidate(c: CandidateInput, index: number): void {
    const at = `Candidate ${index + 1}`;
    if (!c.name?.trim()) throw new BadRequestException(`${at} needs a name.`);
    if (c.matchType && !MATCH_TYPES.includes(c.matchType as never)) {
      throw new BadRequestException(`${at}: matchType must be one of ${MATCH_TYPES.join(', ')}.`);
    }
    if (c.matchType === 'regex' && c.pattern) {
      try {
        new RegExp(c.pattern);
      } catch {
        // A rule carrying a broken regex fails at match time, deep inside a
        // sweep, where the reason is a log line nobody is reading.
        throw new BadRequestException(`${at}: pattern is not a valid regular expression.`);
      }
    }

    for (const key of Object.keys(c.qualityRules ?? {})) {
      if (!QUALITY_KEYS.includes(key as never)) {
        const hint =
          key === 'hdr' || key === 'audio'
            ? ` The match engine does not read ${key} — express it as a required term instead, e.g. requiredTerms: ["DV"].`
            : '';
        throw new BadRequestException(
          `${at}: unknown quality rule "${key}". Allowed: ${QUALITY_KEYS.join(', ')}.${hint}`,
        );
      }
    }

    for (const key of Object.keys(c.sizeRules ?? {})) {
      if (!SIZE_KEYS.includes(key as never)) {
        throw new BadRequestException(`${at}: unknown size rule "${key}". Allowed: ${SIZE_KEYS.join(', ')}.`);
      }
    }
    const min = c.sizeRules?.minBytes;
    const max = c.sizeRules?.maxBytes;
    if (typeof min === 'number' && typeof max === 'number' && min > max) {
      throw new BadRequestException(`${at}: minBytes cannot exceed maxBytes.`);
    }
  }

  /** Candidate rows in ladder order, renumbered from zero. */
  private candidateRows(candidates: CandidateInput[]) {
    return [...candidates]
      .map((c, i) => ({ c, order: c.priorityOrder ?? i }))
      .sort((a, b) => a.order - b.order)
      .map(({ c }, index) => ({
        priorityOrder: index,
        name: (c.name ?? '').trim(),
        description: c.description ?? null,
        enabled: c.enabled ?? true,
        matchType: c.matchType ?? 'smart_episode_match',
        pattern: c.pattern ?? null,
        requiredTerms: asStrings(c.requiredTerms) as Prisma.InputJsonValue,
        excludedTerms: asStrings(c.excludedTerms) as Prisma.InputJsonValue,
        qualityRules: (c.qualityRules ?? {}) as Prisma.InputJsonValue,
        sizeRules: (c.sizeRules ?? {}) as Prisma.InputJsonValue,
        feedScope: (c.feedScope ?? {}) as Prisma.InputJsonValue,
      }));
  }

  private columns(input: AcquisitionTemplateInput): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    (
      ['description', 'mediaType', 'enabled', 'rssFeedId', 'storageProfileId', 'pathTemplate',
       'requiredTerms', 'excludedTerms', 'upgradePolicy'] as Array<keyof AcquisitionTemplateInput>
    ).forEach((k) => {
      if (input[k] !== undefined) out[k as string] = input[k];
    });
    if (input.name !== undefined) out.name = input.name.trim();
    return out;
  }
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

function unique(v: string[]): string[] {
  return [...new Set(v)];
}

/** The smart types are per-media-kind; a ladder is written once for both. */
function matchTypeFor(matchType: string, mediaType: string): string {
  if (mediaType === 'movie' && matchType === 'smart_episode_match') return 'smart_movie_match';
  if (mediaType !== 'movie' && matchType === 'smart_movie_match') return 'smart_episode_match';
  return matchType;
}

/**
 * The pattern a generated candidate must carry.
 *
 * Never empty. `showTitleMatch` reads an empty pattern as "matches anything",
 * which is right for a rule somebody wrote by hand to take a whole feed and
 * catastrophic for a rule generated for one show.
 */
function patternFor(candidate: { matchType: string; pattern: string | null }, title: string): string {
  if (candidate.matchType === 'smart_episode_match' || candidate.matchType === 'smart_movie_match') {
    return title;
  }
  if (candidate.pattern?.trim()) return candidate.pattern;

  /*
   * The fallback substitutes a TITLE where a pattern was expected, and a title
   * is literal text that a metadata provider chose — not an expression somebody
   * wrote. For a `regex` rung it was being compiled as one.
   *
   * Two things went wrong with that. `S.W.A.T. Exiles` stops meaning what it
   * says: every `.` matches any character, so the rung quietly matches releases
   * it should not. And a title is untrusted input from TMDB or TVmaze, so a
   * name containing nested quantifiers becomes a pattern evaluated against every
   * item in every polled feed.
   *
   * `wildcard` is left alone: its own conversion escapes the metacharacters and
   * deliberately keeps `*` and `?`, which is what makes it a wildcard.
   */
  return candidate.matchType === 'regex' ? escapeRegex(title) : title;
}
