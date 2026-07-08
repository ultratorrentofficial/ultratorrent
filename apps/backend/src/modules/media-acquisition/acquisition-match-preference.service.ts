import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type {
  AcquisitionMatchCandidate,
  MediaAcquisitionWatchlistItem,
  Prisma,
  RssRuleMatchCandidate,
} from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { parseTorrentName } from '../rss/torrent-name-parser';
import {
  evaluatePreferenceList,
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
 * Resolves and applies the auto-download match preferences for a monitored show,
 * reusing the RSS match-engine model (ranked candidate list + `qualityRules` +
 * `sizeRules`). This is what decides *which* indexer release the missing-episode
 * bridge grabs — replacing the flat quality-profile scorer, and adding a real
 * size cap the profile never had.
 *
 * Phase 1: preferences come from the global `AcquisitionMatchCandidate` defaults.
 * A later phase resolves a per-show RSS rule's candidates first (via
 * `MediaAcquisitionWatchlistItem.rssRuleId`) and only falls back to the defaults.
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
   * Resolve the preference list for a monitored show: if it's linked to an RSS
   * rule (`rssRuleId`), use that rule's enabled match candidates so the show is
   * auto-downloaded with the same preferences its RSS rule uses; otherwise fall
   * back to the global defaults.
   */
  async resolveCandidates(item: MediaAcquisitionWatchlistItem): Promise<MatchCandidateInput[]> {
    if (item.rssRuleId) {
      const rows = await this.prisma.rssRuleMatchCandidate.findMany({
        where: { rssRuleId: item.rssRuleId, enabled: true },
        orderBy: { priorityOrder: 'asc' },
      });
      if (rows.length) return rows.map((r) => this.toRssInput(r));
    }
    return this.defaults();
  }

  /**
   * From indexer results for a wanted episode, pick the release to grab: filter
   * to the exact SxxEyy (and a loose show-title match), gate each survivor
   * through the preference list (quality + size), and prefer the one that
   * matches the highest-priority candidate — tie-broken by magnet, then seeders.
   * Returns null when nothing passes the preferences (e.g. all over the size cap).
   */
  select(
    candidates: IndexerCandidate[],
    prefs: MatchCandidateInput[],
    showTitle: string,
    season: number,
    episode: number,
  ): SelectedRelease | null {
    if (prefs.length === 0) return null;
    const show = norm(showTitle);
    const scored: SelectedRelease[] = [];

    for (const c of candidates) {
      if (!c.downloadUrl) continue;
      const parsed = parseTorrentName(c.title);
      if (parsed.season !== season || parsed.episode !== episode) continue;
      const t = norm(parsed.title ?? c.title);
      if (!(t.includes(show) || show.includes(t))) continue;

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
