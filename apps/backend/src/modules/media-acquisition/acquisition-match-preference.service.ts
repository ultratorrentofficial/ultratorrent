import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type {
  AcquisitionMatchCandidate,
  MediaAcquisitionProfile,
  MediaAcquisitionWatchlistItem,
  Prisma,
  RssRuleMatchCandidate,
} from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { parseTorrentName } from '../rss/torrent-name-parser';
import {
  evaluatePreferenceList,
  showTitleMatch,
  type MatchCandidateInput,
  type MatchType,
  type QualityRules,
  type SizeRules,
} from '../rss/match-engine';
import type { IndexerCandidate } from '../indexers/torznab-client';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/** A selected release plus why the match-preference list accepted it. */
export interface SelectedRelease {
  candidate: IndexerCandidate;
  matchedPriority: number;
  reason: string;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * A trailing year on the *monitored* title ("Sugar 2024", "Rise (2017)").
 *
 * {@link showTitleMatch} bounds the release's title region at a non-leading year —
 * "Sugar 2024 S02E03" has the pure title "sugar" — so a year left on the pattern side
 * could never match and would silence the show entirely. A *leading* year is kept: it
 * can be the whole title ("1883", "2020").
 */
const TRAILING_YEAR = /\s*\(?\b(?:19|20)\d{2}\b\)?\s*$/;
function showPattern(title: string): string {
  const stripped = title.replace(TRAILING_YEAR, '').trim();
  return stripped || title.trim();
}

/** Resolution preference, best first. Orders profiles into preferred → fallback tiers. */
const RESOLUTION_RANK = ['2160p', '1440p', '1080p', '720p', '480p'];

/** Watchlist item `type` → the `mediaType` its profiles are filed under. */
function profileMediaType(itemType: string): string {
  if (itemType === 'anime') return 'anime';
  if (itemType === 'movie' || itemType === 'movie_collection') return 'movie';
  return 'tv';
}

/**
 * Resolves and applies the auto-download match preferences for a monitored show,
 * reusing the RSS match-engine model (ranked candidate list + `qualityRules` +
 * `sizeRules`). This is what decides *which* indexer release the missing-episode
 * bridge grabs, and it adds a real size cap the quality profile never had.
 *
 * Preference sources, in order — first one that yields candidates wins:
 *   1. the show's **RSS rule** match candidates (linked via `rssRuleId`, or found
 *      by a rule whose name matches the show title — most monitored shows have a
 *      rule that simply isn't wired to the watchlist item);
 *   2. the **auto-download profiles** for the media type, each profile becoming
 *      one tier (ranked by `preferredResolution`, best first), carrying its
 *      `requiredTerms`/`excludedTerms` and preferred codec/source/resolution;
 *   3. the global `AcquisitionMatchCandidate` defaults.
 *
 * A profile's `requiredTerms`/`excludedTerms` were previously collected by the UI
 * but consulted by nothing, so an excluded term (e.g. "10bit") could not actually
 * keep a release out. Tier (2) is what makes that config load-bearing.
 */
@Injectable()
export class AcquisitionMatchPreferenceService implements OnModuleInit {
  private readonly logger = new Logger(AcquisitionMatchPreferenceService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.ensureSeeded().catch((err) =>
      this.logger.warn(`Could not seed default match preferences: ${(err as Error).message}`),
    );
  }

  private toInput(row: AcquisitionMatchCandidate): MatchCandidateInput {
    return {
      id: row.id,
      name: row.name,
      priorityOrder: row.priorityOrder,
      enabled: row.enabled,
      matchType: row.matchType as MatchType,
      pattern: row.pattern,
      requiredTerms: (row.requiredTerms as string[]) ?? [],
      excludedTerms: (row.excludedTerms as string[]) ?? [],
      qualityRules: (row.qualityRules as QualityRules) ?? {},
      sizeRules: (row.sizeRules as SizeRules) ?? {},
    };
  }

  /** The global default candidate list (enabled only), priority order. */
  async defaults(): Promise<MatchCandidateInput[]> {
    const rows = await this.prisma.acquisitionMatchCandidate.findMany({
      where: { enabled: true },
      orderBy: { priorityOrder: 'asc' },
    });
    return rows.map((r) => this.toInput(r));
  }

  private toRssInput(row: RssRuleMatchCandidate): MatchCandidateInput {
    return {
      id: row.id,
      name: row.name,
      priorityOrder: row.priorityOrder,
      enabled: row.enabled,
      matchType: row.matchType as MatchType,
      pattern: row.pattern,
      requiredTerms: (row.requiredTerms as string[]) ?? [],
      excludedTerms: (row.excludedTerms as string[]) ?? [],
      qualityRules: (row.qualityRules as QualityRules) ?? {},
      sizeRules: (row.sizeRules as SizeRules) ?? {},
      // feedScope intentionally omitted — acquisition candidates carry no feedId,
      // so a rule's feed scoping never filters an indexer release.
    };
  }

  /**
   * One profile → one preference tier. The profile's preferred codec/source/
   * resolution become `qualityRules`, and its required/excluded terms are carried
   * through verbatim so an excluded term actually rejects a release. `pattern` is
   * left empty: `smart_episode_match` with no pattern is a pass-through, and the
   * bridge has already narrowed results to the exact SxxEyy.
   */
  private profileToInput(row: MediaAcquisitionProfile, priorityOrder: number): MatchCandidateInput {
    const quality: QualityRules = {};
    if (row.preferredResolution) quality.resolution = row.preferredResolution;
    if (row.preferredCodec) quality.codec = row.preferredCodec;
    if (row.preferredSource) quality.source = row.preferredSource;
    return {
      id: row.id,
      name: row.name,
      priorityOrder,
      enabled: true,
      matchType: 'smart_episode_match',
      pattern: null,
      requiredTerms: (row.requiredTerms as string[] | null) ?? [],
      excludedTerms: (row.excludedTerms as string[] | null) ?? [],
      qualityRules: quality,
      // Profiles carry no size cap of their own — only the candidate lists do.
      sizeRules: {},
    };
  }

  /**
   * The enabled auto-download profiles for this item's media type, as ranked
   * tiers — best `preferredResolution` first (1080p before 720p), then oldest
   * first so the order is stable. A profile with an unknown/absent resolution
   * sorts last.
   */
  private async profileCandidates(item: MediaAcquisitionWatchlistItem): Promise<MatchCandidateInput[]> {
    const mediaType = profileMediaType(item.type);
    const rows = await this.prisma.mediaAcquisitionProfile.findMany({
      where: { enabled: true, mediaType: { in: [mediaType, 'any'] } },
      orderBy: { createdAt: 'asc' },
    });
    if (!rows.length) return [];
    const rank = (p: MediaAcquisitionProfile) => {
      const i = RESOLUTION_RANK.indexOf(p.preferredResolution ?? '');
      return i === -1 ? RESOLUTION_RANK.length : i;
    };
    return [...rows]
      .sort((a, b) => rank(a) - rank(b))
      .map((p, i) => this.profileToInput(p, i));
  }

  /**
   * Resolve the preference list for a monitored show. RSS match-preference
   * filters win when the show has any — by explicit `rssRuleId` link, else by an
   * RSS rule whose **name matches the show title** (the common case: the rule
   * exists but was never wired to the watchlist item). Falls back to the
   * auto-download profiles, then to the global defaults.
   */
  async resolveCandidates(item: MediaAcquisitionWatchlistItem): Promise<MatchCandidateInput[]> {
    const rss = await this.rssCandidates(item);
    if (rss.length) return rss;

    const profiles = await this.profileCandidates(item);
    if (profiles.length) return profiles;

    return this.defaults();
  }

  /**
   * A rule that carries no match candidates, only the legacy `includeRegex` /
   * `excludeRegex`, expressed as a single candidate.
   *
   * An RSS rule filters in one of two ways, and `rss.module.ts` picks exactly one:
   * its match candidates if it has any, else its include/exclude regex. This path
   * only ever read the candidates — so a legacy regex-only rule contributed
   * *nothing* here, `rssCandidates()` returned empty, and resolution fell through to
   * the profiles and then the global defaults. An operator's `excludeRegex` — an
   * explicit "never grab this" — was silently discarded, and the rule that was meant
   * to filter the show was replaced by a generic default.
   *
   * A rule with neither candidates nor regex has no filter at all; it yields null, so
   * the caller falls through rather than synthesising a match-everything candidate.
   */
  private legacyRuleCandidate(rule: {
    id: string;
    name: string;
    includeRegex: string | null;
    excludeRegex: string | null;
  }): MatchCandidateInput | null {
    if (!rule.includeRegex && !rule.excludeRegex) return null;
    return {
      id: rule.id,
      name: `${rule.name} (include/exclude regex)`,
      priorityOrder: 0,
      enabled: true,
      // `.*` when only an exclude is set: the rule admits everything it does not exclude.
      matchType: 'regex',
      pattern: rule.includeRegex ?? '.*',
      excludeRegex: rule.excludeRegex,
      requiredTerms: [],
      excludedTerms: [],
      qualityRules: {},
      sizeRules: {},
    };
  }

  /** The show's RSS rule preferences: its match candidates, else its legacy regexes. */
  private async rssCandidates(item: MediaAcquisitionWatchlistItem): Promise<MatchCandidateInput[]> {
    const forRule = async (ruleId: string): Promise<MatchCandidateInput[]> => {
      const rows = await this.prisma.rssRuleMatchCandidate.findMany({
        where: { rssRuleId: ruleId, enabled: true },
        orderBy: { priorityOrder: 'asc' },
      });
      if (rows.length) return rows.map((r) => this.toRssInput(r));

      // No candidates — fall back to the rule's own regexes, exactly as the RSS feed
      // path does (`rss.module.ts` → `legacyEvaluation`), instead of dropping the rule.
      const rule = await this.prisma.rssRule.findUnique({
        where: { id: ruleId },
        select: { id: true, name: true, includeRegex: true, excludeRegex: true },
      });
      const legacy = rule && this.legacyRuleCandidate(rule);
      return legacy ? [legacy] : [];
    };

    if (item.rssRuleId) {
      const linked = await forRule(item.rssRuleId);
      if (linked.length) return linked;
    }

    // No explicit link — find a rule named after the show. Compared on the same
    // normalization the title carries, so "House of the Dragon" matches its rule.
    const title = norm(item.title ?? '');
    if (!title) return [];
    const rules = await this.prisma.rssRule.findMany({ select: { id: true, name: true } });
    const match = rules.find((r) => norm(r.name) === title);
    if (!match) return [];

    return forRule(match.id);
  }

  /**
   * From indexer results for a wanted episode, pick the release to grab: filter
   * to the exact SxxEyy AND to the show itself, gate each survivor through the
   * preference list (quality + size), and prefer the one that matches the
   * highest-priority candidate — tie-broken by magnet, then seeders.
   * Returns null when nothing passes the preferences (e.g. all over the size cap).
   *
   * Show identity is enforced HERE, as a precondition, and not left to the
   * preference list. The two are different questions — "is this release for the show
   * I asked for?" versus "which of these releases do I prefer?" — and the preference
   * list cannot answer the first: profile- and default-derived candidates carry
   * `pattern: null` (a deliberate pass-through), and a rule's candidates may be
   * quality-only. So nothing downstream re-checks the title.
   *
   * This gate used to be a bidirectional substring test
   * (`t.includes(show) || show.includes(t)`), which accepted any release whose title
   * merely *contained* the show's name, or was contained BY it. On a real library that
   * silently mis-grabbed 132 of 714 episodes (18.5%): "Rise" pulled in "The Pendragon
   * Cycle Rise of the Merlin", "90 Day Fiance" pulled in "90 Day Fiance Before the 90
   * Days", "ted" pulled in "Ted Lasso". {@link showTitleMatch} instead requires the
   * release's *pure title* — its show-title region, minus a trailing year and the
   * quality tail — to equal the monitored title token-for-token, which is the same
   * rule the RSS engine applies to `smart_episode_match`.
   */
  select(
    candidates: IndexerCandidate[],
    prefs: MatchCandidateInput[],
    showTitle: string,
    season: number,
    episode: number,
    titleAliases: string[] = [],
  ): SelectedRelease | null {
    if (prefs.length === 0) return null;
    // The monitored title plus any alias it is released under. Each is anchored with
    // the SAME token-equality rule, so an alias widens *which* titles count as this
    // show without ever loosening the comparison: "Riverdale" + alias "Riverdale US"
    // accepts both spellings and still rejects "Riverdale Chronicles".
    const patterns = [showTitle, ...titleAliases]
      .map((t) => showPattern(t ?? ''))
      .filter((t) => t.length > 0);
    if (patterns.length === 0) return null;
    const scored: SelectedRelease[] = [];

    for (const c of candidates) {
      if (!c.downloadUrl) continue;
      const parsed = parseTorrentName(c.title);
      if (parsed.season !== season || parsed.episode !== episode) continue;
      // Anchored against the RAW release name: showTitleMatch does its own
      // show-region extraction, and is stricter than the parser's title guess.
      if (!patterns.some((p) => showTitleMatch(p, c.title))) continue;

      const res = evaluatePreferenceList(prefs, { title: c.title, sizeBytes: c.sizeBytes ?? null });
      if (!res.matched) continue;
      const matched = res.candidates.find((r) => r.result === 'matched');
      scored.push({
        candidate: c,
        matchedPriority: res.matchedCandidatePriority ?? Number.MAX_SAFE_INTEGER,
        reason: `matched “${matched?.name ?? 'preference'}”`,
      });
    }

    if (scored.length === 0) return null;
    const magnetRank = (c: IndexerCandidate) => (c.downloadUrl?.startsWith('magnet:') ? 0 : 1);
    scored.sort(
      (a, b) =>
        a.matchedPriority - b.matchedPriority ||
        magnetRank(a.candidate) - magnetRank(b.candidate) ||
        (b.candidate.seeders ?? -1) - (a.candidate.seeders ?? -1),
    );
    return scored[0];
  }

  // --- CRUD for the global defaults ----------------------------------------

  async list() {
    return this.prisma.acquisitionMatchCandidate.findMany({ orderBy: { priorityOrder: 'asc' } });
  }

  async create(data: Prisma.AcquisitionMatchCandidateCreateInput) {
    return this.prisma.acquisitionMatchCandidate.create({ data });
  }

  async update(id: string, data: Prisma.AcquisitionMatchCandidateUpdateInput) {
    return this.prisma.acquisitionMatchCandidate.update({ where: { id }, data });
  }

  async remove(id: string) {
    await this.prisma.acquisitionMatchCandidate.delete({ where: { id } });
    return { id, deleted: true };
  }

  /**
   * Seed a sensible default preference list once, if none exists: prefer a small
   * x265 1080p (≤1 GB), then a smaller 720p x265 (≤700 MB). `smart_episode_match`
   * with no pattern is a pass-through, so these candidates gate only on
   * quality + size — the bridge already narrows to the exact episode.
   */
  async ensureSeeded(): Promise<void> {
    const count = await this.prisma.acquisitionMatchCandidate.count();
    if (count > 0) return;
    await this.prisma.acquisitionMatchCandidate.createMany({
      data: [
        {
          priorityOrder: 0,
          name: '1080p x265 (≤1 GB)',
          matchType: 'smart_episode_match',
          qualityRules: { resolution: '1080p', codec: 'x265' } as object,
          sizeRules: { maxBytes: 1 * GB } as object,
        },
        {
          priorityOrder: 1,
          name: '720p x265 (≤700 MB)',
          matchType: 'smart_episode_match',
          qualityRules: { resolution: '720p', codec: 'x265' } as object,
          sizeRules: { maxBytes: 700 * MB } as object,
        },
      ],
    });
    this.logger.log('Seeded default acquisition match preferences (1080p/720p x265, size-capped)');
  }
}
