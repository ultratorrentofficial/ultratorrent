import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  MEDIA_FINDING_SEVERITIES,
  MEDIA_HEALTH_STATUSES,
  type MediaFinding,
  type MediaFindingCodeValue,
  type MediaFindingSeverity,
  type MediaHealthStatus,
  type MediaIntelligenceDomain,
  type MediaIntelligenceEntityType,
  type MediaIntelligenceListResult,
  type MediaIntelligenceOverview,
  type MediaIntelligenceSummary,
  type UnifiedMediaState,
} from '@ultratorrent/shared';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { evaluateMediaHealth } from './media-health-evaluator';
import { MediaIntelligenceProjectionService } from './media-intelligence-projection.service';
import { MediaStateAssembler } from './media-state.assembler';
import type { ListMediaIntelligenceDto, ListFindingsDto } from './dto/media-intelligence.dto';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * The read side of Media Intelligence.
 *
 * Two different shapes, on purpose. The **list** is served from the derived
 * projection: one indexed query over one table, so paging thousands of
 * entities costs the same as paging fifty. The **detail** is assembled live
 * from the owning domains, because a single entity is cheap to gather and a
 * stale detail page is worse than a slightly slower one.
 *
 * Nothing here triggers work in another domain. Opening any of these endpoints
 * runs queries and nothing else — no probe, no provider lookup, no scan, no
 * indexer search. The one exception is explicitly named `refresh`, which
 * re-evaluates stored facts; even that starts no scan.
 */
@Injectable()
export class MediaIntelligenceService {
  private readonly logger = new Logger(MediaIntelligenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly assembler: MediaStateAssembler,
    private readonly projections: MediaIntelligenceProjectionService,
  ) {}

  /* --------------------------------------------------------------- list */

  /**
   * Paged Media Health list.
   *
   * Finding-based filters are resolved to a bounded id set first rather than
   * joined, because the projection is the table that has the sortable columns
   * and the findings table is the one with the severity index — two indexed
   * lookups beat one join that can use only half of them.
   */
  async list(query: ListMediaIntelligenceDto): Promise<MediaIntelligenceListResult> {
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.pageSize ?? '', 10) || DEFAULT_PAGE_SIZE));

    const where: Record<string, unknown> = {};
    if (query.entityType) where.entityType = query.entityType;
    if (query.health) where.healthStatus = query.health;
    if (query.libraryId) where.libraryId = query.libraryId;
    if (query.q?.trim()) where.title = { contains: query.q.trim(), mode: 'insensitive' };

    // Narrowing by finding severity/domain/presence: collect the matching
    // entities from the findings index, then constrain the projection query.
    if (query.severity || query.domain || query.hasFindings === 'true') {
      const findingWhere: Record<string, unknown> = { resolvedAt: null };
      if (query.severity) findingWhere.severity = query.severity;
      if (query.domain) findingWhere.domain = query.domain;
      const matches = await this.prisma.mediaIntelligenceFinding.findMany({
        where: findingWhere,
        select: { entityType: true, entityId: true },
        distinct: ['entityType', 'entityId'],
        take: 5000,
      });
      if (!matches.length) return { items: [], total: 0, page, pageSize };
      where.OR = matches.map((m) => ({ entityType: m.entityType, entityId: m.entityId }));
    }

    const [rows, total] = await Promise.all([
      this.prisma.mediaIntelligenceProjection.findMany({
        where,
        orderBy: this.orderBy(query),
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.mediaIntelligenceProjection.count({ where }),
    ]);

    return { items: rows.map((r) => this.toSummary(r)), total, page, pageSize };
  }

  /**
   * Sort order.
   *
   * `health` sorts worst-first, which cannot be expressed as a column sort over
   * a text status — so it orders by the stored score ascending (a lower hygiene
   * score is a worse entity) with the status as the tie-break, and callers who
   * want strict severity ordering filter by status instead.
   */
  private orderBy(query: ListMediaIntelligenceDto): Record<string, string>[] {
    const dir = query.direction === 'asc' ? 'asc' : 'desc';
    switch (query.sort) {
      case 'title':
        return [{ title: query.direction === 'desc' ? 'desc' : 'asc' }];
      case 'size':
        return [{ totalBytes: dir }];
      case 'missing':
        return [{ missingCount: dir }];
      case 'lastPlayed':
        return [{ lastPlayedAt: dir }];
      case 'findings':
      case 'health':
      default:
        return [{ healthScore: query.direction === 'desc' ? 'desc' : 'asc' }, { title: 'asc' }];
    }
  }

  private toSummary(row: ProjectionRow): MediaIntelligenceSummary {
    return {
      entityType: row.entityType as MediaIntelligenceEntityType,
      entityId: row.entityId,
      title: row.title,
      year: row.year,
      libraryId: row.libraryId,
      libraryName: row.libraryName,
      health: row.healthStatus as MediaHealthStatus,
      healthScore: row.healthScore,
      findingCounts: normaliseCounts(row.findingCounts),
      // No global BigInt serializer exists; coerce at the boundary or JSON throws.
      totalBytes: row.totalBytes == null ? null : Number(row.totalBytes),
      missingCount: row.missingCount,
      lastPlayedAt: row.lastPlayedAt?.toISOString() ?? null,
      calculatedAt: row.calculatedAt.toISOString(),
    };
  }

  /* ----------------------------------------------------------- overview */

  /**
   * Overview counts.
   *
   * Every category is generated from the findings themselves — nothing is
   * hard-coded — so a code added later appears here without touching this
   * method or the UI.
   */
  async overview(): Promise<MediaIntelligenceOverview> {
    const [byHealth, byCode, latest, analyzed] = await Promise.all([
      this.prisma.mediaIntelligenceProjection.groupBy({ by: ['healthStatus'], _count: { _all: true } }),
      this.prisma.mediaIntelligenceFinding.groupBy({
        by: ['code', 'domain', 'severity'],
        where: { resolvedAt: null },
        _count: { _all: true },
      }),
      this.prisma.mediaIntelligenceProjection.aggregate({ _max: { calculatedAt: true } }),
      this.prisma.mediaIntelligenceProjection.count(),
    ]);

    const health = Object.fromEntries(MEDIA_HEALTH_STATUSES.map((s) => [s, 0])) as Record<MediaHealthStatus, number>;
    for (const row of byHealth) {
      const key = row.healthStatus as MediaHealthStatus;
      if (key in health) health[key] = row._count._all;
    }

    return {
      analyzed,
      byHealth: health,
      byFindingCode: byCode
        .map((r) => ({
          code: r.code as MediaFindingCodeValue,
          domain: r.domain as MediaIntelligenceDomain,
          severity: r.severity as MediaFindingSeverity,
          count: r._count._all,
        }))
        .sort((a, b) => b.count - a.count),
      lastCalculatedAt: latest._max.calculatedAt?.toISOString() ?? null,
      rebuilding: this.projections.isRebuilding(),
    };
  }

  /* ------------------------------------------------------------- detail */

  /**
   * The full unified state for one entity, assembled live.
   *
   * Findings come from the store rather than the fresh evaluation so their
   * lifecycle timestamps ("missing since the 3rd") survive into the response —
   * the evaluator is stateless and cannot know when a finding first appeared.
   */
  async detail(
    entityType: MediaIntelligenceEntityType,
    entityId: string,
    opts: { includePaths: boolean },
  ): Promise<UnifiedMediaState> {
    const assembled = await this.assembler.assemble(entityType, entityId, opts);
    if (!assembled) throw new NotFoundException(`Unknown ${entityType}: ${entityId}`);

    const now = new Date();
    const { health, findings } = evaluateMediaHealth({
      entityType,
      entityId,
      facts: assembled.facts,
      now,
      hygieneScore: assembled.hygieneScore,
    });

    const stored = await this.prisma.mediaIntelligenceFinding.findMany({
      where: { entityType, entityId, resolvedAt: null },
      select: { code: true, firstObservedAt: true, lastObservedAt: true },
    });
    const since = new Map(stored.map((s) => [s.code, s]));

    const withLifecycle: MediaFinding[] = findings.map((f) => ({
      ...f,
      firstObservedAt: since.get(f.code)?.firstObservedAt?.toISOString() ?? null,
      lastObservedAt: since.get(f.code)?.lastObservedAt?.toISOString() ?? f.lastObservedAt,
    }));

    const facts = assembled.facts as unknown as Record<string, { status?: string; observedAt?: string | null }>;
    return {
      ...(assembled.facts as unknown as Omit<UnifiedMediaState, 'health' | 'findings' | 'freshness'>),
      entityType,
      entityId,
      health,
      findings: withLifecycle,
      freshness: {
        assembledAt: now.toISOString(),
        sections: health.domains.map((d) => ({
          domain: d.domain,
          observedAt: facts[d.domain]?.observedAt ?? null,
          status: (facts[d.domain]?.status ?? 'unknown') as 'known' | 'partial' | 'unknown',
        })),
      },
    };
  }

  /** Stored findings for one entity, worst first. */
  async findings(
    entityType: MediaIntelligenceEntityType,
    entityId: string,
    query: ListFindingsDto,
  ): Promise<Array<Omit<MediaFinding, 'actionable'> & { actionable: boolean; resolvedAt: string | null }>> {
    const where: Record<string, unknown> = { entityType, entityId };
    if (query.includeResolved !== 'true') where.resolvedAt = null;
    if (query.severity) where.severity = query.severity;
    if (query.domain) where.domain = query.domain;

    const rows = await this.prisma.mediaIntelligenceFinding.findMany({
      where,
      orderBy: [{ severity: 'desc' }, { code: 'asc' }],
    });

    return rows.map((r) => ({
      code: r.code as MediaFindingCodeValue,
      domain: r.domain as MediaIntelligenceDomain,
      severity: r.severity as MediaFindingSeverity,
      entityType: r.entityType as MediaIntelligenceEntityType,
      entityId: r.entityId,
      evidence: (r.evidence ?? {}) as Record<string, unknown>,
      source: r.source,
      firstObservedAt: r.firstObservedAt.toISOString(),
      lastObservedAt: r.lastObservedAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      actionable: false,
    }));
  }

  /** Re-evaluate one entity from stored facts. Starts no scan or probe. */
  async refresh(entityType: MediaIntelligenceEntityType, entityId: string) {
    const result = await this.projections.refreshEntity(entityType, entityId);
    if (!result) throw new NotFoundException(`Unknown ${entityType}: ${entityId}`);
    return result;
  }
}

/** Counts round-tripped through JSON, with every severity guaranteed present. */
function normaliseCounts(raw: unknown): Record<MediaFindingSeverity, number> {
  const source = (raw ?? {}) as Record<string, unknown>;
  const out = Object.fromEntries(MEDIA_FINDING_SEVERITIES.map((s) => [s, 0])) as Record<MediaFindingSeverity, number>;
  for (const s of MEDIA_FINDING_SEVERITIES) {
    const v = source[s];
    if (typeof v === 'number' && Number.isFinite(v)) out[s] = v;
  }
  return out;
}

interface ProjectionRow {
  entityType: string;
  entityId: string;
  title: string;
  year: number | null;
  libraryId: string | null;
  libraryName: string | null;
  healthStatus: string;
  healthScore: number | null;
  findingCounts: unknown;
  totalBytes: bigint | null;
  missingCount: number | null;
  lastPlayedAt: Date | null;
  calculatedAt: Date;
}
