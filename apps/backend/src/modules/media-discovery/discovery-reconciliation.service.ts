import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { canonicalizeTitle, sameCanonicalTitle } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Finding — and safely merging — shows that are being monitored twice.
 *
 * The identity gate stops NEW duplicates. It cannot help with the ones already
 * here: "The Terminal List" and "The Terminal List (2022)" are two watchlist
 * entries, two rules and possibly two intake folders, created before anything
 * checked. This finds them and proposes a merge.
 *
 * Three rules shape every decision below.
 *
 * **1. Nothing is merged without a person.** Detection is a report. Grouping by
 * title is a hint and hints are wrong sometimes, and the cost of being wrong is
 * somebody's monitoring configuration.
 *
 * **2. A loser is ARCHIVED, never deleted.** Four tables hang off a watchlist
 * item — `WantedEpisode`, `WantedMovie`, `MediaAcquisitionEvaluation`,
 * `MediaAcquisitionHistory` — and `WantedEpisode` is unique on
 * `(watchlistItemId, seasonNumber, episodeNumber)`. Reparenting that history onto
 * the keeper would collide on every episode both entries know about, and
 * resolving those collisions means discarding rows. Archiving keeps every row
 * exactly where it is, keeps the history readable, and is reversible by setting a
 * status back.
 *
 * **3. Media and torrents are never touched.** Not by detection, not by merge,
 * not ever. A duplicate is a bookkeeping problem; the files are not duplicated.
 */

/** Strongest first — the same order the provider merge and resolver use. */
const ID_PRIORITY = ['imdb', 'tmdb', 'tvdb', 'tvmaze'] as const;

/** A bound on the scan, so a pathological watchlist cannot stall a request. */
const MAX_ITEMS = 5000;

export interface DuplicateEntry {
  id: string;
  title: string;
  year: number | null;
  status: string;
  createdAt: Date;
  externalIds: Record<string, string>;
  createdByDiscovery: boolean;
  rule: {
    id: string;
    name: string;
    generatedByDiscovery: boolean;
    userModifiedAt: Date | null;
    candidateCount: number;
  } | null;
  /** Rows that would be orphaned by a delete — which is why there is no delete. */
  history: { wantedEpisodes: number; evaluations: number; acquisitions: number };
}

export interface DuplicateGroup {
  /** Stable across scans, so a UI can act on the same group it rendered. */
  key: string;
  mediaType: string;
  canonicalTitle: string;
  year: number | null;
  /** How these were joined. An id match is proof; a title match is a proposal. */
  evidence: 'external_id' | 'canonical_title';
  matchedIdNamespace: string | null;
  entries: DuplicateEntry[];
  /** The entry this tool would keep, and why. */
  recommendedKeepId: string;
  recommendation: string;
}

export interface MergePlan {
  keep: DuplicateEntry;
  archive: DuplicateEntry[];
  /** Ids the keeper gains from the others. Never overwrites one it already has. */
  idsGained: Record<string, string>;
  /** Generated, never-edited rules that would be deleted. */
  rulesDeleted: Array<{ id: string; name: string }>;
  /** Rules left exactly as they are, and why. */
  rulesKept: Array<{ id: string; name: string; reason: string }>;
  warnings: string[];
}

@Injectable()
export class DiscoveryReconciliationService {
  private readonly logger = new Logger(DiscoveryReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // --- detection -----------------------------------------------------------

  async scan(): Promise<DuplicateGroup[]> {
    const items = await this.prisma.mediaAcquisitionWatchlistItem.findMany({
      select: {
        id: true, type: true, title: true, year: true, status: true, createdAt: true,
        externalIds: true, rssRuleId: true, settings: true,
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_ITEMS,
    });

    const groups = this.group(items);
    if (!groups.length) return [];

    // Enriched only for the entries that are actually in a group — the counts
    // are four queries a piece and most of a watchlist is not duplicated.
    const ids = groups.flatMap((g) => g.map((i) => i.id));
    // The link is `WatchlistItem.rssRuleId`, not a back-reference on the rule.
    const ruleIds = groups.flatMap((g) => g.map((i) => i.rssRuleId).filter(Boolean) as string[]);
    const enriched = await this.enrich(ids, ruleIds);

    return groups
      .map((members) => this.describe(members, enriched))
      .sort((a, b) => b.entries.length - a.entries.length || a.canonicalTitle.localeCompare(b.canonicalTitle));
  }

  /**
   * Union-find over the watchlist.
   *
   * A shared external id joins unconditionally. A canonical title+year joins only
   * when no id CONTRADICTS it — two entries that both carry an IMDb id and carry
   * different ones are different works whatever their titles say, and that is the
   * check that keeps a remake from being merged into its original.
   */
  private group<T extends { id: string; type: string; title: string; year: number | null; externalIds: unknown }>(
    items: T[],
  ): T[][] {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      const p = parent.get(x) ?? x;
      if (p === x) return x;
      const root = find(p);
      parent.set(x, root);
      return root;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    items.forEach((i) => parent.set(i.id, i.id));

    // --- join on a shared external id ------------------------------------
    const byId = new Map<string, string>();
    for (const item of items) {
      for (const [ns, value] of Object.entries(this.ids(item.externalIds))) {
        const key = `${item.type}|${ns}|${value}`;
        const seen = byId.get(key);
        if (seen) union(seen, item.id);
        else byId.set(key, item.id);
      }
    }

    // --- join on canonical title + year ----------------------------------
    const canon = new Map<string, ReturnType<typeof canonicalizeTitle>>();
    items.forEach((i) => canon.set(i.id, canonicalizeTitle(i.title, i.year)));

    const byTitle = new Map<string, T[]>();
    for (const item of items) {
      const c = canon.get(item.id)!;
      if (!c.normalizedTitle) continue;
      const key = `${item.type}|${c.normalizedTitle}`;
      byTitle.set(key, [...(byTitle.get(key) ?? []), item]);
    }
    for (const bucket of byTitle.values()) {
      for (let a = 0; a < bucket.length; a += 1) {
        for (let b = a + 1; b < bucket.length; b += 1) {
          const x = bucket[a];
          const y = bucket[b];
          if (!sameCanonicalTitle(canon.get(x.id)!, canon.get(y.id)!)) continue;
          if (this.idsContradict(x.externalIds, y.externalIds)) continue;
          union(x.id, y.id);
        }
      }
    }

    const out = new Map<string, T[]>();
    for (const item of items) {
      const root = find(item.id);
      out.set(root, [...(out.get(root) ?? []), item]);
    }
    return [...out.values()].filter((g) => g.length > 1);
  }

  /** Two entries naming different values in the same id namespace are different works. */
  private idsContradict(a: unknown, b: unknown): boolean {
    const ia = this.ids(a);
    const ib = this.ids(b);
    return ID_PRIORITY.some((ns) => ia[ns] && ib[ns] && ia[ns] !== ib[ns]);
  }

  private ids(raw: unknown): Record<string, string> {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const ns of ID_PRIORITY) {
      const v = obj[ns];
      if (typeof v === 'string' && v.trim()) out[ns] = v.trim();
    }
    return out;
  }

  private async enrich(ids: string[], ruleIds: string[]) {
    const [rules, wanted, evaluations, acquisitions] = await Promise.all([
      this.prisma.rssRule.findMany({
        where: { id: { in: ruleIds } },
        select: {
          id: true, name: true, generatedByDiscovery: true, userModifiedAt: true,
          _count: { select: { matchCandidates: true } },
        },
      }).catch(() => []),
      this.prisma.wantedEpisode.groupBy({ by: ['watchlistItemId'], where: { watchlistItemId: { in: ids } }, _count: true }).catch(() => []),
      this.prisma.mediaAcquisitionEvaluation.groupBy({ by: ['watchlistItemId'], where: { watchlistItemId: { in: ids } }, _count: true }).catch(() => []),
      this.prisma.mediaAcquisitionHistory.groupBy({ by: ['watchlistItemId'], where: { watchlistItemId: { in: ids } }, _count: true }).catch(() => []),
    ]);
    return { rules: rules as any[], wanted: wanted as any[], evaluations: evaluations as any[], acquisitions: acquisitions as any[] };
  }

  private describe(members: any[], enriched: Awaited<ReturnType<typeof this.enrich>>): DuplicateGroup {
    const count = (rows: any[], id: string) =>
      rows.find((r) => r.watchlistItemId === id)?._count ?? 0;

    const entries: DuplicateEntry[] = members.map((m) => {
      const rule = enriched.rules.find((r) => r.id === m.rssRuleId) ?? null;
      const settings = (m.settings ?? {}) as Record<string, unknown>;
      return {
        id: m.id,
        title: m.title,
        year: m.year,
        status: m.status,
        createdAt: m.createdAt,
        externalIds: this.ids(m.externalIds),
        createdByDiscovery: settings.createdByDiscovery === true,
        rule: rule
          ? {
              id: rule.id,
              name: rule.name,
              generatedByDiscovery: rule.generatedByDiscovery,
              userModifiedAt: rule.userModifiedAt,
              candidateCount: rule._count?.matchCandidates ?? 0,
            }
          : null,
        history: {
          wantedEpisodes: count(enriched.wanted, m.id),
          evaluations: count(enriched.evaluations, m.id),
          acquisitions: count(enriched.acquisitions, m.id),
        },
      };
    });

    // Evidence: an id shared by every member is proof; otherwise it is a title match.
    const shared = ID_PRIORITY.find(
      (ns) => entries.every((e) => e.externalIds[ns]) && new Set(entries.map((e) => e.externalIds[ns])).size === 1,
    );
    const canon = canonicalizeTitle(members[0].title, members[0].year);
    const keep = this.recommendKeep(entries);

    return {
      key: [...entries.map((e) => e.id)].sort().join('+'),
      mediaType: members[0].type,
      canonicalTitle: canon.title,
      year: entries.find((e) => e.year != null)?.year ?? null,
      evidence: shared ? 'external_id' : 'canonical_title',
      matchedIdNamespace: shared ?? null,
      entries,
      recommendedKeepId: keep.id,
      recommendation: keep.reason,
    };
  }

  /**
   * Which entry should survive.
   *
   * Ordered by what is hardest to recreate, not by what looks tidiest. A rule
   * somebody edited is work nobody else can reproduce; acquisition history is a
   * record of what actually happened; an external id can be copied across. The
   * oldest entry breaks a tie, because it is the one other things are most likely
   * to already reference.
   */
  private recommendKeep(entries: DuplicateEntry[]): { id: string; reason: string } {
    const scored = entries.map((e) => ({
      e,
      manualRule: e.rule && !e.rule.generatedByDiscovery ? 1 : 0,
      editedRule: e.rule?.userModifiedAt ? 1 : 0,
      history: e.history.acquisitions + e.history.evaluations + e.history.wantedEpisodes,
      ids: Object.keys(e.externalIds).length,
      manual: e.createdByDiscovery ? 0 : 1,
      age: -e.createdAt.getTime(),
    }));
    scored.sort(
      (a, b) =>
        b.manualRule - a.manualRule ||
        b.editedRule - a.editedRule ||
        b.history - a.history ||
        b.ids - a.ids ||
        b.manual - a.manual ||
        b.age - a.age,
    );
    const top = scored[0];
    const why: string[] = [];
    if (top.manualRule) why.push('its rule was made by hand');
    else if (top.editedRule) why.push('its rule has been edited by hand');
    if (top.history) why.push(`it carries ${top.history} history row(s)`);
    if (top.ids) why.push(`it has ${top.ids} external id(s)`);
    if (!why.length) why.push('it is the oldest entry');
    return { id: top.e.id, reason: `Keep "${top.e.title}" — ${why.join(', ')}` };
  }

  // --- merge ---------------------------------------------------------------

  /** What a merge would do. Writes nothing. */
  async plan(keepId: string, archiveIds: string[]): Promise<MergePlan> {
    const groups = await this.scan();
    const group = groups.find((g) => g.entries.some((e) => e.id === keepId));
    if (!group) throw new NotFoundException('That entry is not part of a duplicate group.');

    const keep = group.entries.find((e) => e.id === keepId)!;
    /*
     * The out-of-group check runs FIRST, because it is the more specific answer.
     * Naming only entries from another group is a caller mistake worth reporting
     * precisely; reporting it as "nothing to merge" sends somebody looking for an
     * empty selection they did not make.
     */
    const outside = archiveIds.filter((id) => !group.entries.some((e) => e.id === id));
    if (outside.length) {
      throw new BadRequestException(
        `These entries are not in the same duplicate group and will not be merged: ${outside.join(', ')}`,
      );
    }
    const archive = group.entries.filter((e) => archiveIds.includes(e.id));
    if (!archive.length) throw new BadRequestException('Nothing to merge: name at least one entry to archive.');

    /*
     * Ids are only ever GAINED. If the keeper already names a TMDB id, a
     * different one on a loser is not copied over it — that is a contradiction,
     * and silently overwriting an identity is how the wrong show gets acquired.
     */
    const idsGained: Record<string, string> = {};
    const warnings: string[] = [];
    for (const loser of archive) {
      for (const [ns, value] of Object.entries(loser.externalIds)) {
        if (keep.externalIds[ns] && keep.externalIds[ns] !== value) {
          warnings.push(
            `"${loser.title}" names a different ${ns.toUpperCase()} id (${value}) than the entry you are keeping (${keep.externalIds[ns]}) — these may not be the same work`,
          );
          continue;
        }
        if (!keep.externalIds[ns]) idsGained[ns] = value;
      }
    }

    const rulesDeleted: MergePlan['rulesDeleted'] = [];
    const rulesKept: MergePlan['rulesKept'] = [];
    for (const loser of archive) {
      if (!loser.rule) continue;
      if (!loser.rule.generatedByDiscovery) {
        rulesKept.push({ id: loser.rule.id, name: loser.rule.name, reason: 'made by hand' });
      } else if (loser.rule.userModifiedAt) {
        rulesKept.push({ id: loser.rule.id, name: loser.rule.name, reason: 'generated, then edited by hand' });
      } else {
        rulesDeleted.push({ id: loser.rule.id, name: loser.rule.name });
      }
    }

    if (!keep.rule && rulesKept.length) {
      warnings.push(
        'The entry you are keeping has no rule, while a duplicate has one that was made or edited by hand — link it to the kept entry rather than losing those preferences',
      );
    }
    for (const loser of archive) {
      const rows = loser.history.acquisitions + loser.history.evaluations + loser.history.wantedEpisodes;
      if (rows) {
        warnings.push(
          `"${loser.title}" carries ${rows} history row(s); archiving keeps them readable and reversible, which is why nothing here is deleted`,
        );
      }
    }

    return { keep, archive, idsGained, rulesDeleted, rulesKept, warnings };
  }

  /**
   * Perform a merge the operator has reviewed.
   *
   * Audited before it acts, like every other destructive path here — a merge that
   * half-completed and then threw must still say what was asked for and by whom.
   */
  async merge(
    keepId: string,
    archiveIds: string[],
    userId?: string,
    ctx: { ipAddress?: string; userAgent?: string } = {},
  ) {
    const plan = await this.plan(keepId, archiveIds);

    await this.audit.record({
      userId,
      ...ctx,
      action: 'media_discovery.duplicates.merged',
      objectType: 'media_acquisition_watchlist_item',
      objectId: keepId,
      metadata: {
        keep: plan.keep.title,
        archived: plan.archive.map((a) => ({ id: a.id, title: a.title })),
        idsGained: plan.idsGained,
        rulesDeleted: plan.rulesDeleted.map((r) => r.name),
        rulesKept: plan.rulesKept.map((r) => r.name),
      },
    });

    if (Object.keys(plan.idsGained).length) {
      await this.prisma.mediaAcquisitionWatchlistItem.update({
        where: { id: keepId },
        data: { externalIds: { ...plan.keep.externalIds, ...plan.idsGained } },
      });
    }

    // Only generated, never-edited rules. Anything a person touched is theirs.
    for (const rule of plan.rulesDeleted) {
      await this.prisma.rssRule.deleteMany({
        where: { id: rule.id, generatedByDiscovery: true, userModifiedAt: null },
      });
    }

    /*
     * Archived, not deleted. Every history row stays exactly where it is, the
     * entry remains readable, and an operator who disagrees can set the status
     * back — none of which is true of a delete.
     */
    await this.prisma.mediaAcquisitionWatchlistItem.updateMany({
      where: { id: { in: plan.archive.map((a) => a.id) } },
      data: { status: 'archived' },
    });

    this.logger.log(
      `Merged ${plan.archive.length} duplicate(s) into "${plan.keep.title}" — ${plan.rulesDeleted.length} generated rule(s) removed`,
    );
    return { ...plan, merged: true };
  }
}
