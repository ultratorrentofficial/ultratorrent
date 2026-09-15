import { Injectable, Logger } from '@nestjs/common';
import {
  MEDIA_FINDING_SEVERITIES,
  type MediaFinding,
  type MediaFindingSeverity,
  type MediaHealthStatus,
  type MediaIntelligenceEntityType,
} from '@ultratorrent/shared';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { evaluateMediaHealth } from './media-health-evaluator';
import { MediaStateAssembler } from './media-state.assembler';

/**
 * Maintains the DERIVED projection that powers the Media Health list.
 *
 * Detail is always assembled live; only the summary is materialized, because
 * paging and sorting thousands of entities by health would otherwise mean
 * fanning out across ten domains per row. Nothing here is authoritative: every
 * row can be dropped and rebuilt from the owning domains, which is exactly what
 * {@link rebuildAll} does.
 *
 * Three rules are inherited deliberately from `MediaPlaybackAggregate`, the
 * codebase's existing precedent for a derived table:
 *
 * - **Write a row for every evaluated entity, including healthy ones**, so a
 *   "healthy" row and a never-evaluated one are distinguishable.
 * - **Write nothing when there is no source data.** "I evaluated this library
 *   and everything is fine" and "no library has ever been scanned" are
 *   different claims, and a table full of confident zeroes cannot tell them
 *   apart.
 * - **Carry provenance** (`calculatedAt`, `unknownDomains`) so a stale row
 *   reads as stale instead of as fact.
 *
 * Findings are **resolved, never deleted**: a finding that stops reproducing
 * gets `resolvedAt` set, so "this was broken for three weeks and then fixed"
 * survives for the future Attention Center. Re-evaluating unchanged facts
 * updates the same row rather than accumulating a duplicate every sweep, which
 * is what the `(entityType, entityId, code)` unique key guarantees.
 */
@Injectable()
export class MediaIntelligenceProjectionService {
  private readonly logger = new Logger(MediaIntelligenceProjectionService.name);
  /** Guards a rebuild against overlapping runs; also reported to the UI. */
  private rebuilding = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly assembler: MediaStateAssembler,
  ) {}

  isRebuilding(): boolean {
    return this.rebuilding;
  }

  /**
   * Evaluate one entity and persist the conclusions.
   *
   * Returns null when the entity no longer exists — a deleted item must not
   * leave a projection row claiming to describe it.
   */
  async refreshEntity(
    entityType: MediaIntelligenceEntityType,
    entityId: string,
  ): Promise<{ health: MediaHealthStatus; findingCount: number } | null> {
    const assembled = await this.assembler.assemble(entityType, entityId);
    if (!assembled) {
      await this.forget(entityType, entityId);
      return null;
    }

    const now = new Date();
    const { health, findings } = evaluateMediaHealth({
      entityType,
      entityId,
      facts: assembled.facts,
      now,
      hygieneScore: assembled.hygieneScore,
    });

    const f = assembled.facts as unknown as ProjectionFacts;
    const unknownDomains = health.domains.filter((d) => d.status === 'unknown').map((d) => d.domain);

    await this.prisma.mediaIntelligenceProjection.upsert({
      where: { entityType_entityId: { entityType, entityId } },
      create: {
        entityType,
        entityId,
        healthStatus: health.status,
        healthScore: health.score,
        title: f.identity?.title ?? '(untitled)',
        year: f.identity?.year ?? null,
        libraryId: f.library?.libraryId ?? null,
        libraryName: f.library?.libraryName ?? null,
        totalBytes: f.library?.totalBytes != null ? BigInt(Math.round(f.library.totalBytes)) : null,
        missingCount: f.completeness?.missing ?? null,
        lastPlayedAt: f.usage?.lastPlayedAt ? new Date(f.usage.lastPlayedAt) : null,
        findingCounts: countBySeverity(findings),
        summary: this.rowSummary(findings),
        unknownDomains,
        qualityStatus: f.quality?.compliance?.status ?? null,
        upgradePotential: f.quality?.compliance?.upgradePotential ?? null,
        calculatedAt: now,
      },
      update: {
        healthStatus: health.status,
        healthScore: health.score,
        title: f.identity?.title ?? '(untitled)',
        year: f.identity?.year ?? null,
        libraryId: f.library?.libraryId ?? null,
        libraryName: f.library?.libraryName ?? null,
        totalBytes: f.library?.totalBytes != null ? BigInt(Math.round(f.library.totalBytes)) : null,
        missingCount: f.completeness?.missing ?? null,
        lastPlayedAt: f.usage?.lastPlayedAt ? new Date(f.usage.lastPlayedAt) : null,
        findingCounts: countBySeverity(findings),
        summary: this.rowSummary(findings),
        unknownDomains,
        qualityStatus: f.quality?.compliance?.status ?? null,
        upgradePotential: f.quality?.compliance?.upgradePotential ?? null,
        calculatedAt: now,
      },
    });

    await this.reconcileFindings(entityType, entityId, findings, now);
    return { health: health.status, findingCount: findings.length };
  }

  /**
   * Bring the stored findings for one entity in line with this evaluation.
   *
   * Open findings that reproduced are touched; ones that did not are resolved;
   * new ones are opened. `firstObservedAt` is preserved across updates because
   * "since when" is the question a queue of unresolved work exists to answer.
   */
  private async reconcileFindings(
    entityType: MediaIntelligenceEntityType,
    entityId: string,
    findings: readonly MediaFinding[],
    now: Date,
  ): Promise<void> {
    const existing = await this.prisma.mediaIntelligenceFinding.findMany({
      where: { entityType, entityId },
      select: { id: true, code: true, resolvedAt: true },
    });
    // Keyed on the raw string: the `code` column is deliberately untyped text
    // (a code is a stable identity, not a Postgres enum), so the comparison
    // stays on the string side rather than casting the DB's answer into the
    // union and pretending the database enforces it.
    const byCode = new Map<string, (typeof existing)[number]>(existing.map((e) => [e.code, e]));
    const produced = new Set<string>(findings.map((f) => f.code));

    for (const finding of findings) {
      const prior = byCode.get(finding.code);
      if (prior) {
        await this.prisma.mediaIntelligenceFinding.update({
          where: { id: prior.id },
          data: {
            domain: finding.domain,
            severity: finding.severity,
            evidence: finding.evidence as object,
            source: finding.source,
            lastObservedAt: now,
            // A finding that comes back after being resolved re-opens rather
            // than staying closed with a stale timestamp.
            resolvedAt: null,
          },
        });
      } else {
        await this.prisma.mediaIntelligenceFinding.create({
          data: {
            entityType,
            entityId,
            code: finding.code,
            domain: finding.domain,
            severity: finding.severity,
            evidence: finding.evidence as object,
            source: finding.source,
            firstObservedAt: now,
            lastObservedAt: now,
          },
        });
      }
    }

    // Everything that no longer reproduces is closed, not deleted.
    const stale = existing.filter((e) => !produced.has(e.code) && e.resolvedAt === null).map((e) => e.id);
    if (stale.length) {
      await this.prisma.mediaIntelligenceFinding.updateMany({
        where: { id: { in: stale } },
        data: { resolvedAt: now, lastObservedAt: now },
      });
    }
  }

  /** Drop a projection whose entity is gone. Findings go with it. */
  async forget(entityType: MediaIntelligenceEntityType, entityId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.mediaIntelligenceProjection.deleteMany({ where: { entityType, entityId } }),
      this.prisma.mediaIntelligenceFinding.deleteMany({ where: { entityType, entityId } }),
    ]);
  }

  /**
   * Rebuild the whole projection from the owning domains.
   *
   * Paged deliberately: a library of tens of thousands of items must not be
   * loaded at once, and each entity is evaluated independently so one bad row
   * cannot abort the run. This is the repair path — it reads source domains and
   * writes only derived tables, and is safe to run at any time.
   */
  async rebuildAll(opts: { pageSize?: number } = {}): Promise<RebuildSummary> {
    if (this.rebuilding) return { skipped: true, movies: 0, series: 0, failed: 0 };
    this.rebuilding = true;
    const pageSize = opts.pageSize ?? 250;
    const summary: RebuildSummary = { skipped: false, movies: 0, series: 0, failed: 0 };

    try {
      // Movies: every `movie` item is a first-class entity.
      for (let skip = 0; ; skip += pageSize) {
        const page = await this.prisma.mediaItem.findMany({
          where: { mediaType: 'movie' },
          select: { id: true },
          orderBy: { id: 'asc' },
          skip,
          take: pageSize,
        });
        if (!page.length) break;
        for (const row of page) {
          try {
            await this.refreshEntity('movie', row.id);
            summary.movies += 1;
          } catch (err) {
            summary.failed += 1;
            this.logger.warn(`Projection failed for movie ${row.id}: ${(err as Error).message}`);
          }
        }
        if (page.length < pageSize) break;
      }

      // Series: one entity per show folder.
      for (let skip = 0; ; skip += pageSize) {
        const page = await this.prisma.mediaShow.findMany({
          select: { id: true },
          orderBy: { id: 'asc' },
          skip,
          take: pageSize,
        });
        if (!page.length) break;
        for (const row of page) {
          try {
            await this.refreshEntity('series', row.id);
            summary.series += 1;
          } catch (err) {
            summary.failed += 1;
            this.logger.warn(`Projection failed for series ${row.id}: ${(err as Error).message}`);
          }
        }
        if (page.length < pageSize) break;
      }

      this.logger.log(
        `Media Intelligence rebuild: ${summary.movies} movies, ${summary.series} series, ${summary.failed} failed.`,
      );
      return summary;
    } finally {
      this.rebuilding = false;
    }
  }

  /**
   * A bounded rendering payload for one list row.
   *
   * Only the top few findings, and only their codes and evidence — never the
   * whole state. A list response that carried each row's full evidence would
   * grow without limit on exactly the libraries that need the list most.
   */
  private rowSummary(findings: readonly MediaFinding[]): object {
    return {
      topFindings: findings.slice(0, 3).map((f) => ({
        code: f.code,
        domain: f.domain,
        severity: f.severity,
        evidence: f.evidence,
      })),
      totalFindings: findings.length,
    };
  }
}

export interface RebuildSummary {
  /** True when a rebuild was already running and this call did nothing. */
  skipped: boolean;
  movies: number;
  series: number;
  failed: number;
}

/** The subset of assembled facts the projection row denormalizes. */
interface ProjectionFacts {
  identity?: { title: string | null; year: number | null };
  quality?: { compliance?: { status: string; upgradePotential: boolean } };
  library?: { libraryId: string | null; libraryName: string | null; totalBytes: number | null };
  completeness?: { missing: number | null };
  usage?: { lastPlayedAt: string | null };
}

/** Counts by severity, with every severity present so the UI needs no guards. */
function countBySeverity(findings: readonly MediaFinding[]): Record<MediaFindingSeverity, number> {
  const counts = Object.fromEntries(MEDIA_FINDING_SEVERITIES.map((s) => [s, 0])) as Record<MediaFindingSeverity, number>;
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}
