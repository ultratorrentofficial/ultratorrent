import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { parseTorrentName } from '../rss/torrent-name-parser';
import { scoreRelease } from '../release-scoring/release-scoring.engine';
import {
  AcquisitionDecision,
  DecisionProfile,
  DecisionSignals,
  decide,
} from './decision.engine';
import { SmartDownloadExecutorService } from './smart-download-executor.service';

export interface EvaluateInput {
  releaseName: string;
  sourceType?: string; // rss | manual | watchlist_sweep | upgrade_sweep | automation
  sourceId?: string;
  profileId?: string;
  sizeBytes?: number;
  seeders?: number;
  /** magnet:/.torrent URL — when present, an auto decision actually downloads. */
  downloadUrl?: string;
  /** Where the engine should save the download. */
  savePath?: string;
}

/** Decisions that carry a download intent, so an action is recorded for them. */
const DOWNLOAD_INTENT: AcquisitionDecision[] = [
  'download',
  'upgrade_existing',
  'replace_existing',
  'hold_for_approval',
];

const RES_RANK: Record<string, number> = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 };
const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/**
 * The acquisition evaluation engine. Gathers signals — reusing Core's release
 * parser and the Release Scoring engine plus a library-gap heuristic over
 * torrent snapshots — runs the pure {@link decide} function, persists an
 * explainable evaluation, emits events, and routes to the approval queue. It
 * NEVER performs file operations; a `download` decision records a pending action
 * (a recommendation) for permission-gated automation to execute.
 */
@Injectable()
export class AcquisitionEvaluatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly executor: SmartDownloadExecutorService,
  ) {}

  async evaluate(input: EvaluateInput, userId?: string) {
    const parsed = parseTorrentName(input.releaseName);
    const titleLower = input.releaseName.toLowerCase();

    // --- profile + watchlist -------------------------------------------------
    const watchlist = await this.matchWatchlist(parsed.title);
    const profileRow = await this.resolveProfile(input.profileId ?? watchlist.item?.profileId ?? undefined);
    const profile = this.toDecisionProfile(profileRow);

    // --- release scoring (reuse the scoring engine) --------------------------
    const score = scoreRelease({
      title: input.releaseName,
      preferredResolution: profileRow?.preferredResolution ?? undefined,
      preferredCodec: profileRow?.preferredCodec ?? undefined,
      preferredSources: profileRow?.preferredSource ? [profileRow.preferredSource] : undefined,
      preferredGroups: arr(profileRow?.preferredGroups),
      excludedTerms: arr(profileRow?.excludedTerms),
      seeders: input.seeders,
    });

    // --- library state + duplicate risk -------------------------------------
    const owned = await this.libraryState(parsed, score.parsed.resolution);
    // A gap is only "needed" if it is WANTED (on the watchlist) and missing. A
    // random release that simply isn't in the library is NOT a tracked gap.
    const needed = watchlist.matched && !owned.owned;
    const library = { needed, ...owned };
    const duplicate = this.duplicateRisk(owned);
    const storage = { ok: true, nearThreshold: false }; // storage rules scaffold

    const signals: DecisionSignals = {
      score: { value: score.score, warnings: score.warnings, rejected: score.decision === 'reject' },
      watchlist: { matched: watchlist.matched, ambiguous: watchlist.ambiguous },
      library,
      duplicate,
      storage,
      sizeBytes: input.sizeBytes,
      titleLower,
    };

    const result = decide(signals, profile);

    // --- persist -------------------------------------------------------------
    const evaluation = await this.prisma.mediaAcquisitionEvaluation.create({
      data: {
        sourceType: input.sourceType ?? 'manual',
        sourceId: input.sourceId,
        releaseName: input.releaseName,
        parsedMetadata: parsed as unknown as object,
        watchlistItemId: watchlist.item?.id,
        profileId: profileRow?.id,
        libraryMatch: library as unknown as object,
        releaseScore: { value: score.score, decision: score.decision, reasons: score.reasons, warnings: score.warnings } as unknown as object,
        duplicateRisk: duplicate as unknown as object,
        qualityGap: { newIsBetter: library.newIsBetter ?? false, ownedResolution: library.ownedResolution ?? null } as unknown as object,
        storageCheck: storage as unknown as object,
        decision: result.decision,
        decisionReason: result.reason,
        priority: watchlist.item?.priority ?? 100,
        confidence: result.confidence,
        requiresApproval: result.requiresApproval,
        approvalStatus: result.requiresApproval ? 'pending' : 'not_required',
        trace: { steps: result.trace } as unknown as object,
      },
    });

    // A download-intent decision records a download action carrying everything
    // the executor needs. Auto (non-approval) decisions execute immediately;
    // held ones stay pending until approve/override drives them.
    if (DOWNLOAD_INTENT.includes(result.decision)) {
      const action = await this.prisma.mediaAcquisitionAction.create({
        data: {
          evaluationId: evaluation.id,
          actionType: 'download_torrent',
          status: 'pending',
          payload: {
            releaseName: input.releaseName,
            downloadUrl: input.downloadUrl,
            savePath: input.savePath,
            supersedeHash:
              result.decision === 'upgrade_existing' || result.decision === 'replace_existing'
                ? owned.ownedTorrentHash ?? undefined
                : undefined,
          } as object,
          createdBy: userId,
        },
      });
      if (!result.requiresApproval && input.downloadUrl) {
        await this.executor.executeAction(action.id, userId);
      }
    }

    await this.history(watchlist.item?.id, evaluation.id, `evaluation.${result.decision}`, result.reason);
    await this.audit.record({ userId, action: 'media_acquisition.evaluation.created', objectType: 'media_acquisition_evaluation', objectId: evaluation.id, metadata: { decision: result.decision } });
    this.emit(evaluation.id, result.decision, result.requiresApproval);
    return evaluation;
  }

  // --- signal gathering ----------------------------------------------------

  private async matchWatchlist(title?: string | null) {
    if (!title) return { matched: false, ambiguous: false, item: null as { id: string; profileId: string | null; priority: number } | null };
    const norm = title.toLowerCase().trim();
    const items = await this.prisma.mediaAcquisitionWatchlistItem.findMany({
      where: { status: 'active', normalizedTitle: { contains: norm } },
      orderBy: { priority: 'asc' },
    });
    return { matched: items.length > 0, ambiguous: items.length > 1, item: items[0] ?? null };
  }

  /** Whether this exact release is already in the library, and at what quality. */
  private async libraryState(parsed: { title?: string | null; season?: number | null; episode?: number | null; year?: number | null }, candidateRes: string | null) {
    if (!parsed.title) return { owned: false, ambiguous: true, reason: 'unparseable title', ownedTorrentHash: null as string | null };
    const title = parsed.title;
    const marker =
      parsed.season != null && parsed.episode != null
        ? `s${String(parsed.season).padStart(2, '0')}e${String(parsed.episode).padStart(2, '0')}`
        : parsed.year != null
          ? String(parsed.year)
          : null;

    const existing = await this.prisma.torrentSnapshot.findMany({
      where: { name: { contains: title, mode: 'insensitive' } },
      select: { name: true, hash: true },
      take: 25,
    });
    const ownedRow = marker ? existing.find((s) => s.name.toLowerCase().includes(marker)) : existing[0];
    if (!ownedRow) return { owned: false, reason: marker ? `${marker} not in library` : 'not in library', ownedTorrentHash: null as string | null };

    const ownedRes = this.detectResolution(ownedRow.name);
    const newIsBetter = this.resRank(candidateRes) > this.resRank(ownedRes);
    return {
      owned: true,
      newIsBetter,
      ownedResolution: ownedRes,
      ownedTorrentHash: ownedRow.hash as string | null,
      reason: newIsBetter ? 'owned, lower quality' : 'owned in equal/better quality',
    };
  }

  private duplicateRisk(library: { owned: boolean; newIsBetter?: boolean }) {
    if (!library.owned) return { level: 'low' as const, reason: 'not owned' };
    if (library.newIsBetter) return { level: 'medium' as const, reason: 'owned but lower quality — upgrade risk' };
    return { level: 'high' as const, reason: 'already owned in equal/better quality' };
  }

  private detectResolution(name: string): string | null {
    const m = /\b(2160p|1080p|720p|480p)\b/i.exec(name);
    return m ? m[1].toLowerCase() : null;
  }
  private resRank(res: string | null): number {
    return res ? (RES_RANK[res.toLowerCase()] ?? 0) : 0;
  }

  private async resolveProfile(profileId?: string) {
    if (profileId) {
      const p = await this.prisma.mediaAcquisitionProfile.findUnique({ where: { id: profileId } });
      if (p) return p;
    }
    return this.prisma.mediaAcquisitionProfile.findFirst({ where: { enabled: true }, orderBy: { createdAt: 'asc' } });
  }

  private toDecisionProfile(p: {
    minimumScore?: number; approvalScore?: number; excludedTerms?: unknown; requiredTerms?: unknown;
    duplicateRules?: unknown; automationRules?: unknown;
  } | null): DecisionProfile {
    const dup = (p?.duplicateRules ?? {}) as { allowUpgrades?: boolean };
    const auto = (p?.automationRules ?? {}) as { approvalRequired?: boolean };
    return {
      minimumScore: p?.minimumScore ?? 0,
      approvalScore: p?.approvalScore ?? 0,
      excludedTerms: arr(p?.excludedTerms),
      requiredTerms: arr(p?.requiredTerms),
      allowUpgrades: dup.allowUpgrades ?? true,
      approvalRequired: auto.approvalRequired ?? false,
    };
  }

  private async history(watchlistItemId: string | undefined, evaluationId: string, eventType: string, message: string) {
    await this.prisma.mediaAcquisitionHistory.create({ data: { watchlistItemId, evaluationId, eventType, message } }).catch(() => undefined);
  }

  private emit(id: string, decision: AcquisitionDecision, approval: boolean) {
    this.realtime.broadcast('media_acquisition.evaluation.created', { id, decision });
    if (approval) this.realtime.broadcast('media_acquisition.approval.required', { id });
    else if (decision === 'download' || decision === 'upgrade_existing') this.realtime.broadcast('media_acquisition.download.recommended', { id, decision });
    else if (decision === 'skip') this.realtime.broadcast('media_acquisition.download.skipped', { id });
  }
}
