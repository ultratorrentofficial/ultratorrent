import { Injectable } from '@nestjs/common';
import type {
  MediaRecommendation,
  MediaRecommendationClass,
  MediaRecommendationConfidence,
  MediaRecommendationInvalidationReason,
  MediaRecommendationListResult,
  MediaRecommendationStatus,
  MediaRecommendationSummary,
  MediaRecommendationTypeValue,
  MediaUpgradeCandidate,
  MediaVerificationStatus,
  MediaRemediationStep,
} from '@ultratorrent/shared';

import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { parsePage } from '../../../common/pagination';
import { RECOMMENDATION_ORDER_BY } from './confidence-rank';
import type { ListRecommendationsDto } from '../dto/recommendation.dto';

/**
 * The read side of recommendations.
 *
 * Reads persisted state and NOTHING else. Opening this list must not call an
 * indexer, a provider, a media server, mediainfo or a torrent engine, and it
 * must not start a rebuild — that is the difference between a page people
 * check and a page people learn not to open. Availability is established only
 * by an explicit verification, never as a side effect of looking.
 *
 * **One definition of the queue**, built once and handed to both the list and
 * the counters, for the same reason the Attention Center does it: a dashboard
 * that disagrees with the list beneath it destroys trust in both.
 */
@Injectable()
export class RecommendationQueryService {
  /** Title search resolves through the projection; bound what it can match. */
  private static readonly MAX_TITLE_MATCHES = 5000;

  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(query: ListRecommendationsDto): Record<string, unknown> {
    const where: Record<string, unknown> = {
      // Active by default: an invalidated or satisfied recommendation is
      // history, and history does not belong in a queue of things to do.
      status: query.status ?? 'active',
    };
    if (query.type) where.type = query.type;
    if (query.recommendationClass) where.recommendationClass = query.recommendationClass;
    if (query.confidence) where.confidence = query.confidence;
    if (query.verification) where.verification = query.verification;
    if (query.entityType) where.entityType = query.entityType;
    /*
     * "Something could be done about this" — a recommendation that either
     * routes to a registered capability or can be verified. Filtered
     * server-side: narrowing a paginated list in the browser would filter one
     * page and silently hide every other match.
     */
    if (query.actionable === 'true') {
      where.OR = [{ capabilityId: { not: null } }, { verification: { not: 'not_required' } }];
    }
    return where;
  }

  async list(query: ListRecommendationsDto): Promise<MediaRecommendationListResult> {
    const params = parsePage(query.page, query.pageSize);
    const where = await this.withTitleSearch(this.buildWhere(query), query.q);
    if (!where) return { items: [], total: 0, page: params.page, pageSize: params.pageSize };

    const [rows, total] = await Promise.all([
      this.prisma.mediaIntelligenceRecommendation.findMany({
        where,
        include: {
          // One join rather than a second query per row: the finding's code
          // and severity are what make a recommendation readable.
          finding: { select: { code: true, severity: true } },
        },
        orderBy: RECOMMENDATION_ORDER_BY,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.mediaIntelligenceRecommendation.count({ where }),
    ]);

    return {
      items: await this.decorate(rows),
      total,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  /** One recommendation, by id. Null rather than a throw, for the caller. */
  async byId(id: string): Promise<MediaRecommendation | null> {
    const row = await this.prisma.mediaIntelligenceRecommendation.findUnique({
      where: { id },
      include: { finding: { select: { code: true, severity: true } } },
    });
    if (!row) return null;
    const [item] = await this.decorate([row]);
    return item ?? null;
  }

  /** Every active recommendation for one finding. Used by the drawer. */
  async forFinding(findingId: string): Promise<MediaRecommendation[]> {
    const rows = await this.prisma.mediaIntelligenceRecommendation.findMany({
      where: { findingId, status: { in: ['active', 'verified'] } },
      include: { finding: { select: { code: true, severity: true } } },
      orderBy: RECOMMENDATION_ORDER_BY,
    });
    return this.decorate(rows);
  }

  /**
   * Counts for the overview, derived from the SAME predicate the list uses so
   * the two cannot drift.
   */
  async summary(): Promise<MediaRecommendationSummary> {
    const active = { status: 'active' };
    const [byConfidence, verified, unverified] = await Promise.all([
      this.prisma.mediaIntelligenceRecommendation.groupBy({
        by: ['confidence'],
        where: active,
        _count: { _all: true },
      }),
      this.prisma.mediaIntelligenceRecommendation.count({
        where: { status: 'active', verification: 'verified' },
      }),
      this.prisma.mediaIntelligenceRecommendation.count({
        where: { status: 'active', verification: 'not_checked' },
      }),
    ]);

    const n = (c: string) => byConfidence.find((r) => r.confidence === c)?._count._all ?? 0;
    return {
      active: byConfidence.reduce((sum, r) => sum + r._count._all, 0),
      verified,
      unverified,
      high: n('high'),
      medium: n('medium'),
      low: n('low'),
    };
  }

  /**
   * Title search, resolved through the projection.
   *
   * The projection is the only place a title lives — recommendations carry
   * ids, not prose, and duplicating the title onto them would give one fact
   * two homes. Mirrors what the Attention Center already does.
   */
  private async withTitleSearch(
    where: Record<string, unknown>,
    q: string | undefined,
  ): Promise<Record<string, unknown> | null> {
    const term = q?.trim();
    if (!term) return where;

    const matches = await this.prisma.mediaIntelligenceProjection.findMany({
      where: { title: { contains: term, mode: 'insensitive' } },
      select: { entityType: true, entityId: true },
      take: RecommendationQueryService.MAX_TITLE_MATCHES,
    });
    if (!matches.length) return null;
    return {
      ...where,
      OR: matches.map((m) => ({ entityType: m.entityType, entityId: m.entityId })),
    };
  }

  /**
   * Attach the media identity each row needs to be readable.
   *
   * ONE extra query for the whole page, never one per row: the page's
   * (entityType, entityId) pairs are looked up together and joined in memory.
   */
  private async decorate(
    rows: ReadonlyArray<Record<string, unknown>>,
  ): Promise<MediaRecommendation[]> {
    if (!rows.length) return [];

    const keys = [...new Set(rows.map((r) => `${r.entityType as string}|${r.entityId as string}`))];
    const projections = await this.prisma.mediaIntelligenceProjection.findMany({
      where: {
        OR: keys.map((k) => {
          const [entityType, entityId] = k.split('|');
          return { entityType, entityId };
        }),
      },
      select: { entityType: true, entityId: true, title: true, year: true },
    });
    const byKey = new Map(projections.map((p) => [`${p.entityType}|${p.entityId}`, p]));

    return rows.map((r) => {
      const p = byKey.get(`${r.entityType as string}|${r.entityId as string}`);
      const f = r.finding as { code: string; severity: string } | undefined;
      return {
        id: r.id as string,
        findingId: r.findingId as string,
        entityType: r.entityType as string,
        entityId: r.entityId as string,
        type: r.type as MediaRecommendationTypeValue,
        recommendationClass: r.recommendationClass as MediaRecommendationClass,
        status: r.status as MediaRecommendationStatus,
        confidence: r.confidence as MediaRecommendationConfidence,
        findingCode: f?.code ?? '',
        findingSeverity: f?.severity ?? '',
        // A recommendation can outlive its projection for one sweep; say so
        // rather than rendering an empty card.
        title: p?.title ?? '(unknown title)',
        year: p?.year ?? null,
        evidence: (r.evidence ?? {}) as Record<string, unknown>,
        unknowns: (r.unknowns ?? []) as string[],
        plan: (r.plan ?? []) as MediaRemediationStep[],
        capabilityId: (r.capabilityId as string | null) ?? null,
        verification: r.verification as MediaVerificationStatus,
        verifiedAt: (r.verifiedAt as Date | null)?.toISOString() ?? null,
        candidate: (r.candidate as MediaUpgradeCandidate | null) ?? null,
        invalidationReason:
          (r.invalidationReason as MediaRecommendationInvalidationReason | null) ?? null,
        evaluatedAt: (r.evaluatedAt as Date).toISOString(),
        createdAt: (r.createdAt as Date).toISOString(),
      };
    });
  }
}
