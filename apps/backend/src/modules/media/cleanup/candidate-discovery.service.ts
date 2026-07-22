import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NOTIFICATION_BUS_CHANNEL } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { paginate, parsePage } from '../../../common/pagination';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { FilePathService } from '../../files/file-path.service';
import { ProtectionService } from './protection.service';
import { evaluatePolicy } from './domain/policy-evaluator';
import { evaluateExclusions } from './domain/exclusion-rules';
import { candidateFingerprint } from './domain/candidate-fingerprint';
import { rankCandidate } from './domain/candidate-ranking';
import { assembleEvaluationFacts, assembleExclusionFacts, type RawContext } from './domain/fact-assembly';
import { getCondition } from './domain/condition-catalog';
import { collectFieldIds, isGroup, type CleanupPolicyDocument, type PolicyConditionNode } from './domain/policy-document';
import type { PlaybackAggregateFacts } from './domain/playback-aggregate';

/** Rows per page. Matches duplicate detection's proven page size. */
const PAGE_SIZE = 500;

/**
 * The columns a fingerprint is computed from — declared ONCE, because the
 * fingerprint taken at discovery and the one recomputed immediately before a file
 * is removed must be the same computation over the same inputs. If they were
 * written twice they would eventually disagree, and the failure is silent in the
 * worst direction: either every plan drifts and nothing is ever cleaned, or none
 * does and a changed file is deleted anyway.
 */
export const FILE_SELECT = {
  id: true, path: true, size: true, width: true, height: true, videoCodec: true,
  audioCodec: true, audioChannels: true, bitrateKbps: true, frameRate: true,
  container: true, durationSec: true, videoBitDepth: true, chromaSubsampling: true,
  hdrFormat: true, hdr: true, techSource: true, probedAt: true, probeError: true,
} as const;

export const ITEM_SELECT = {
  id: true, libraryId: true, mediaType: true, year: true, matchStatus: true,
  confidence: true, locked: true, createdAt: true, duplicateGroupId: true,
  externalIds: { select: { provider: true, externalId: true } },
  metadata: { select: { genres: true, tags: true, certification: true, rating: true, runtime: true, releaseDate: true } },
  library: { select: { kind: true, path: true } },
} as const;

interface RunOptions {
  simulate: boolean;
  trigger: string;
  userId?: string;
  limit?: number;
}

/**
 * Candidate discovery — where the policy engine first meets real files.
 *
 * A run is pinned to one immutable policy version and produces CANDIDATES, never
 * actions. Every file is evaluated, then put through the mandatory exclusion pass,
 * then fingerprinted; the reason snapshot records what was decided and why, so the
 * operator reviews a statement of fact rather than a verdict they must trust.
 *
 * Paged with narrow selects, because a library is tens of thousands of rows and
 * hydrating it is how a scan becomes a memory incident.
 */
@Injectable()
export class CandidateDiscoveryService {
  private readonly logger = new Logger(CandidateDiscoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly protections: ProtectionService,
    private readonly filePath: FilePathService,
    private readonly eventBus: EventEmitter2,
  ) {}

  /** Create a run pinned to the policy's published version (or its draft, to simulate). */
  async startRun(policyId: string, opts: RunOptions) {
    const policy = await this.prisma.mediaCleanupPolicy.findUnique({ where: { id: policyId } });
    if (!policy) throw new NotFoundException('Cleanup policy not found');

    // A real run demands a published version. A simulation may use the draft — that
    // is the whole point of simulating before you publish.
    const versionId = opts.simulate
      ? (policy.currentDraftVersionId ?? policy.publishedVersionId)
      : policy.publishedVersionId;
    if (!versionId) {
      throw new BadRequestException(
        opts.simulate ? 'Policy has no document to simulate' : 'Publish the policy before running it',
      );
    }
    if (!opts.simulate && !policy.enabled && opts.trigger !== 'manual') {
      throw new BadRequestException('Policy is disabled');
    }

    const run = await this.prisma.mediaCleanupRun.create({
      data: {
        policyId,
        policyVersionId: versionId,
        trigger: opts.trigger,
        status: 'queued',
        simulate: opts.simulate,
        createdById: opts.userId ?? null,
      },
    });
    await this.audit.record({
      userId: opts.userId,
      action: opts.simulate ? 'library_cleanup.run.simulated' : 'library_cleanup.run.started',
      objectType: 'media_cleanup_run', objectId: run.id,
      metadata: { policyId, versionId, trigger: opts.trigger },
    });
    this.emit('media.cleanup.run.started', { runId: run.id, policyId, simulate: opts.simulate });
    return run;
  }

  /**
   * Walk the scope and record what the policy says about each file. Never touches
   * the filesystem beyond an existence/containment check, and never in a
   * simulation.
   */
  async executeRun(runId: string, limit?: number): Promise<void> {
    try {
      await this.scanRun(runId, limit);
    } catch (err) {
      // A scan that throws mid-page must not strand the run in `running` forever —
      // every later poll would show work that never ends. Record the failure and
      // let the caller read a run row that says so.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Cleanup run ${runId} failed: ${message}`);
      await this.finalize(runId, 'failed', `scan_error: ${message}`).catch(() => undefined);
    }
  }

  private async scanRun(runId: string, limit?: number): Promise<void> {
    const run = await this.prisma.mediaCleanupRun.findUnique({ where: { id: runId } });
    if (!run || !['queued', 'running'].includes(run.status)) return;

    const version = await this.prisma.mediaCleanupPolicyVersion.findUnique({
      where: { id: run.policyVersionId },
    });
    const document = version?.document as unknown as CleanupPolicyDocument | undefined;
    if (!document) {
      await this.finalize(runId, 'failed', 'missing_policy_version');
      return;
    }

    await this.prisma.mediaCleanupRun.update({
      where: { id: runId }, data: { status: 'running', startedAt: new Date() },
    });

    const factKeys = [...collectFieldIds(document.conditions)];
    const policyUses = {
      measured: usesMeasured(document.conditions),
      playback: factKeys.some((k) => k.startsWith('playback.')),
    };
    const where = this.scopeWhere(document);

    let scanned = 0, evaluated = 0, matched = 0, excluded = 0, eligible = 0;
    let estimatedBytes = 0n;
    // A capped run stopped early. It must never be reported as `completed`, or the
    // operator reads a partial sweep as "the library holds nothing else".
    let truncated = false;
    const breakdown: Record<string, number> = {};
    // Precedence matters: `limit ?? run.simulate ? a : b` would parse as
    // `(limit ?? run.simulate) ? a : b` and cap every real run at the simulation cap.
    const cap: number | undefined = limit ?? (run.simulate ? 5000 : undefined);

    let cursor: string | undefined;
    for (;;) {
      const items = await this.prisma.mediaItem.findMany({
        where,
        // Narrow select: a library is tens of thousands of rows.
        select: { ...ITEM_SELECT, files: { select: FILE_SELECT } },
        orderBy: { id: 'asc' },
        cursor: cursor ? { id: cursor } : undefined,
        skip: cursor ? 1 : 0,
        take: PAGE_SIZE,
      });
      if (!items.length) break;
      cursor = items[items.length - 1]!.id;

      // Cooperative cancellation at a safe boundary — between pages, never mid-write.
      const live = await this.prisma.mediaCleanupRun.findUnique({
        where: { id: runId }, select: { status: true },
      });
      if (live?.status === 'cancelling') {
        await this.finalize(runId, 'cancelled');
        return;
      }

      for (const item of items) {
        for (const file of item.files) {
          scanned += 1;
          if (cap && evaluated >= cap) { truncated = true; break; }

          const ctx = await this.buildContext(item as never, file as never, document);
          const facts = assembleEvaluationFacts(file as never, item as never, ctx);
          evaluated += 1;

          const verdict = evaluatePolicy(document.conditions, facts);
          if (verdict.outcome === 'not_matched') continue;

          // An unmeasured evaluation is recorded as an exclusion, not a match — the
          // operator should see that we could not tell, not silence.
          const exclusionFacts = assembleExclusionFacts(file as never, item as never, ctx, policyUses);
          const exclusion = verdict.outcome === 'unmeasured'
            ? { excluded: true, reason: 'unmeasured_technical' as const, status: 'excluded_unmeasured', allReasons: ['unmeasured_technical' as const] }
            : evaluateExclusions(exclusionFacts, {
                exclusions: document.exclusions,
                replacementRequired: document.replacement?.required === true,
              });

          matched += verdict.outcome === 'matched' ? 1 : 0;
          const status = exclusion.excluded ? (exclusion.status ?? 'excluded_protected') : 'candidate';
          if (exclusion.excluded) {
            excluded += 1;
            breakdown[exclusion.reason ?? 'unknown'] = (breakdown[exclusion.reason ?? 'unknown'] ?? 0) + 1;
          } else {
            eligible += 1;
            estimatedBytes += BigInt(file.size ?? 0);
          }

          const fingerprint = candidateFingerprint({
            mediaFileId: file.id,
            path: file.path,
            fileSizeBytes: file.size ?? 0,
            modifiedAtMs: null,
            identityKeys: (item.externalIds ?? []).map((e) => `${e.provider}:${e.externalId}`),
            policyVersionId: run.policyVersionId,
            facts: flattenFacts(facts),
            factKeys,
            isProtected: ctx.isProtected,
            protectionIds: ctx.protectionIds ?? [],
            replacementFileId: null,
          });

          const ranking = rankCandidate({
            reclaimableBytes: Number(file.size ?? 0),
            daysSinceLastPlay: (facts.playback?.daysSinceLastPlay as number | undefined) ?? null,
            completedPlayCount: (facts.playback?.completedPlayCount as number | undefined) ?? 0,
            qualityTiersBelowBest: null,
            replacementConfidence: null,
            daysSinceAdded: (facts.storage?.addedAgeDays as number | undefined) ?? null,
            rating: (facts.metadata?.rating as number | undefined) ?? null,
            isDuplicate: item.duplicateGroupId != null,
          });

          await this.prisma.mediaCleanupCandidate.create({
            data: {
              runId,
              policyVersionId: run.policyVersionId,
              mediaItemId: item.id,
              mediaFileId: file.id,
              mediaLibraryId: item.libraryId,
              path: file.path,
              fileSizeBytes: BigInt(file.size ?? 0),
              status,
              exclusionReason: exclusion.excluded ? (exclusion.reason ?? null) : null,
              fingerprint,
              reasonSnapshot: {
                policyVersionId: run.policyVersionId,
                matchedAt: new Date().toISOString(),
                outcome: verdict.outcome,
                matchedConditions: verdict.matchedConditions,
                unmeasuredConditions: verdict.unmeasuredConditions,
                exclusionReasons: exclusion.allReasons,
                facts: flattenFacts(facts),
                estimatedReclaimBytes: Number(file.size ?? 0),
              } as object,
              rankScore: ranking.score,
              rankReasons: ranking.contributions as unknown as object,
              protectionState: { isProtected: ctx.isProtected, hasLegalHold: ctx.hasLegalHold } as object,
              estimatedReclaimBytes: BigInt(file.size ?? 0),
            },
          });
        }
      }

      await this.prisma.mediaCleanupRun.update({
        where: { id: runId },
        data: {
          filesScanned: scanned, itemsEvaluated: evaluated, candidatesMatched: matched,
          candidatesExcluded: excluded, candidatesEligible: eligible,
          estimatedReclaimBytes: estimatedBytes, exclusionBreakdown: breakdown as object,
        },
      });
      this.emit('media.cleanup.run.progress', { runId, scanned, evaluated, eligible });

      if (items.length < PAGE_SIZE) break;
      if (cap && evaluated >= cap) { truncated = true; break; }
    }

    await this.finalize(
      runId,
      truncated ? 'partial' : 'completed',
      truncated ? `evaluation_cap_reached:${cap}` : undefined,
    );
  }

  // ── reads ──────────────────────────────────────────────────────────────────
  async getRun(runId: string) {
    const run = await this.prisma.mediaCleanupRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Cleanup run not found');
    return run;
  }

  async listRuns(query: { page?: number; pageSize?: number; policyId?: string; status?: string }) {
    const params = parsePage(query.page, query.pageSize, 25, 200);
    const where: Record<string, unknown> = {};
    if (query.policyId) where.policyId = query.policyId;
    if (query.status) where.status = query.status;
    return paginate(this.prisma.mediaCleanupRun, { where, orderBy: { createdAt: 'desc' } }, params);
  }

  async listCandidates(
    runId: string,
    query: { page?: number; pageSize?: number; status?: string; sort?: string },
  ) {
    const params = parsePage(query.page, query.pageSize, 50, 200);
    // Default to the actionable set; an operator inspecting exclusions asks for them.
    const where: Record<string, unknown> = { runId, status: query.status ?? 'candidate' };
    const orderBy =
      query.sort === 'size' ? { fileSizeBytes: 'desc' as const }
      : query.sort === 'path' ? { path: 'asc' as const }
      : { rankScore: 'desc' as const };
    return paginate(this.prisma.mediaCleanupCandidate, { where, orderBy }, params);
  }

  /** Cooperative: the scan loop notices at its next page boundary. */
  async cancelRun(runId: string, user: AuthenticatedUser) {
    const run = await this.getRun(runId);
    if (!['queued', 'running'].includes(run.status)) {
      throw new BadRequestException(`Run is ${run.status} and cannot be cancelled`);
    }
    await this.prisma.mediaCleanupRun.update({ where: { id: runId }, data: { status: 'cancelling' } });
    await this.audit.record({
      userId: user.id, action: 'library_cleanup.run.cancelled',
      objectType: 'media_cleanup_run', objectId: runId,
    });
    return { status: 'cancelling' };
  }

  /**
   * Recompute a file's fingerprint against the world as it is NOW, using exactly
   * the code path discovery used. The executor calls this immediately before
   * touching a file; anything but an identical hash is drift, and drift means skip.
   *
   * Returns null when the file's record has gone — the fingerprint's subject no
   * longer exists, which the caller must treat as drift rather than as "unchanged".
   */
  async fingerprintNow(
    mediaFileId: string,
    policyVersionId: string,
  ): Promise<{ fingerprint: string; facts: Record<string, unknown>; factKeys: string[] } | null> {
    const version = await this.prisma.mediaCleanupPolicyVersion.findUnique({
      where: { id: policyVersionId },
    });
    const document = version?.document as unknown as CleanupPolicyDocument | undefined;
    if (!document) return null;

    const file = await this.prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: { ...FILE_SELECT, item: { select: ITEM_SELECT } },
    });
    if (!file?.item) return null;

    const factKeys = [...collectFieldIds(document.conditions)];
    const ctx = await this.buildContext(file.item as never, file as never, document);
    const facts = assembleEvaluationFacts(file as never, file.item as never, ctx);
    const flat = flattenFacts(facts);

    return {
      fingerprint: candidateFingerprint({
        mediaFileId: file.id,
        path: file.path,
        fileSizeBytes: file.size ?? 0,
        modifiedAtMs: null,
        identityKeys: (file.item.externalIds ?? []).map((e) => `${e.provider}:${e.externalId}`),
        policyVersionId,
        facts: flat,
        factKeys,
        isProtected: ctx.isProtected,
        protectionIds: ctx.protectionIds ?? [],
        replacementFileId: null,
      }),
      facts: flat,
      factKeys,
    };
  }

  // ── context ────────────────────────────────────────────────────────────────
  /**
   * Assemble the per-file context. Facts that cannot yet be sourced default to the
   * SAFE direction, and the executor re-checks every one of them immediately before
   * touching a file (Phase 8) — discovery never deletes, so a conservative answer
   * here costs a candidate, not data.
   */
  private async buildContext(
    item: { id: string; libraryId: string; library?: { kind?: string | null; path?: string | null } | null },
    file: { id: string; path: string },
    _document: CleanupPolicyDocument,
  ): Promise<RawContext & { protectionIds: string[] }> {
    const protection = await this.protections.evaluate({
      mediaItemId: item.id, mediaFileId: file.id, mediaLibraryId: item.libraryId, path: file.path,
    });

    // Path confinement, through the STORAGE boundary — a library may legitimately
    // sit outside the operator's narrowed browse root.
    let withinHardRoots = false;
    let isSystemPath = false;
    try {
      this.filePath.assertWithinHardRoots(file.path);
      withinHardRoots = true;
    } catch {
      isSystemPath = true;
    }

    const aggregate = await this.prisma.mediaPlaybackAggregate.findUnique({
      where: { mediaItemId: item.id },
    });

    // PlatformJob carries mediaItemId, so "is this item busy" is answerable.
    const activeJobs = await this.prisma.platformJob.count({
      where: {
        mediaItemId: item.id,
        status: { in: ['scheduled', 'queued', 'waiting', 'blocked', 'running', 'pausing', 'paused', 'retrying', 'cancelling'] },
      },
    });

    return {
      libraryKind: item.library?.kind ?? null,
      playback: aggregate ? toAggregateFacts(aggregate) : null,
      playbackComputedAt: aggregate?.computedAt ?? null,
      onWatchlist: false,
      inCollection: false,
      collectionIds: [],
      activePlayback: false,
      hasActiveJob: activeJobs > 0,
      incompleteDownload: false,
      inFlightOperation: false,
      pendingDuplicateResolution: false,
      isLastSurvivingCopy: false,
      hasVerifiedReplacement: false,
      betterReplacementExists: false,
      isProtected: protection.isProtected,
      hasLegalHold: protection.hasLegalHold,
      protectionIds: protection.matches.map((m) => m.id),
      withinHardRoots,
      isSystemPath,
      isLibraryRoot: item.library?.path != null && file.path === item.library.path,
      fileExists: true,
    };
  }

  private scopeWhere(document: CleanupPolicyDocument): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    const scope = document.scope ?? {};
    if (scope.libraryIds?.length) where.libraryId = { in: scope.libraryIds };
    if (scope.libraryKinds?.length) where.library = { kind: { in: scope.libraryKinds } };
    return where;
  }

  private async finalize(runId: string, status: string, reason?: string): Promise<void> {
    const now = new Date();
    await this.prisma.mediaCleanupRun.update({
      where: { id: runId },
      data: {
        status,
        // `partial` finished too — it just did not cover the whole scope.
        completedAt: status === 'completed' || status === 'partial' ? now : null,
        failedAt: status === 'failed' ? now : null,
        cancelledAt: status === 'cancelled' ? now : null,
        errorSummary: reason ?? null,
      },
    });
    this.emit(`media.cleanup.run.${status}`, { runId, reason: reason ?? null });
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    try {
      this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, { event, payload, at: new Date().toISOString() });
    } catch (err) {
      this.logger.debug(`emit ${event}: ${(err as Error).message}`);
    }
  }
}

/** Does any condition in the tree demand probe-measured data? */
function usesMeasured(node: PolicyConditionNode): boolean {
  if (isGroup(node)) return node.children.some(usesMeasured);
  return getCondition(node.field)?.requiresMeasuredData === true;
}

/** Facts keyed by catalogue id, for the fingerprint and the reason snapshot. */
function flattenFacts(facts: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [group, values] of Object.entries(facts)) {
    if (!values || typeof values !== 'object') continue;
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      out[`${group}.${key}`] = value;
    }
  }
  return out;
}

function toAggregateFacts(row: {
  startedPlayCount: number; completedPlayCount: number; uniqueViewerCount: number;
  lastPlayedAt: Date | null; maximumProgressPercent: number; averageProgressPercent: number;
  totalPlaybackSeconds: bigint; completionThresholdPercent: number;
  sourceRowCount: number; resolvedSourceRowCount: number;
}): PlaybackAggregateFacts {
  return {
    startedPlayCount: row.startedPlayCount,
    completedPlayCount: row.completedPlayCount,
    uniqueViewerCount: row.uniqueViewerCount,
    lastPlayedAt: row.lastPlayedAt,
    maximumProgressPercent: row.maximumProgressPercent,
    averageProgressPercent: row.averageProgressPercent,
    totalPlaybackSeconds: Number(row.totalPlaybackSeconds),
    sourceRowCount: row.sourceRowCount,
    measuredProgressRowCount: row.resolvedSourceRowCount,
    completionThresholdPercent: row.completionThresholdPercent,
  };
}
