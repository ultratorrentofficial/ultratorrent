import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';
import type { Request } from 'express';
import Parser from 'rss-parser';
import { PERMISSIONS } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import {
  evaluateCandidate,
  evaluatePreferenceList,
  MatchCandidateInput,
  toRegexPattern,
  type ItemContext,
} from './match-engine';
import {
  parseTorrentName,
  buildSmartCandidates,
  type GeneratedCandidate,
} from './torrent-name-parser';
import { ruleTargetFeedIds } from './rss-feed-scope';

const MATCH_TYPES = [
  'exact_text',
  'contains_text',
  'regex',
  'wildcard',
  'smart_episode_match',
  'smart_movie_match',
  'fuzzy_match',
];

class CreateFeedDto {
  @IsString() name!: string;
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }) url!: string;
  @IsOptional() @IsInt() refreshInterval?: number;
  @IsOptional() @IsBoolean() isEnabled?: boolean;
}
class UpdateFeedDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsUrl({ protocols: ['http', 'https'], require_protocol: true }) url?: string;
  @IsOptional() @IsInt() refreshInterval?: number;
  @IsOptional() @IsBoolean() isEnabled?: boolean;
}
class CreateRuleDto {
  @IsString() feedId!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() includeRegex?: string;
  @IsOptional() @IsString() excludeRegex?: string;
  @IsOptional() @IsString() savePath?: string;
  @IsOptional() @IsBoolean() autoDownload?: boolean;
}

class UpdateRuleDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() includeRegex?: string;
  @IsOptional() @IsString() excludeRegex?: string;
  @IsOptional() @IsString() savePath?: string;
  @IsOptional() @IsBoolean() autoDownload?: boolean;
}

@Injectable()
export class RssService {
  private readonly logger = new Logger(RssService.name);
  // customFields expose the magnet sources feeds use beyond <link>/<enclosure>:
  // Torznab/Newznab `<torznab:attr name="magneturl" …/>` and dedicated
  // `<magneturl>`/`<magnetURI>` elements.
  private readonly parser = new Parser({
    timeout: 15000,
    customFields: {
      item: [
        ['torznab:attr', 'torznabAttrs', { keepArray: true }],
        ['torrent:magnetURI', 'torrentMagnet'], // EZTV & most torrent feeds
        'magneturl',
        'magnetURI',
      ],
    },
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
  ) {}

  async listFeeds() {
    const feeds = await this.prisma.rssFeed.findMany({
      include: {
        rules: {
          // Rules render alphabetically inside each feed.
          orderBy: { name: 'asc' },
          // Candidate scope decides which other feeds a rule also appears under.
          include: { matchCandidates: { select: { enabled: true, feedScope: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    // Attach each rule's full set of target feeds (owner + enabled candidate
    // scopes) and drop the candidate rows from the wire shape.
    return feeds.map((feed) => ({
      ...feed,
      rules: feed.rules.map(({ matchCandidates, ...rule }) => ({
        ...rule,
        feedIds: ruleTargetFeedIds(rule, matchCandidates),
      })),
    }));
  }
  createFeed(dto: CreateFeedDto) {
    return this.prisma.rssFeed.create({ data: dto });
  }
  async updateFeed(id: string, dto: UpdateFeedDto) {
    const feed = await this.prisma.rssFeed.findUnique({ where: { id } });
    if (!feed) throw new NotFoundException(`Unknown RSS feed: ${id}`);
    return this.prisma.rssFeed.update({
      where: { id },
      data: {
        name: dto.name ?? undefined,
        url: dto.url ?? undefined,
        refreshInterval: dto.refreshInterval ?? undefined,
        isEnabled: dto.isEnabled === undefined ? undefined : dto.isEnabled,
      },
    });
  }
  deleteFeed(id: string) {
    return this.prisma.rssFeed.delete({ where: { id } });
  }
  createRule(dto: CreateRuleDto) {
    return this.prisma.rssRule.create({ data: dto });
  }
  async updateRule(id: string, dto: UpdateRuleDto) {
    const rule = await this.prisma.rssRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException(`Unknown RSS rule: ${id}`);
    // Undefined = leave unchanged; empty string clears the optional patterns.
    const updated = await this.prisma.rssRule.update({
      where: { id },
      data: {
        name: dto.name ?? undefined,
        includeRegex: dto.includeRegex === undefined ? undefined : dto.includeRegex || null,
        excludeRegex: dto.excludeRegex === undefined ? undefined : dto.excludeRegex || null,
        savePath: dto.savePath === undefined ? undefined : dto.savePath || null,
        autoDownload: dto.autoDownload === undefined ? undefined : dto.autoDownload,
      },
    });

    // Enabling auto-download or changing a legacy include/exclude regex can
    // make already-seen history items eligible — grab them now.
    await this.backfillHistory(id).catch((e) =>
      this.logger.warn(`RSS backfill failed: ${e.message}`),
    );

    return updated;
  }
  deleteRule(id: string) {
    return this.prisma.rssRule.delete({ where: { id } });
  }

  // --- import / export --------------------------------------------------

  /**
   * Export every rule + its match candidates as a portable bundle. Rules are
   * keyed to their owner feed by URL (not internal id) so the bundle can be
   * imported into a different install. Candidate feed-scope (which references
   * feed ids) is intentionally dropped — it is meaningless across installs.
   */
  async exportRules() {
    const rules = await this.prisma.rssRule.findMany({
      include: {
        feed: true,
        matchCandidates: { orderBy: { priorityOrder: 'asc' } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      kind: 'ultratorrent.rss-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      rules: rules.map((r) => ({
        name: r.name,
        includeRegex: r.includeRegex,
        excludeRegex: r.excludeRegex,
        savePath: r.savePath,
        autoDownload: r.autoDownload,
        isEnabled: r.isEnabled,
        feed: {
          name: r.feed.name,
          url: r.feed.url,
          refreshInterval: r.feed.refreshInterval,
        },
        candidates: r.matchCandidates.map((c) => ({
          priorityOrder: c.priorityOrder,
          name: c.name,
          description: c.description,
          enabled: c.enabled,
          matchType: c.matchType,
          pattern: c.pattern,
          requiredTerms: c.requiredTerms,
          excludedTerms: c.excludedTerms,
          qualityRules: c.qualityRules,
          sizeRules: c.sizeRules,
        })),
      })),
    };
  }

  /**
   * Import a bundle produced by {@link exportRules}. Feeds are matched by URL
   * (created if missing); a rule with the same name under the same feed is
   * skipped so re-importing is safe. Does NOT auto-download from existing
   * history (avoids a surprise bulk grab) — new items are picked up on the
   * next poll.
   */
  async importRules(body: any) {
    if (!body || body.kind !== 'ultratorrent.rss-export' || !Array.isArray(body.rules)) {
      throw new BadRequestException('Not a valid UltraTorrent RSS export');
    }
    const summary = {
      feedsCreated: 0,
      rulesCreated: 0,
      candidatesCreated: 0,
      rulesSkipped: 0,
    };

    for (const r of body.rules) {
      const feedUrl = r?.feed?.url;
      if (!r || typeof r.name !== 'string' || typeof feedUrl !== 'string') {
        summary.rulesSkipped += 1;
        continue;
      }

      let feed = await this.prisma.rssFeed.findFirst({ where: { url: feedUrl } });
      if (!feed) {
        feed = await this.prisma.rssFeed.create({
          data: {
            name: typeof r.feed.name === 'string' ? r.feed.name : feedUrl,
            url: feedUrl,
            refreshInterval:
              typeof r.feed.refreshInterval === 'number' ? r.feed.refreshInterval : 900,
          },
        });
        summary.feedsCreated += 1;
      }

      const existing = await this.prisma.rssRule.findFirst({
        where: { feedId: feed.id, name: r.name },
      });
      if (existing) {
        summary.rulesSkipped += 1;
        continue;
      }

      const rule = await this.prisma.rssRule.create({
        data: {
          feedId: feed.id,
          name: r.name,
          includeRegex: r.includeRegex ?? null,
          excludeRegex: r.excludeRegex ?? null,
          savePath: r.savePath ?? null,
          autoDownload: typeof r.autoDownload === 'boolean' ? r.autoDownload : true,
          isEnabled: typeof r.isEnabled === 'boolean' ? r.isEnabled : true,
        },
      });
      summary.rulesCreated += 1;

      let order = 0;
      for (const c of Array.isArray(r.candidates) ? r.candidates : []) {
        if (!c || !MATCH_TYPES.includes(c.matchType)) continue;
        order += 1;
        await this.prisma.rssRuleMatchCandidate.create({
          data: {
            rssRuleId: rule.id,
            name: typeof c.name === 'string' && c.name ? c.name : `Candidate ${order}`,
            description: typeof c.description === 'string' ? c.description : null,
            enabled: typeof c.enabled === 'boolean' ? c.enabled : true,
            matchType: c.matchType,
            pattern: typeof c.pattern === 'string' ? c.pattern : null,
            requiredTerms: (Array.isArray(c.requiredTerms) ? c.requiredTerms : []) as object,
            excludedTerms: (Array.isArray(c.excludedTerms) ? c.excludedTerms : []) as object,
            qualityRules: (c.qualityRules && typeof c.qualityRules === 'object'
              ? c.qualityRules
              : {}) as object,
            sizeRules: (c.sizeRules && typeof c.sizeRules === 'object'
              ? c.sizeRules
              : {}) as object,
            feedScope: {}, // cross-install feed ids are dropped
            priorityOrder: typeof c.priorityOrder === 'number' ? c.priorityOrder : order,
          },
        });
        summary.candidatesCreated += 1;
      }
    }

    return summary;
  }
  /**
   * Paginated feed history, newest first (default 25 per page, max 100), plus
   * status counts across the whole feed for the summary tiles. The three status
   * buckets are mutually exclusive: downloaded, matched-but-not-downloaded, and
   * seen (neither).
   */
  async history(feedId: string, page = 1, pageSize = 25) {
    const take = Math.min(Math.max(Math.trunc(pageSize) || 25, 1), 100);
    const current = Math.max(Math.trunc(page) || 1, 1);
    const [items, total, downloaded, matchedOnly] = await this.prisma.$transaction([
      this.prisma.rssHistory.findMany({
        where: { feedId },
        orderBy: { createdAt: 'desc' },
        skip: (current - 1) * take,
        take,
      }),
      this.prisma.rssHistory.count({ where: { feedId } }),
      this.prisma.rssHistory.count({ where: { feedId, downloaded: true } }),
      this.prisma.rssHistory.count({ where: { feedId, matched: true, downloaded: false } }),
    ]);
    return {
      items,
      total,
      page: current,
      pageSize: take,
      counts: { downloaded, matched: matchedOnly, seen: total - downloaded - matchedOnly },
    };
  }

  // --- match candidates --------------------------------------------------

  private async assertRule(ruleId: string) {
    const rule = await this.prisma.rssRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw new BadRequestException('RSS rule not found');
    return rule;
  }

  /** Map a stored candidate row into the engine's input shape. */
  private toEngineCandidate(row: any): MatchCandidateInput {
    return {
      id: row.id,
      name: row.name,
      priorityOrder: row.priorityOrder,
      enabled: row.enabled,
      matchType: row.matchType,
      pattern: row.pattern,
      requiredTerms: (row.requiredTerms ?? []) as string[],
      excludedTerms: (row.excludedTerms ?? []) as string[],
      qualityRules: (row.qualityRules ?? {}) as MatchCandidateInput['qualityRules'],
      sizeRules: (row.sizeRules ?? {}) as MatchCandidateInput['sizeRules'],
      feedScope: (row.feedScope ?? {}) as MatchCandidateInput['feedScope'],
    };
  }

  listCandidates(ruleId: string) {
    return this.prisma.rssRuleMatchCandidate.findMany({
      where: { rssRuleId: ruleId },
      orderBy: { priorityOrder: 'asc' },
    });
  }

  /** Normalize a raw candidate body (JSON fields read straight from req.body). */
  private normalizeCandidateInput(body: any) {
    if (body.matchType && !MATCH_TYPES.includes(body.matchType)) {
      throw new BadRequestException(`Invalid match type: ${body.matchType}`);
    }
    return {
      name: typeof body.name === 'string' ? body.name : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      matchType: body.matchType as string | undefined,
      pattern: typeof body.pattern === 'string' ? body.pattern : undefined,
      requiredTerms: Array.isArray(body.requiredTerms) ? body.requiredTerms : undefined,
      excludedTerms: Array.isArray(body.excludedTerms) ? body.excludedTerms : undefined,
      qualityRules: body.qualityRules && typeof body.qualityRules === 'object' ? body.qualityRules : undefined,
      sizeRules: body.sizeRules && typeof body.sizeRules === 'object' ? body.sizeRules : undefined,
      feedScope: body.feedScope && typeof body.feedScope === 'object' ? body.feedScope : undefined,
      priorityOrder: typeof body.priorityOrder === 'number' ? body.priorityOrder : undefined,
    };
  }

  async createCandidate(ruleId: string, body: any) {
    await this.assertRule(ruleId);
    const input = this.normalizeCandidateInput(body);
    if (!input.name) throw new BadRequestException('Candidate name is required');
    if (!input.matchType) throw new BadRequestException('matchType is required');

    const last = await this.prisma.rssRuleMatchCandidate.findFirst({
      where: { rssRuleId: ruleId },
      orderBy: { priorityOrder: 'desc' },
    });
    const priorityOrder = input.priorityOrder ?? (last ? last.priorityOrder + 1 : 1);

    const created = await this.prisma.rssRuleMatchCandidate.create({
      data: {
        rssRuleId: ruleId,
        name: input.name,
        description: input.description,
        enabled: input.enabled ?? true,
        matchType: input.matchType,
        pattern: input.pattern,
        requiredTerms: input.requiredTerms ?? [],
        excludedTerms: input.excludedTerms ?? [],
        qualityRules: input.qualityRules ?? {},
        sizeRules: input.sizeRules ?? {},
        feedScope: input.feedScope ?? {},
        priorityOrder,
      },
    });

    // A newly-added preference can match items already seen in the feed
    // history. Grab those now instead of waiting for the next poll.
    const backfill = await this.backfillHistory(ruleId).catch((e) => {
      this.logger.warn(`RSS backfill failed: ${e.message}`);
      return { evaluated: 0, matched: 0, downloaded: 0 };
    });

    return { ...created, backfill };
  }

  async updateCandidate(ruleId: string, candidateId: string, body: any) {
    await this.assertRule(ruleId);
    const input = this.normalizeCandidateInput(body);
    const updated = await this.prisma.rssRuleMatchCandidate.update({
      where: { id: candidateId },
      data: {
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        matchType: input.matchType,
        pattern: input.pattern,
        requiredTerms: input.requiredTerms,
        excludedTerms: input.excludedTerms,
        qualityRules: input.qualityRules,
        sizeRules: input.sizeRules,
        feedScope: input.feedScope,
        priorityOrder: input.priorityOrder,
      },
    });

    // Editing a candidate can widen what it matches (e.g. switching to
    // token-AND contains, fixing a pattern, or re-enabling it). Re-run the
    // backfill so items already in history that now match get grabbed — the
    // poll never revisits items it has already seen.
    const backfill = await this.backfillHistory(ruleId).catch((e) => {
      this.logger.warn(`RSS backfill failed: ${e.message}`);
      return { evaluated: 0, matched: 0, downloaded: 0 };
    });

    return { ...updated, backfill };
  }

  async deleteCandidate(ruleId: string, candidateId: string) {
    await this.assertRule(ruleId);
    await this.prisma.rssRuleMatchCandidate.delete({ where: { id: candidateId } });
    return { id: candidateId };
  }

  /** Persist a new priority order from an ordered id list. */
  async reorderCandidates(ruleId: string, orderedIds: string[]) {
    await this.assertRule(ruleId);
    if (!Array.isArray(orderedIds)) {
      throw new BadRequestException('orderedIds must be an array');
    }
    await this.prisma.$transaction(
      orderedIds.map((id, index) =>
        this.prisma.rssRuleMatchCandidate.update({
          where: { id },
          data: { priorityOrder: index + 1 },
        }),
      ),
    );
    return this.listCandidates(ruleId);
  }

  /** Test one candidate (stored or inline) against sample titles. */
  async testMatch(
    ruleId: string,
    body: { candidateId?: string; candidate?: any; titles?: string[] },
  ) {
    await this.assertRule(ruleId);
    const titles = (body.titles ?? []).filter((t) => typeof t === 'string');
    if (titles.length === 0) throw new BadRequestException('Provide sample titles');

    let candidate: MatchCandidateInput;
    if (body.candidateId) {
      const row = await this.prisma.rssRuleMatchCandidate.findUniqueOrThrow({
        where: { id: body.candidateId },
      });
      candidate = this.toEngineCandidate(row);
    } else if (body.candidate) {
      const c = body.candidate;
      candidate = {
        id: c.id ?? 'inline',
        name: c.name ?? 'inline candidate',
        priorityOrder: c.priorityOrder ?? 0,
        enabled: c.enabled ?? true,
        matchType: c.matchType,
        pattern: c.pattern ?? '',
        requiredTerms: c.requiredTerms ?? [],
        excludedTerms: c.excludedTerms ?? [],
        qualityRules: c.qualityRules ?? {},
        sizeRules: c.sizeRules ?? {},
        feedScope: c.feedScope ?? {},
      };
    } else {
      throw new BadRequestException('Provide candidateId or candidate');
    }

    return {
      results: titles.map((title) => ({
        title,
        ...evaluateCandidate(candidate, { title } as ItemContext),
      })),
    };
  }

  /** Test the whole ordered candidate list against sample titles. */
  async testPreferenceList(ruleId: string, body: { titles?: string[] }) {
    await this.assertRule(ruleId);
    const titles = (body.titles ?? []).filter((t) => typeof t === 'string');
    if (titles.length === 0) throw new BadRequestException('Provide sample titles');
    const rows = await this.listCandidates(ruleId);
    const candidates = rows.map((r) => this.toEngineCandidate(r));
    return {
      results: titles.map((title) => ({
        title,
        ...evaluatePreferenceList(candidates, { title }),
      })),
    };
  }

  /**
   * Test the rule's preference list against the items already seen on the
   * feed(s) it targets (the stored feed history) — the realistic "does this
   * filter catch what actually comes through?" check. Returns `historyCount`
   * so the caller can fall back to manually entered titles when it is empty.
   */
  async testAgainstHistory(ruleId: string) {
    const rule = await this.prisma.rssRule.findUnique({
      where: { id: ruleId },
      include: { matchCandidates: true },
    });
    if (!rule) throw new BadRequestException('RSS rule not found');

    const candidates = (rule.matchCandidates ?? []).map((c) => this.toEngineCandidate(c));
    const feedIds = ruleTargetFeedIds(rule, rule.matchCandidates);

    const history = feedIds.length
      ? await this.prisma.rssHistory.findMany({
          where: { feedId: { in: feedIds } },
          orderBy: { createdAt: 'desc' },
          take: 200,
        })
      : [];

    // History rows carry no size, so size rules are skipped (unknown size
    // passes); every other check runs exactly as during polling. Each result
    // carries the history id + downloaded state so a matched row can be
    // grabbed for real straight from the Test tab (not just simulated).
    const results = history.map((h) => ({
      historyId: h.id,
      downloaded: h.downloaded,
      hasMagnet: !!h.magnet,
      title: h.title,
      ...(candidates.length
        ? evaluatePreferenceList(candidates, { title: h.title, feedId: h.feedId })
        : this.legacyEvaluation(rule, h.title)),
    }));

    return { results, historyCount: history.length };
  }

  /** Manually grab a single feed-history item from the history browser. */
  async downloadHistoryItem(historyId: string) {
    const item = await this.prisma.rssHistory.findUnique({ where: { id: historyId } });
    if (!item) throw new NotFoundException('RSS history item not found');

    // Prefer the magnet (resolves via DHT/trackers) over a direct .torrent URL
    // that points at a single host. Older rows have no stored magnet, so gather
    // it from the live feed on demand and persist it for next time.
    let magnet = item.magnet;
    if (!magnet) {
      magnet = await this.resolveMagnetFromFeed(item).catch(() => null);
      if (magnet) {
        await this.prisma.rssHistory
          .update({ where: { id: item.id }, data: { magnet } })
          .catch(() => undefined);
      }
    }
    const dl = magnet || item.link;
    if (!dl) throw new BadRequestException('This item has no download link');

    let torrentHash: string | null;
    try {
      torrentHash = await this.addToEngine(dl);
    } catch (e) {
      // Surface the real reason (dead link 404, engine unreachable, no default
      // engine, …) instead of a generic guess.
      throw new BadRequestException(`Download failed: ${(e as Error).message}`);
    }
    if (!torrentHash) {
      throw new BadRequestException('Download failed — the engine did not accept the torrent');
    }
    const updated = await this.prisma.rssHistory.update({
      where: { id: historyId },
      data: { downloaded: true },
    });
    return { ...updated, torrentHash };
  }

  /**
   * Re-evaluate stored feed history for a rule and download any matches that
   * were not grabbed yet. Runs when match preferences change so items that
   * arrived before the preference existed are still picked up. History rows
   * carry no size, so size rules are skipped (the engine treats unknown size
   * as passing); everything else is evaluated exactly as during polling.
   */
  async backfillHistory(
    ruleId: string,
  ): Promise<{ evaluated: number; matched: number; downloaded: number }> {
    const summary = { evaluated: 0, matched: 0, downloaded: 0 };
    const rule = await this.prisma.rssRule.findUnique({
      where: { id: ruleId },
      include: { matchCandidates: true },
    });
    if (!rule || !rule.isEnabled) return summary;

    const candidates = (rule.matchCandidates ?? []).map((c) => this.toEngineCandidate(c));
    const feedIds = ruleTargetFeedIds(rule, rule.matchCandidates);
    if (feedIds.length === 0) return summary;

    // Only items not already grabbed; newest first, bounded for safety.
    const history = await this.prisma.rssHistory.findMany({
      where: { feedId: { in: feedIds }, downloaded: false },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    summary.evaluated = history.length;

    // Resolve magnets for legacy rows (no stored magnet) from the live feed,
    // built lazily on first need and reused for the whole batch — mirrors the
    // manual download button so the "Create rule" flow grabs via magnet too.
    let feedMagnets: Map<string, string> | null = null;
    const magnetFor = async (h: {
      magnet: string | null;
      itemGuid: string;
      title: string;
      link: string;
      id: string;
    }): Promise<string | null> => {
      if (h.magnet) return h.magnet;
      if (!feedMagnets) {
        feedMagnets = await this.buildFeedMagnetMap(feedIds).catch(() => new Map());
      }
      const found =
        feedMagnets.get(h.itemGuid) || feedMagnets.get(h.title) || feedMagnets.get(h.link) || null;
      if (found) {
        await this.prisma.rssHistory
          .update({ where: { id: h.id }, data: { magnet: found } })
          .catch(() => undefined);
      }
      return found;
    };

    for (const h of history) {
      const ctx: ItemContext = { title: h.title, feedId: h.feedId };
      const evaluation = candidates.length
        ? evaluatePreferenceList(candidates, ctx)
        : this.legacyEvaluation(rule, h.title);
      if (!evaluation.matched) continue;
      summary.matched += 1;

      let action: 'download' | 'none' = 'none';
      let torrentHash: string | null = null;
      // Prefer a magnet (stored or resolved from the feed) over a stale
      // .torrent URL that points at one host and can 404.
      const dl = (rule.autoDownload ? await magnetFor(h) : h.magnet) || h.link;
      if (rule.autoDownload && dl) {
        torrentHash = await this.download(dl, rule.savePath ?? undefined);
        if (torrentHash !== null) {
          summary.downloaded += 1;
          action = 'download';
        }
      }

      // Reflect the match (and any grab) back onto the history row so it is
      // not re-downloaded on a later backfill or poll.
      await this.prisma.rssHistory
        .update({
          where: { id: h.id },
          data: { matched: true, downloaded: action === 'download' ? true : undefined },
        })
        .catch(() => undefined);

      if (candidates.length) {
        await this.recordEvaluation(rule.id, h.itemGuid, evaluation, action, torrentHash);
      }

      // Bump stats on the winning candidate, mirroring processFeed.
      if (evaluation.matchedCandidateId) {
        await this.prisma.rssRuleMatchCandidate
          .update({
            where: { id: evaluation.matchedCandidateId },
            data: { lastMatchedAt: new Date(), matchCount: { increment: 1 } },
          })
          .catch(() => undefined);
      }
    }

    if (summary.downloaded > 0) {
      this.logger.log(
        `RSS backfill for rule ${rule.name}: grabbed ${summary.downloaded} of ${summary.matched} matched history item(s)`,
      );
    }
    return summary;
  }

  matchHistory(ruleId: string) {
    return this.prisma.rssRuleMatchEvaluation.findMany({
      where: { rssRuleId: ruleId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // --- smart match builder ----------------------------------------------

  /** Analyze a pasted release name into metadata + recommended candidates. */
  analyzeSmartMatch(torrentName: string) {
    if (!torrentName || !torrentName.trim()) {
      throw new BadRequestException('torrentName is required');
    }
    const meta = parseTorrentName(torrentName);
    const recommendedCandidates = buildSmartCandidates(meta);
    return {
      sourceName: torrentName.trim(),
      parsedMetadata: meta,
      confidenceScore: meta.confidence,
      recommendedCandidates,
      explanations: meta.explanations,
      warnings: meta.warnings,
    };
  }

  private generatedToEngine(c: any, i: number): MatchCandidateInput {
    return {
      id: String(i + 1),
      name: c.name ?? `Candidate ${i + 1}`,
      priorityOrder: i + 1,
      enabled: c.enabled ?? true,
      matchType: c.matchType,
      pattern: c.pattern ?? '',
      requiredTerms: Array.isArray(c.requiredTerms) ? c.requiredTerms : [],
      excludedTerms: Array.isArray(c.excludedTerms) ? c.excludedTerms : [],
      qualityRules: c.qualityRules ?? {},
      sizeRules: c.sizeRules ?? {},
      feedScope: c.feedScope ?? {},
    };
  }

  /** Apply (possibly user-edited) candidates to a rule and store the template. */
  async applySmartMatch(ruleId: string, body: any) {
    await this.assertRule(ruleId);
    const candidates: GeneratedCandidate[] = Array.isArray(body.recommendedCandidates)
      ? body.recommendedCandidates
      : [];
    if (candidates.length === 0) {
      throw new BadRequestException('No candidates to apply');
    }
    for (const c of candidates) {
      if (!c.matchType || !MATCH_TYPES.includes(c.matchType)) {
        throw new BadRequestException(`Invalid match type: ${c.matchType}`);
      }
    }

    const last = await this.prisma.rssRuleMatchCandidate.findFirst({
      where: { rssRuleId: ruleId },
      orderBy: { priorityOrder: 'desc' },
    });
    let order = last ? last.priorityOrder : 0;

    for (const c of candidates) {
      order += 1;
      await this.prisma.rssRuleMatchCandidate.create({
        data: {
          rssRuleId: ruleId,
          name: c.name ?? `Candidate ${order}`,
          description: c.description ?? null,
          enabled: (c as any).enabled ?? true,
          matchType: c.matchType,
          pattern: c.pattern ?? null,
          requiredTerms: (Array.isArray(c.requiredTerms) ? c.requiredTerms : []) as object,
          excludedTerms: (Array.isArray(c.excludedTerms) ? c.excludedTerms : []) as object,
          qualityRules: (c.qualityRules ?? {}) as object,
          sizeRules: ((c as any).sizeRules ?? {}) as object,
          feedScope: ((c as any).feedScope ?? {}) as object,
          priorityOrder: order,
        },
      });
    }

    await this.prisma.rssSmartMatchTemplate.create({
      data: {
        rssRuleId: ruleId,
        sourceName: body.sourceName ?? body.parsedMetadata?.title ?? 'pasted release',
        parsedMetadata: (body.parsedMetadata ?? {}) as object,
        generatedCandidates: candidates as unknown as object,
        confidenceScore:
          body.confidenceScore ?? body.parsedMetadata?.confidence ?? 0,
        userEdited: Boolean(body.userEdited),
      },
    });

    // Newly-applied preferences may match items already in the feed history.
    await this.backfillHistory(ruleId).catch((e) =>
      this.logger.warn(`RSS backfill failed: ${e.message}`),
    );

    return this.listCandidates(ruleId);
  }

  /** Build candidates from a pasted name and test them against sample titles. */
  async testSmartMatch(body: any) {
    const torrentName = body.torrentName;
    if (!torrentName || !torrentName.trim()) {
      throw new BadRequestException('torrentName is required');
    }
    const meta = parseTorrentName(torrentName);
    const generated = buildSmartCandidates(meta);
    const engineCandidates = generated.map((c, i) => this.generatedToEngine(c, i));

    let titles: string[] = Array.isArray(body.sampleItems)
      ? body.sampleItems.filter((t: unknown) => typeof t === 'string')
      : [];
    if (body.rssFeedId) {
      const hist = await this.prisma.rssHistory.findMany({
        where: { feedId: body.rssFeedId },
        orderBy: { createdAt: 'desc' },
        take: 30,
      });
      titles = [...titles, ...hist.map((h) => h.title)];
    }
    if (titles.length === 0) titles = [torrentName.trim()];

    const results = titles.map((title) => ({
      title,
      ...evaluatePreferenceList(engineCandidates, { title }),
    }));
    const sourceEval = evaluatePreferenceList(engineCandidates, {
      title: torrentName.trim(),
    });

    return {
      parsedMetadata: meta,
      candidates: generated,
      results,
      recommendation: {
        matchedCandidateId: sourceEval.matchedCandidateId,
        matchedCandidateName:
          generated[Number(sourceEval.matchedCandidateId) - 1]?.name ?? null,
        action: sourceEval.action,
      },
    };
  }

  /** Poll feeds whose refresh interval has elapsed. */
  @Interval(60_000)
  async pollDue(): Promise<void> {
    const feeds = await this.prisma.rssFeed.findMany({
      where: { isEnabled: true },
      include: { rules: { where: { isEnabled: true } } },
    });
    const now = Date.now();
    for (const feed of feeds) {
      const due =
        !feed.lastFetchedAt ||
        now - feed.lastFetchedAt.getTime() >= feed.refreshInterval * 1000;
      if (due) await this.processFeed(feed).catch((e) =>
        this.logger.warn(`RSS feed ${feed.name} failed: ${e.message}`),
      );
    }
  }

  private parseSize(item: any): number | null {
    const len = item?.enclosure?.length;
    const n = len != null ? Number(len) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Pull a magnet URI out of a feed item. Direct `.torrent` enclosure URLs
   * point at a single host that can 404 / expire; a magnet resolves through
   * DHT + trackers instead, so we prefer it for downloads. Checks the usual
   * link fields, Torznab/Newznab attrs, dedicated magnet elements, then any
   * magnet embedded in the item's description/content as a last resort.
   */
  private extractMagnet(item: any): string | null {
    const isMagnet = (v: unknown): v is string =>
      typeof v === 'string' && v.startsWith('magnet:');

    for (const v of [item?.enclosure?.url, item?.link, item?.guid]) {
      if (isMagnet(v)) return v;
    }

    const attrs = item?.torznabAttrs;
    if (Array.isArray(attrs)) {
      for (const a of attrs) {
        const name = a?.$?.name ?? a?.name;
        const value = a?.$?.value ?? a?.value;
        if (name === 'magneturl' && isMagnet(value)) return value;
      }
    }

    for (const v of [
      item?.torrentMagnet,
      item?.['torrent:magnetURI'],
      item?.magneturl,
      item?.magnetURI,
      item?.magnet,
    ]) {
      if (isMagnet(v)) return v;
    }

    const text = [
      item?.content,
      item?.['content:encoded'],
      item?.contentSnippet,
      item?.description,
      item?.summary,
    ]
      .filter((s: unknown): s is string => typeof s === 'string')
      .join(' ');
    const m = /magnet:\?xt=urn:[a-z0-9]+:[^\s"'<>&]+/i.exec(text);
    return m ? m[0] : null;
  }

  /**
   * Re-fetch a history item's feed and find its magnet by matching guid/link/
   * title — used when the stored row predates magnet capture. Returns null if
   * the feed is gone or the item has rotated out of it.
   */
  private async resolveMagnetFromFeed(row: {
    feedId: string;
    itemGuid: string;
    title: string;
    link: string;
  }): Promise<string | null> {
    const feed = await this.prisma.rssFeed.findUnique({ where: { id: row.feedId } });
    if (!feed) return null;
    const parsed = await this.parser.parseURL(feed.url);
    for (const it of parsed.items ?? []) {
      const guid = it.guid ?? it.link ?? it.title ?? '';
      if (guid === row.itemGuid || it.title === row.title || it.link === row.link) {
        return this.extractMagnet(it);
      }
    }
    return null;
  }

  /**
   * Fetch the given feeds once and index every item's magnet by guid/link/title
   * — so a batch (backfill) can resolve magnets for many legacy rows with a
   * single fetch per feed instead of one fetch per row.
   */
  private async buildFeedMagnetMap(feedIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const feeds = await this.prisma.rssFeed.findMany({ where: { id: { in: feedIds } } });
    for (const feed of feeds) {
      let parsed;
      try {
        parsed = await this.parser.parseURL(feed.url);
      } catch {
        continue; // a feed that fails to fetch just contributes nothing
      }
      for (const it of parsed.items ?? []) {
        const magnet = this.extractMagnet(it);
        if (!magnet) continue;
        for (const key of [it.guid, it.link, it.title]) {
          if (typeof key === 'string' && key) map.set(key, magnet);
        }
      }
    }
    return map;
  }

  /** Hand a link to the default engine. Throws the real reason on failure. */
  private async addToEngine(link: string, savePath?: string): Promise<string | null> {
    const provider = await this.registry.getDefault();
    if (link.startsWith('magnet:')) return provider.addMagnet(link, { savePath });
    return provider.addTorrentURL(link, { savePath });
  }

  /**
   * Best-effort download for the automatic paths (poll / backfill): swallows
   * errors and returns null so one dead link never aborts a batch. The manual
   * per-item grab uses {@link addToEngine} directly so the user sees why.
   */
  private async download(link: string, savePath?: string): Promise<string | null> {
    try {
      return await this.addToEngine(link, savePath);
    } catch (e) {
      this.logger.warn(`RSS auto-download failed: ${(e as Error).message}`);
      return null;
    }
  }

  async processFeed(feed: any): Promise<{ newItems: number; downloaded: number }> {
    // Load rules with their candidates fresh so evaluation always sees the
    // current preference lists. A rule runs against this feed when the feed is
    // its owner OR an enabled candidate scopes to it — so load every enabled
    // rule and keep those that target this feed. (Rule counts are tiny.)
    const enabledRules = await this.prisma.rssRule.findMany({
      where: { isEnabled: true },
      include: { matchCandidates: true },
    });
    const rules = enabledRules.filter((rule) =>
      ruleTargetFeedIds(rule, rule.matchCandidates).includes(feed.id),
    );
    const parsed = await this.parser.parseURL(feed.url);

    let newItems = 0;
    let grabbed = 0;

    for (const item of parsed.items ?? []) {
      const guid = item.guid ?? item.link ?? item.title ?? '';
      if (!guid) continue;
      const exists = await this.prisma.rssHistory.findUnique({
        where: { feedId_itemGuid: { feedId: feed.id, itemGuid: guid } },
      });
      if (exists) continue; // each feed item is processed once

      const title = item.title ?? '';
      const link = (item as any).enclosure?.url ?? item.link ?? '';
      const magnet = this.extractMagnet(item);
      const dl = magnet || link; // prefer the magnet (DHT/trackers, not one host)
      const sizeBytes = this.parseSize(item);
      const ctx: ItemContext = { title, feedId: feed.id, sizeBytes };

      let downloaded = false; // at most one download per item across all rules
      let anyMatch = false;

      for (const rule of rules) {
        const candidates = (rule.matchCandidates ?? []).map((c) =>
          this.toEngineCandidate(c),
        );

        // Evaluate preference list (new engine) or fall back to legacy regex.
        const evaluation = candidates.length
          ? evaluatePreferenceList(candidates, ctx)
          : this.legacyEvaluation(rule, title);

        if (!evaluation.matched) {
          if (candidates.length) {
            await this.recordEvaluation(rule.id, guid, evaluation, 'none', null);
          }
          continue;
        }

        anyMatch = true;
        let action: 'download' | 'skipped_duplicate' | 'none' = 'none';
        let torrentHash: string | null = null;

        if (rule.autoDownload && dl) {
          if (!downloaded) {
            torrentHash = await this.download(dl, rule.savePath ?? undefined);
            downloaded = torrentHash !== null;
            action = downloaded ? 'download' : 'none';
          } else {
            // Another rule already pulled this item — never download twice.
            action = 'skipped_duplicate';
          }
        }

        // Bump stats on the winning candidate.
        if (evaluation.matchedCandidateId) {
          await this.prisma.rssRuleMatchCandidate
            .update({
              where: { id: evaluation.matchedCandidateId },
              data: { lastMatchedAt: new Date(), matchCount: { increment: 1 } },
            })
            .catch(() => undefined);
        }

        if (candidates.length) {
          await this.recordEvaluation(rule.id, guid, evaluation, action, torrentHash);
        }
      }

      await this.prisma.rssHistory.create({
        data: { feedId: feed.id, itemGuid: guid, title, link, magnet, matched: anyMatch, downloaded },
      });
      newItems += 1;
      if (downloaded) grabbed += 1;
    }

    await this.prisma.rssFeed.update({
      where: { id: feed.id },
      data: { lastFetchedAt: new Date() },
    });

    return { newItems, downloaded: grabbed };
  }

  /**
   * Fetch and process a feed immediately, ignoring its refresh schedule — the
   * "fetch now" action. Populates history (and fires auto-downloads for
   * matching rules) so a freshly-added feed doesn't have to wait for the poll.
   */
  async refreshFeed(id: string): Promise<{ newItems: number; downloaded: number }> {
    const feed = await this.prisma.rssFeed.findUnique({ where: { id } });
    if (!feed) throw new NotFoundException(`Unknown RSS feed: ${id}`);
    try {
      return await this.processFeed(feed);
    } catch (e) {
      throw new BadRequestException(
        `Could not fetch feed: ${(e as Error).message}`,
      );
    }
  }

  private async recordEvaluation(
    ruleId: string,
    itemGuid: string,
    evaluation: ReturnType<typeof evaluatePreferenceList>,
    action: 'download' | 'skipped_duplicate' | 'none',
    torrentHash: string | null,
  ): Promise<void> {
    const result = !evaluation.matched
      ? 'no_match'
      : action === 'skipped_duplicate'
        ? 'skipped_duplicate'
        : 'matched';
    await this.prisma.rssRuleMatchEvaluation
      .create({
        data: {
          rssRuleId: ruleId,
          rssItemId: itemGuid,
          matchedCandidateId: evaluation.matchedCandidateId,
          matchedCandidatePriority: evaluation.matchedCandidatePriority,
          result,
          actionTaken: action,
          torrentHash,
          evaluationTrace: {
            parsed: evaluation.parsed,
            candidates: evaluation.candidates,
          } as object,
        },
      })
      .catch((e) => this.logger.warn(`Evaluation log failed: ${e.message}`));
  }

  /** Legacy include/exclude regex rule wrapped in the engine's result shape. */
  private legacyEvaluation(
    rule: any,
    title: string,
  ): ReturnType<typeof evaluatePreferenceList> {
    // A rule with no match candidates AND no include/exclude regex has no filter
    // whatsoever. Defaulting `matched` to true here would auto-download every
    // item in the feed — almost never the intent. Treat such a rule as matching
    // nothing; to intentionally grab a whole feed, set includeRegex to `.*`.
    if (!rule.includeRegex && !rule.excludeRegex) {
      return {
        matched: false,
        matchedCandidateId: null,
        matchedCandidatePriority: null,
        action: 'none',
        candidates: [],
        parsed: { languages: [], repack: false, proper: false, badQuality: [] },
      };
    }
    let matched = true;
    try {
      if (rule.includeRegex && !new RegExp(rule.includeRegex, 'i').test(title)) matched = false;
      if (rule.excludeRegex && new RegExp(rule.excludeRegex, 'i').test(title)) matched = false;
    } catch {
      matched = false;
    }
    return {
      matched,
      matchedCandidateId: null,
      matchedCandidatePriority: null,
      action: matched ? 'download' : 'none',
      candidates: [],
      parsed: { languages: [], repack: false, proper: false, badQuality: [] },
    };
  }

  /** Best-effort conversion of a simple text pattern to a regex (for the UI). */
  convertToRegex(text: string): string {
    return toRegexPattern(text);
  }
}

@ApiTags('rss')
@ApiBearerAuth()
@Controller('rss')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RssController {
  constructor(private readonly rss: RssService) {}

  @Get('feeds')
  @RequirePermissions(PERMISSIONS.RSS_VIEW)
  feeds() {
    return this.rss.listFeeds();
  }
  @Post('feeds')
  @RequirePermissions(PERMISSIONS.RSS_MANAGE)
  createFeed(@Body() dto: CreateFeedDto) {
    return this.rss.createFeed(dto);
  }
  @Patch('feeds/:id')
  @RequirePermissions(PERMISSIONS.RSS_MANAGE)
  updateFeed(@Param('id') id: string, @Body() dto: UpdateFeedDto) {
    return this.rss.updateFeed(id, dto);
  }
  @Delete('feeds/:id')
  @RequirePermissions(PERMISSIONS.RSS_MANAGE)
  deleteFeed(@Param('id') id: string) {
    return this.rss.deleteFeed(id);
  }
  @Get('feeds/:id/history')
  @RequirePermissions(PERMISSIONS.RSS_VIEW)
  history(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.rss.history(id, Number(page) || 1, Number(pageSize) || 25);
  }
  @Post('feeds/:id/refresh')
  @RequirePermissions(PERMISSIONS.RSS_MANAGE)
  refreshFeed(@Param('id') id: string) {
    return this.rss.refreshFeed(id);
  }
  @Post('rules')
  @RequirePermissions(PERMISSIONS.RSS_MANAGE)
  createRule(@Body() dto: CreateRuleDto) {
    return this.rss.createRule(dto);
  }
  @Patch('rules/:id')
  @RequirePermissions(PERMISSIONS.RSS_MANAGE)
  updateRule(@Param('id') id: string, @Body() dto: UpdateRuleDto) {
    return this.rss.updateRule(id, dto);
  }
  @Delete('rules/:id')
  @RequirePermissions(PERMISSIONS.RSS_MANAGE)
  deleteRule(@Param('id') id: string) {
    return this.rss.deleteRule(id);
  }

  @Get('rules-export')
  @RequirePermissions(PERMISSIONS.RSS_VIEW)
  exportRules() {
    return this.rss.exportRules();
  }
  @Post('rules-import')
  @RequirePermissions(PERMISSIONS.RSS_MANAGE)
  importRules(@Req() req: Request) {
    return this.rss.importRules(req.body ?? {});
  }

  // --- match candidates (preference list) --------------------------------

  @Get('rules/:id/match-candidates')
  @RequirePermissions(PERMISSIONS.RSS_VIEW)
  listCandidates(@Param('id') id: string) {
    return this.rss.listCandidates(id);
  }

  @Post('rules/:id/match-candidates')
  @RequirePermissions(PERMISSIONS.RSS_MANAGE)
  createCandidate(@Param('id') id: string, @Req() req: Request) {
    return this.rss.createCandidate(id, req.body ?? {});
  }

  @Post('rules/:id/match-candidates/reorder')
  @RequirePermissions(PERMISSIONS.RSS_MANAGE)
  reorderCandidates(@Param('id') id: string, @Req() req: Request) {
    return this.rss.reorderCandidates(id, (req.body ?? {}).orderedIds);
  }

  @Patch('rules/:id/match-candidates/:candidateId')
  @RequirePermissions(PERMISSIONS.RSS_MANAGE)
  updateCandidate(
    @Param('id') id: string,
    @Param('candidateId') candidateId: string,
    @Req() req: Request,
  ) {
    return this.rss.updateCandidate(id, candidateId, req.body ?? {});
  }

  @Delete('rules/:id/match-candidates/:candidateId')
  @RequirePermissions(PERMISSIONS.RSS_MANAGE)
  deleteCandidate(
    @Param('id') id: string,
    @Param('candidateId') candidateId: string,
  ) {
    return this.rss.deleteCandidate(id, candidateId);
  }

  @Post('rules/:id/test-match')
  @RequirePermissions(PERMISSIONS.RSS_VIEW)
  testMatch(@Param('id') id: string, @Req() req: Request) {
    return this.rss.testMatch(id, req.body ?? {});
  }

  @Post('rules/:id/test-preference-list')
  @RequirePermissions(PERMISSIONS.RSS_VIEW)
  testPreferenceList(@Param('id') id: string, @Req() req: Request) {
    return this.rss.testPreferenceList(id, req.body ?? {});
  }

  @Post('rules/:id/test-history')
  @RequirePermissions(PERMISSIONS.RSS_VIEW)
  testHistory(@Param('id') id: string) {
    return this.rss.testAgainstHistory(id);
  }

  @Post('rules/:id/backfill')
  @RequirePermissions(PERMISSIONS.RSS_MANAGE)
  backfill(@Param('id') id: string) {
    return this.rss.backfillHistory(id);
  }

  @Post('history/:id/download')
  @RequirePermissions(PERMISSIONS.RSS_MANAGE)
  downloadHistoryItem(@Param('id') id: string) {
    return this.rss.downloadHistoryItem(id);
  }

  @Get('rules/:id/match-history')
  @RequirePermissions(PERMISSIONS.RSS_VIEW)
  matchHistory(@Param('id') id: string) {
    return this.rss.matchHistory(id);
  }

  @Post('convert-to-regex')
  @RequirePermissions(PERMISSIONS.RSS_VIEW)
  convertToRegex(@Req() req: Request) {
    const text = (req.body ?? {}).text;
    return { pattern: this.rss.convertToRegex(typeof text === 'string' ? text : '') };
  }

  // --- Smart Match Builder ----------------------------------------------

  @Post('smart-match/analyze')
  @RequirePermissions(PERMISSIONS.RSS_VIEW)
  analyzeSmartMatch(@Req() req: Request) {
    return this.rss.analyzeSmartMatch((req.body ?? {}).torrentName);
  }

  @Post('smart-match/test')
  @RequirePermissions(PERMISSIONS.RSS_VIEW)
  testSmartMatch(@Req() req: Request) {
    return this.rss.testSmartMatch(req.body ?? {});
  }

  @Post('rules/:id/apply-smart-match')
  @RequirePermissions(PERMISSIONS.RSS_MANAGE)
  applySmartMatch(@Param('id') id: string, @Req() req: Request) {
    return this.rss.applySmartMatch(id, req.body ?? {});
  }
}

@Module({
  providers: [RssService],
  controllers: [RssController],
})
export class RssModule {}
