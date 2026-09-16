import { Injectable, Logger } from '@nestjs/common';
import {
  MEDIA_FINDING_SEVERITIES,
  type MediaFinding,
  type MediaFindingSeverity,
  type MediaHealthStatus,
  type MediaAttentionDisposition,
  type MediaAttentionEvent,
  type MediaIntelligenceEntityType,
} from '@ultratorrent/shared';

import { DOMAIN_EVENTS } from '@ultratorrent/shared';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { evaluateMediaHealth } from './media-health-evaluator';
import { evaluateDispositionRetention } from './attention/escalation';
import { attentionPriority } from './attention/priority';
import { MediaStateAssembler } from './media-state.assembler';
import { RecommendationService } from './recommendations/recommendation.service';

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
    private readonly bus: DomainEventBus,
    private readonly recommendations: RecommendationService,
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
  ): Promise<{ health: MediaHealthStatus; findingCount: number; transitions: AttentionTransition[] } | null> {
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

    const { transitions, reconciled } = await this.reconcileFindings(entityType, entityId, findings, now);

    /*
     * Recommendations settle in the SAME pass, against the finding rows that
     * were just persisted — a recommendation is keyed on `(findingId, type)`,
     * so it needs real ids rather than evaluator output. Deliberately after
     * reconciliation and never inside it: this writes only to its own table,
     * and a failure here must not be able to corrupt finding truth or the
     * operator's disposition.
     */
    await this.recommendations.reconcile(entityType, entityId, reconciled, now);

    return { health: health.status, findingCount: findings.length, transitions };
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
  ): Promise<{ transitions: AttentionTransition[]; reconciled: ReconciledFinding[] }> {
    const existing = await this.prisma.mediaIntelligenceFinding.findMany({
      where: { entityType, entityId },
      select: {
        id: true, code: true, resolvedAt: true, severity: true, evidence: true,
        disposition: true, snoozedUntil: true,
      },
    });
    // Keyed on the raw string: the `code` column is deliberately untyped text
    // (a code is a stable identity, not a Postgres enum), so the comparison
    // stays on the string side rather than casting the DB's answer into the
    // union and pretending the database enforces it.
    const byCode = new Map<string, (typeof existing)[number]>(existing.map((e) => [e.code, e]));
    const produced = new Set<string>(findings.map((f) => f.code));

    /*
     * History is written as ONE batch at the end, and only for transitions.
     * A sweep touches every finding in the library and almost none of them
     * changed; a row per observation would bury the handful of entries that
     * explain what actually happened, and would grow without bound.
     */
    const history: Array<{ findingId: string; event: MediaAttentionEvent; detail: object }> = [];
    const transitions: AttentionTransition[] = [];
    /** The persisted rows, so the recommendation pass can key on real ids. */
    const reconciled: ReconciledFinding[] = [];

    for (const finding of findings) {
      const prior = byCode.get(finding.code);
      if (prior) {
        const reopened = prior.resolvedAt != null;
        const severityChanged = prior.severity !== finding.severity;

        /*
         * Does the operator's decision survive what just changed underneath
         * it? Pure, deterministic, and deliberately conservative: a
         * disposition is cleared only when the condition demonstrably
         * worsened, never because a sweep re-observed it.
         */
        const retention = evaluateDispositionRetention({
          previous: {
            severity: prior.severity,
            evidence: (prior.evidence ?? {}) as Record<string, unknown>,
            resolvedAt: prior.resolvedAt,
          },
          current: { severity: finding.severity, evidence: finding.evidence },
          disposition: prior.disposition as MediaAttentionDisposition,
        });
        const clearing =
          retention.result === 'reset_to_unreviewed' && prior.disposition !== 'unreviewed';

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
            // Severity may have moved, and a clearing disposition changes the
            // rank too; recompute from whatever this row is about to become.
            attentionPriority: attentionPriority(
              finding.severity,
              clearing ? 'unreviewed' : prior.disposition,
            ),
            ...(clearing
              ? {
                  // The condition got worse, so the earlier decision no longer
                  // describes it. Note this rewrites WORKFLOW state only —
                  // `resolvedAt` above is the evaluator's business and is set
                  // from the facts, never from what a person wanted.
                  disposition: 'unreviewed',
                  snoozedUntil: null,
                  dispositionAt: null,
                  dispositionBy: null,
                  dispositionReason: null,
                  escalationReason: retention.reason,
                }
              : {}),
          },
        });

        reconciled.push({
          id: prior.id,
          code: finding.code,
          severity: finding.severity,
          evidence: finding.evidence,
          resolved: false,
        });

        if (reopened) history.push({ findingId: prior.id, event: 'reopened', detail: {} });
        if (severityChanged) {
          history.push({
            findingId: prior.id,
            event: 'severity_changed',
            detail: { from: prior.severity, to: finding.severity },
          });
        }
        if (clearing) {
          history.push({
            findingId: prior.id,
            event: 'disposition_reset_by_escalation',
            detail: { from: prior.disposition, reason: retention.reason },
          });
        }

        // Worth telling a person about: it came back, or it got worse.
        if (reopened || clearing || (severityChanged && rank(finding.severity) > rank(prior.severity))) {
          transitions.push({
            code: finding.code,
            severity: finding.severity,
            entityType,
            entityId,
            kind: reopened ? 'reopened' : 'escalated',
          });
        }
      } else {
        const created = await this.prisma.mediaIntelligenceFinding.create({
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
            attentionPriority: attentionPriority(finding.severity, 'unreviewed'),
          },
          select: { id: true },
        });
        reconciled.push({
          id: created.id,
          code: finding.code,
          severity: finding.severity,
          evidence: finding.evidence,
          resolved: false,
        });
        history.push({ findingId: created.id, event: 'opened', detail: {} });
        transitions.push({
          code: finding.code,
          severity: finding.severity,
          entityType,
          entityId,
          kind: 'opened',
        });
      }
    }

    // Everything that no longer reproduces is closed, not deleted.
    const stale = existing.filter((e) => !produced.has(e.code) && e.resolvedAt === null);
    if (stale.length) {
      await this.prisma.mediaIntelligenceFinding.updateMany({
        where: { id: { in: stale.map((e) => e.id) } },
        data: { resolvedAt: now, lastObservedAt: now },
      });
      for (const e of stale) {
        history.push({ findingId: e.id, event: 'resolved', detail: {} });
        // Carried so the recommendation pass can mark its response satisfied
        // rather than leaving it proposing a fix for a condition that is gone.
        reconciled.push({
          id: e.id,
          code: e.code,
          severity: e.severity,
          evidence: (e.evidence ?? {}) as Record<string, unknown>,
          resolved: true,
        });
      }
    }

    if (history.length) {
      await this.prisma.mediaIntelligenceFindingEvent.createMany({
        data: history.map((h) => ({ findingId: h.findingId, event: h.event, detail: h.detail })),
      });
    }

    return { transitions, reconciled };
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
    // Accumulated for ONE digest at the end of the run, never per entity.
    const transitions: AttentionTransition[] = [];

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
            const r = await this.refreshEntity('movie', row.id);
            if (r) transitions.push(...r.transitions);
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
            const r = await this.refreshEntity('series', row.id);
            if (r) transitions.push(...r.transitions);
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
      this.publishDigest(transitions);
      return summary;
    } finally {
      this.rebuilding = false;
    }
  }

  /**
   * ONE notification for a whole reconciliation run.
   *
   * The flood-control burden sits entirely on the producer: nothing
   * downstream collapses events, and the dispatcher writes one row per
   * (user, event). A sweep evaluates every title in the library, so
   * publishing per finding would mean thousands of notifications for a
   * routine recalculation.
   *
   * Two further guards fall out of the design rather than being special-cased:
   *
   *  - Only NEW, REOPENED or ESCALATED findings are transitions at all, so a
   *    steady-state sweep over thousands of unchanged findings publishes
   *    nothing. That is also what makes the first run after this ships quiet:
   *    every existing finding already has a row, so none reads as newly
   *    opened.
   *  - Only findings that actually warrant a person are counted. An
   *    `opportunity` (a fallback quality rung the operator configured
   *    themselves) is not an incident and must not page anyone.
   */
  private publishDigest(transitions: readonly AttentionTransition[]): void {
    const notable = transitions.filter((t) => rank(t.severity) >= SEVERITY_ORDER.warning);
    if (!notable.length) return;

    const MAX_ITEMS = 10;
    const worstFirst = [...notable].sort((a, b) => rank(b.severity) - rank(a.severity));
    const sample = worstFirst.slice(0, MAX_ITEMS);

    this.bus.publish({
      eventKey: DOMAIN_EVENTS.MEDIA_INTELLIGENCE_ATTENTION_DIGEST,
      resourceType: 'media_intelligence',
      resourceId: 'reconcile',
      payload: {
        count: notable.length,
        critical: notable.filter((t) => t.severity === 'critical').length,
        opened: notable.filter((t) => t.kind === 'opened').length,
        reopened: notable.filter((t) => t.kind === 'reopened').length,
        escalated: notable.filter((t) => t.kind === 'escalated').length,
        // Bounded: the payload must not grow with the size of the library.
        items: sample.map((t) => ({ label: `${t.code} (${t.severity})` })),
        omitted: Math.max(0, notable.length - sample.length),
      },
    });
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

/** Severity ordering, mirrored from the evaluator so escalation agrees with it. */
const SEVERITY_ORDER: Record<string, number> = { info: 0, opportunity: 1, warning: 2, error: 3, critical: 4 };
const rank = (s: string): number => SEVERITY_ORDER[s] ?? -1;

/**
 * A transition worth telling a person about.
 *
 * Collected per entity and summarised into ONE digest per run. Emphatically
 * not one event per finding: a sweep evaluates the whole library, and a
 * per-finding event would mean thousands of notifications for a routine
 * recalculation that discovered nothing new.
 */
/** One persisted finding row, as the recommendation pass needs to see it. */
export interface ReconciledFinding {
  id: string;
  code: string;
  severity: string;
  evidence: Record<string, unknown>;
  /** True when this sweep just closed it. */
  resolved: boolean;
}

export interface AttentionTransition {
  code: string;
  severity: string;
  entityType: string;
  entityId: string;
  kind: 'opened' | 'reopened' | 'escalated';
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
