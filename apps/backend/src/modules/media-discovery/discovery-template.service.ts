import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { DiscoveryTemplate, Prisma } from '@prisma/client';
import { CATEGORY_MATCH_MODES, PATH_TEMPLATE_TOKENS, RELEASE_TYPES } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export interface DiscoveryTemplateInput {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  mediaType?: string;
  providers?: string[];
  upcomingWindowDays?: number;
  regions?: string[];
  languages?: string[];
  minimumPopularity?: number | null;
  minimumRating?: number | null;
  minimumVoteCount?: number | null;
  networks?: string[];
  streamingServices?: string[];
  studios?: string[];
  seriesTypes?: string[];
  releaseTypes?: string[];
  autoMonitorCategories?: string[];
  notifyOnlyCategories?: string[];
  ignoreCategories?: string[];
  blockedFromAutoCategories?: string[];
  categoryMatchMode?: string;
  minimumConfidence?: number;
  acquisitionTemplateId?: string | null;
  rssFeedId?: string | null;
  storageProfileId?: string | null;
  pathTemplate?: string | null;
  createIntakeDirectory?: boolean;
  autoAddLimitPerDay?: number;
  autoAddLimitPerWeek?: number;
}

const MEDIA_TYPES = ['movie', 'tv', 'any'];
/** A year ahead. Beyond that a provider's dates are announcements, not schedule. */
const MAX_WINDOW_DAYS = 365;
/** C0 and C1 control characters, which have no place in a path fragment. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * What a discovery template is allowed to be.
 *
 * Validation is split in two on purpose, and the split is the whole design:
 *
 *  - **Saving** checks only that the template is coherent — a half-built one must
 *    stay saveable, or an operator cannot put it down and come back to it.
 *  - **Enabling** checks that it can actually do what it claims. A template that
 *    would auto-monitor needs somewhere to put the media and a feed to watch;
 *    without them it would run, decide, and then fail at the last step, which is
 *    the worst place to discover a missing setting.
 */
@Injectable()
export class DiscoveryTemplateService {
  private readonly logger = new Logger(DiscoveryTemplateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.discoveryTemplate.findMany({ orderBy: { name: 'asc' } });
  }

  async get(id: string): Promise<DiscoveryTemplate> {
    const row = await this.prisma.discoveryTemplate.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Discovery template not found');
    return row;
  }

  async create(input: DiscoveryTemplateInput, userId?: string): Promise<DiscoveryTemplate> {
    if (!input.name?.trim()) throw new BadRequestException('A name is required.');
    this.assertCoherent(input);
    const data = this.columns(input);
    if (data.enabled) await this.assertEnableable({ ...(data as object) } as DiscoveryTemplate);

    const created = await this.prisma.discoveryTemplate.create({
      data: {
        ...(data as Prisma.DiscoveryTemplateUncheckedCreateInput),
        name: input.name.trim(),
        createdBy: userId ?? null,
      },
    });
    await this.audit.record({
      userId,
      action: 'media_discovery.template.created',
      objectType: 'discovery_template',
      objectId: created.id,
      metadata: { name: created.name, enabled: created.enabled },
    });
    return created;
  }

  async update(id: string, input: DiscoveryTemplateInput, userId?: string): Promise<DiscoveryTemplate> {
    const current = await this.get(id);
    this.assertCoherent({ ...current, ...input } as DiscoveryTemplateInput);

    const next = { ...current, ...this.columns(input) } as DiscoveryTemplate;
    if (next.enabled) await this.assertEnableable(next);

    /*
     * A policy change re-opens every title this template had already decided.
     *
     * The evaluator's candidate filter is "no evaluation for this template", so
     * without clearing those rows an edit changed nothing for anything already
     * seen — you could move a genre to the "never" list, press Refresh, and
     * watch the same titles stay monitored. The comment in the evaluator said a
     * template edit was what should cause a re-run; nothing implemented it.
     *
     * Renaming a template or toggling `enabled` is not a policy change and does
     * not reopen anything.
     */
    const changed = this.policyChanged(current, input);

    const updated = await this.prisma.discoveryTemplate.update({
      where: { id },
      data: {
        ...(this.columns(input) as Prisma.DiscoveryTemplateUncheckedUpdateInput),
        ...(changed ? { policyVersion: { increment: 1 } } : {}),
      },
    });
    if (changed) {
      const { count } = await this.prisma.discoveryEvaluation.deleteMany({ where: { templateId: id } });
      this.logger.log(
        `Template "${updated.name}" policy changed (v${updated.policyVersion}) — reopened ${count} decision(s)`,
      );
    }
    await this.audit.record({
      userId,
      action: 'media_discovery.template.updated',
      objectType: 'discovery_template',
      objectId: id,
      metadata: {
        name: updated.name,
        // Enabling is the consequential half of an edit, so it is called out
        // rather than left for a reader to diff out of the payload.
        ...(current.enabled !== updated.enabled ? { enabledChangedTo: updated.enabled } : {}),
        // A policy bump is the half of an edit that changes outcomes, so it is
        // recorded rather than inferred from a version column nobody diffs.
        ...(changed ? { policyVersion: updated.policyVersion } : {}),
      },
    });
    return updated;
  }

  async remove(id: string, userId?: string): Promise<{ id: string }> {
    await this.get(id);
    await this.prisma.discoveryTemplate.delete({ where: { id } });
    await this.audit.record({
      userId,
      action: 'media_discovery.template.deleted',
      objectType: 'discovery_template',
      objectId: id,
    });
    return { id };
  }

  /**
   * Would this template ever create a watchlist entry and a rule?
   *
   * A template with no auto-monitor categories only ever notifies or ignores, so
   * it needs neither a feed nor a destination — requiring them would block the
   * most cautious way to use the feature, which is exactly the configuration an
   * operator should be encouraged to start from.
   */
  canAutoMonitor(t: Pick<DiscoveryTemplate, 'autoMonitorCategories'>): boolean {
    return (t.autoMonitorCategories ?? []).length > 0;
  }

  // --- validation ----------------------------------------------------------
  /** Is the template internally consistent? Checked on every save. */
  private assertCoherent(input: DiscoveryTemplateInput): void {
    if (input.mediaType && !MEDIA_TYPES.includes(input.mediaType)) {
      throw new BadRequestException(`mediaType must be one of ${MEDIA_TYPES.join(', ')}.`);
    }
    if (input.categoryMatchMode && !CATEGORY_MATCH_MODES.includes(input.categoryMatchMode as never)) {
      throw new BadRequestException(`categoryMatchMode must be one of ${CATEGORY_MATCH_MODES.join(', ')}.`);
    }
    if (
      input.upcomingWindowDays != null &&
      (input.upcomingWindowDays < 1 || input.upcomingWindowDays > MAX_WINDOW_DAYS)
    ) {
      throw new BadRequestException(`upcomingWindowDays must be between 1 and ${MAX_WINDOW_DAYS}.`);
    }
    if (input.minimumConfidence != null && (input.minimumConfidence < 0 || input.minimumConfidence > 1)) {
      throw new BadRequestException('minimumConfidence must be between 0 and 1.');
    }

    const unknownRelease = (input.releaseTypes ?? []).filter((t) => !RELEASE_TYPES.includes(t as never));
    if (unknownRelease.length) {
      throw new BadRequestException(`Unknown release type(s): ${unknownRelease.join(', ')}.`);
    }

    /*
     * A category cannot both qualify a title and disqualify it.
     *
     * Auto-monitor and ignore are opposite verdicts, so overlapping them has no
     * defensible reading — whichever we picked would silently be the opposite of
     * what half the configuration says. Blocked-from-auto overlapping auto-monitor
     * is DIFFERENT and allowed: that is the documented way to say "Sci-Fi
     * qualifies, but never when it is also a Documentary".
     */
    const auto = new Set((input.autoMonitorCategories ?? []).map(norm));
    const ignore = (input.ignoreCategories ?? []).map(norm);
    const clash = ignore.filter((c) => auto.has(c));
    if (clash.length) {
      throw new BadRequestException(
        `A category cannot be both auto-monitored and ignored: ${clash.join(', ')}.`,
      );
    }

    if (input.autoAddLimitPerDay != null && input.autoAddLimitPerDay < 0) {
      throw new BadRequestException('autoAddLimitPerDay cannot be negative.');
    }
    if (input.autoAddLimitPerWeek != null && input.autoAddLimitPerWeek < 0) {
      throw new BadRequestException('autoAddLimitPerWeek cannot be negative.');
    }
    /*
     * A weekly cap below the daily one can never bind on any day it matters: the
     * daily allowance would be exhausted first every time, so the weekly figure
     * would be a number in the UI that never does anything.
     */
    if (
      input.autoAddLimitPerDay != null &&
      input.autoAddLimitPerWeek != null &&
      input.autoAddLimitPerWeek < input.autoAddLimitPerDay
    ) {
      throw new BadRequestException('autoAddLimitPerWeek cannot be lower than autoAddLimitPerDay.');
    }

    if (input.pathTemplate) this.assertPathTemplate(input.pathTemplate);
  }

  /**
   * The leaf shape below the profile's staging root.
   *
   * An allow-list, and absolute paths are refused outright: the root is the
   * Storage Profile's to choose, never the template's. The renderer applies its
   * own sanitisation later; this refuses the template at the point a person can
   * still see why.
   */
  private assertPathTemplate(template: string): void {
    if (template.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(template)) {
      throw new BadRequestException(
        'pathTemplate must be relative — the root comes from the Storage Profile.',
      );
    }
    if (template.includes('..')) {
      throw new BadRequestException('pathTemplate cannot contain "..".');
    }
    if (CONTROL_CHARS.test(template)) {
      throw new BadRequestException('pathTemplate cannot contain control characters.');
    }
    const unknown = [...template.matchAll(/\{([^}]*)\}/g)]
      .map((m) => m[1])
      .filter((token) => !PATH_TEMPLATE_TOKENS.includes(token as never));
    if (unknown.length) {
      throw new BadRequestException(
        `Unknown path token(s): ${unknown.map((u) => `{${u}}`).join(', ')}. Allowed: ${PATH_TEMPLATE_TOKENS.map((t) => `{${t}}`).join(', ')}.`,
      );
    }
  }

  /** Can this template actually do what enabling it would set in motion? */
  private async assertEnableable(t: DiscoveryTemplate): Promise<void> {
    if (!this.canAutoMonitor(t)) return; // notify/ignore only — nothing to generate

    if (!t.rssFeedId) {
      throw new BadRequestException(
        'Select an RSS feed before enabling: an auto-monitored title generates a rule, and a rule must belong to a feed.',
      );
    }
    const feed = await this.prisma.rssFeed.findUnique({
      where: { id: t.rssFeedId },
      select: { id: true, isEnabled: true, name: true },
    });
    if (!feed) throw new BadRequestException('The selected RSS feed no longer exists.');
    if (!feed.isEnabled) {
      throw new ConflictException(
        `The feed "${feed.name}" is disabled — generated rules would never match anything.`,
      );
    }

    if (!t.storageProfileId) {
      throw new BadRequestException(
        'Select a storage profile before enabling: it decides where auto-monitored media is staged and filed.',
      );
    }
    const profile = await this.prisma.storageProfile.findUnique({
      where: { id: t.storageProfileId },
      select: { id: true, isEnabled: true, name: true },
    });
    if (!profile) throw new BadRequestException('The selected storage profile no longer exists.');
    if (!profile.isEnabled) {
      throw new ConflictException(`The storage profile "${profile.name}" is disabled.`);
    }

    if (t.acquisitionTemplateId) {
      const acq = await this.prisma.acquisitionRuleTemplate.findUnique({
        where: { id: t.acquisitionTemplateId },
        select: { id: true },
      });
      if (!acq) throw new BadRequestException('The selected acquisition template no longer exists.');
    }
    // No acquisition template is legal: `resolveCandidates()` already falls back
    // to the auto-download profiles and then the global defaults, so a generated
    // rule without one still has preferences — just not template-specific ones.
  }

  /** Only the fields the caller actually supplied. */
  /**
   * Whether an edit changed anything that could change a DECISION.
   *
   * `name`, `description` and `enabled` are deliberately excluded: re-deciding
   * 870 titles because somebody fixed a typo would flood the inbox and, worse,
   * teach people not to touch templates.
   */
  private policyChanged(current: DiscoveryTemplate, input: DiscoveryTemplateInput): boolean {
    const next = this.columns(input);
    return POLICY_KEYS.some((key) => {
      if (!(key in next)) return false;
      return !same((current as Record<string, unknown>)[key], next[key]);
    });
  }

  private columns(input: DiscoveryTemplateInput): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const copy = <K extends keyof DiscoveryTemplateInput>(key: K) => {
      if (input[key] !== undefined) out[key as string] = input[key];
    };
    (
      [
        'description', 'enabled', 'mediaType', 'providers', 'upcomingWindowDays', 'regions',
        'languages', 'minimumPopularity', 'minimumRating', 'minimumVoteCount', 'networks',
        'streamingServices', 'studios', 'seriesTypes', 'releaseTypes', 'autoMonitorCategories',
        'notifyOnlyCategories', 'ignoreCategories', 'blockedFromAutoCategories',
        'categoryMatchMode', 'minimumConfidence', 'acquisitionTemplateId', 'rssFeedId',
        'storageProfileId', 'pathTemplate', 'createIntakeDirectory', 'autoAddLimitPerDay',
        'autoAddLimitPerWeek',
      ] as Array<keyof DiscoveryTemplateInput>
    ).forEach(copy);
    if (input.name !== undefined) out.name = input.name.trim();
    return out;
  }
}

/**
 * The columns that decide an outcome. Everything the evaluator or the rule
 * generator reads — scope, thresholds, categories, and the destination a
 * generated rule is built from.
 */
const POLICY_KEYS = [
  'mediaType', 'providers', 'upcomingWindowDays', 'regions', 'languages',
  'minimumPopularity', 'minimumRating', 'minimumVoteCount', 'networks',
  'streamingServices', 'studios', 'seriesTypes', 'releaseTypes',
  'autoMonitorCategories', 'notifyOnlyCategories', 'ignoreCategories',
  'blockedFromAutoCategories', 'categoryMatchMode', 'minimumConfidence',
  'acquisitionTemplateId', 'rssFeedId', 'storageProfileId', 'pathTemplate',
  'createIntakeDirectory', 'autoAddLimitPerDay', 'autoAddLimitPerWeek',
] as const;

/**
 * Order-insensitive for arrays.
 *
 * The category lists are sets in every way that matters, and treating
 * `['Drama','Sci-Fi']` as different from `['Sci-Fi','Drama']` would reopen the
 * whole catalogue every time somebody re-ordered a multi-select.
 */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sa = [...a].map(String).sort();
    const sb = [...b].map(String).sort();
    return sa.every((v, i) => v === sb[i]);
  }
  return a === b || (a == null && b == null);
}

/** Categories are compared case- and space-insensitively. */
function norm(s: string): string {
  return s.trim().toLowerCase();
}
