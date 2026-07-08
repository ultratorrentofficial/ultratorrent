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
import { compareQuality } from './quality-compare';

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

/** One clickable stage of the Decision Simulator's visual pipeline. */
export interface SimulationStage {
  key: string;
  label: string;
  status: 'success' | 'warning' | 'blocked' | 'info';
  summary: string;
  detail?: Record<string, unknown>;
}

/** A dry-run explanation of what the engine would decide — no side effects. */
export interface SimulationResult {
  releaseName: string;
  decision: AcquisitionDecision;
  reason: string;
  confidence: number;
  requiresApproval: boolean;
  profile: { id: string; name: string } | null;
  stages: SimulationStage[];
  trace: unknown;
}

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

  /**
   * Gather every acquisition signal and run the pure decision — with NO side
   * effects (no persistence, no download). Shared by {@link evaluate} (which
   * persists + executes) and {@link simulate} (which just explains).
   */
  private async gather(input: EvaluateInput) {
    const parsed = parseTorrentName(input.releaseName);
    const titleLower = input.releaseName.toLowerCase();

    const watchlist = await this.matchWatchlist(parsed.title);
    const profileRow = await this.resolveProfile(input.profileId ?? watchlist.item?.profileId ?? undefined);
    const profile = this.toDecisionProfile(profileRow);

    const score = scoreRelease({
      title: input.releaseName,
      preferredResolution: profileRow?.preferredResolution ?? undefined,
      preferredCodec: profileRow?.preferredCodec ?? undefined,
      preferredSources: profileRow?.preferredSource ? [profileRow.preferredSource] : undefined,
      preferredGroups: arr(profileRow?.preferredGroups),
      excludedTerms: arr(profileRow?.excludedTerms),
      seeders: input.seeders,
    });

    const owned = await this.libraryState(parsed, input.releaseName);
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
    return { parsed, watchlist, profileRow, profile, score, owned, library, duplicate, storage, signals, result };
  }

  async evaluate(input: EvaluateInput, userId?: string) {
    const { parsed, watchlist, profileRow, score, owned, library, duplicate, storage, result } =
      await this.gather(input);

    // --- persist -------------------------------------------------------------
    const evaluation = await this.prisma.mediaAcquisitionEvaluation.create({
      data: {
        sourceType: input.sourceType ?? 'manual',
        sourceId: input.sourceId,
        releaseName: input.releaseName,
        // Persist the file size alongside the parsed release metadata so the
        // approval queue can surface it as part of the info to review.
        parsedMetadata: { ...(parsed as object), sizeBytes: input.sizeBytes ?? null } as unknown as object,
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
        approvalStatus:
          result.decision === 'wait' ? 'waiting' : result.requiresApproval ? 'pending' : 'not_required',
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

  /**
   * Record + execute a grab whose accept decision was already made upstream
   * (e.g. the missing-episode bridge's match-preference engine, which applies
   * quality + size gating itself). Skips the profile scorer/decision engine
   * entirely — it just persists a `download` evaluation, records the action, and
   * runs the executor. Used so match preferences, not a quality profile, decide.
   */
  async grabSelected(
    input: {
      releaseName: string;
      downloadUrl?: string;
      sizeBytes?: number;
      seeders?: number;
      watchlistItemId?: string;
      sourceType?: string;
      sourceId?: string;
      priority?: number;
      reason: string;
      savePath?: string;
    },
    userId?: string,
  ) {
    const evaluation = await this.prisma.mediaAcquisitionEvaluation.create({
      data: {
        sourceType: input.sourceType ?? 'watchlist_sweep',
        sourceId: input.sourceId,
        releaseName: input.releaseName,
        parsedMetadata: { sizeBytes: input.sizeBytes ?? null } as object,
        watchlistItemId: input.watchlistItemId,
        releaseScore: { value: null, source: 'match_preferences', reason: input.reason } as object,
        decision: 'download',
        decisionReason: input.reason,
        priority: input.priority ?? 100,
        confidence: 100,
        requiresApproval: false,
        approvalStatus: 'not_required',
        trace: { steps: [{ step: 'match_preferences', status: 'success', reason: input.reason }] } as object,
      },
    });
    if (input.downloadUrl) {
      const action = await this.prisma.mediaAcquisitionAction.create({
        data: {
          evaluationId: evaluation.id,
          actionType: 'download_torrent',
          status: 'pending',
          payload: {
            releaseName: input.releaseName,
            downloadUrl: input.downloadUrl,
            savePath: input.savePath,
          } as object,
          createdBy: userId,
        },
      });
      await this.executor.executeAction(action.id, userId);
    }
    await this.history(input.watchlistItemId, evaluation.id, 'evaluation.download', input.reason);
    await this.audit.record({
      userId,
      action: 'media_acquisition.evaluation.created',
      objectType: 'media_acquisition_evaluation',
      objectId: evaluation.id,
      metadata: { decision: 'download', via: 'match_preferences' },
    });
    this.emit(evaluation.id, 'download', false);
    return evaluation;
  }

  /**
   * Decision Simulator: run the full pipeline for a release and return the
   * decision + a clickable, stage-by-stage explanation — WITHOUT persisting an
   * evaluation, recording an action, or downloading anything.
   */
  async simulate(input: EvaluateInput): Promise<SimulationResult> {
    const g = await this.gather(input);
    const lib = g.library as typeof g.library & { upgradeReasons?: string[] };
    const isUpgrade = g.result.decision === 'upgrade_existing' || g.result.decision === 'replace_existing';

    const stages: SimulationStage[] = [
      {
        key: 'identify',
        label: 'Identify media',
        status: g.parsed.title ? 'success' : 'warning',
        summary: g.parsed.title
          ? `${g.parsed.title}${g.parsed.year ? ` (${g.parsed.year})` : ''}` +
            (g.parsed.season != null ? ` S${g.parsed.season}${g.parsed.episode != null ? `E${g.parsed.episode}` : ''}` : '')
          : 'Could not parse a title',
        detail: {
          title: g.parsed.title, year: g.parsed.year, season: g.parsed.season, episode: g.parsed.episode,
          contentType: g.parsed.contentType, resolution: g.parsed.resolution, source: g.parsed.source,
          codec: g.parsed.codec, hdr: g.parsed.hdr, audio: g.parsed.audio,
        },
      },
      {
        key: 'matching',
        label: 'Matching preferences',
        status: g.watchlist.matched ? 'success' : 'info',
        summary: g.watchlist.matched
          ? `Matched a watchlist item; profile "${g.profileRow?.name ?? 'default'}"`
          : 'No watchlist match',
        detail: {
          watchlistMatched: g.watchlist.matched,
          ambiguous: g.watchlist.ambiguous,
          profile: g.profileRow
            ? { name: g.profileRow.name, preferredResolution: g.profileRow.preferredResolution, preferredSource: g.profileRow.preferredSource, preferredCodec: g.profileRow.preferredCodec }
            : null,
        },
      },
      {
        key: 'scoring',
        label: 'Release score',
        status: g.score.decision === 'reject' ? 'blocked' : 'success',
        summary: `Score ${g.score.score} (${g.score.decision})`,
        detail: { score: g.score.score, decision: g.score.decision, reasons: g.score.reasons, warnings: g.score.warnings },
      },
      {
        key: 'library',
        label: 'Library comparison',
        status: lib.owned ? (lib.newIsBetter ? 'warning' : 'info') : 'info',
        summary: lib.owned
          ? lib.newIsBetter
            ? `Owned, candidate is better: ${lib.upgradeReasons?.join(', ') || 'higher quality'}`
            : 'Owned in equal/better quality'
          : lib.needed
            ? 'Missing from the library (wanted)'
            : 'Not in the library',
        detail: { owned: lib.owned, needed: lib.needed, newIsBetter: lib.newIsBetter, ownedResolution: lib.ownedResolution, upgradeReasons: lib.upgradeReasons },
      },
      {
        key: 'upgrade',
        label: 'Upgrade rules',
        status: isUpgrade ? 'success' : 'info',
        summary: lib.owned && lib.newIsBetter
          ? g.profile.allowUpgrades ? 'Upgrade allowed by profile' : 'Upgrades disabled on this profile'
          : 'No upgrade applies',
        detail: { allowUpgrades: g.profile.allowUpgrades, waitForBetter: g.profile.waitForBetter, waitUntilScore: g.profile.waitUntilScore },
      },
      {
        key: 'decision',
        label: 'Decision',
        status: g.result.decision === 'skip' ? 'blocked' : 'success',
        summary: `${g.result.decision} — ${g.result.reason}`,
        detail: { decision: g.result.decision, confidence: g.result.confidence, requiresApproval: g.result.requiresApproval },
      },
    ];

    return {
      releaseName: input.releaseName,
      decision: g.result.decision,
      reason: g.result.reason,
      confidence: g.result.confidence,
      requiresApproval: g.result.requiresApproval,
      profile: g.profileRow ? { id: g.profileRow.id, name: g.profileRow.name } : null,
      stages,
      trace: g.result.trace,
    };
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
  private async libraryState(parsed: { title?: string | null; season?: number | null; episode?: number | null; year?: number | null }, candidateTitle: string) {
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

    // Multi-dimensional comparison (resolution/source/HDR/audio), not just resolution.
    const cmp = compareQuality(candidateTitle, ownedRow.name);
    return {
      owned: true,
      newIsBetter: cmp.better,
      ownedResolution: this.detectResolution(ownedRow.name),
      ownedTorrentHash: ownedRow.hash as string | null,
      upgradeReasons: cmp.reasons,
      reason: cmp.better ? `owned, lower quality (${cmp.reasons.join(', ')})` : 'owned in equal/better quality',
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

  private async resolveProfile(profileId?: string) {
    if (profileId) {
      const p = await this.prisma.mediaAcquisitionProfile.findUnique({ where: { id: profileId } });
      if (p) return p;
    }
    return this.prisma.mediaAcquisitionProfile.findFirst({ where: { enabled: true }, orderBy: { createdAt: 'asc' } });
  }

  private toDecisionProfile(p: {
    minimumScore?: number; approvalScore?: number; excludedTerms?: unknown; requiredTerms?: unknown;
    duplicateRules?: unknown; automationRules?: unknown; qualityRules?: unknown;
  } | null): DecisionProfile {
    const dup = (p?.duplicateRules ?? {}) as { allowUpgrades?: boolean };
    const auto = (p?.automationRules ?? {}) as { approvalRequired?: boolean };
    const qual = (p?.qualityRules ?? {}) as { waitForBetter?: boolean; waitUntilScore?: number };
    return {
      minimumScore: p?.minimumScore ?? 0,
      approvalScore: p?.approvalScore ?? 0,
      excludedTerms: arr(p?.excludedTerms),
      requiredTerms: arr(p?.requiredTerms),
      allowUpgrades: dup.allowUpgrades ?? true,
      approvalRequired: auto.approvalRequired ?? false,
      waitForBetter: qual.waitForBetter ?? false,
      waitUntilScore: qual.waitUntilScore ?? 0,
    };
  }

  private async history(watchlistItemId: string | undefined, evaluationId: string, eventType: string, message: string) {
    await this.prisma.mediaAcquisitionHistory.create({ data: { watchlistItemId, evaluationId, eventType, message } }).catch(() => undefined);
  }

  private emit(id: string, decision: AcquisitionDecision, approval: boolean) {
    this.realtime.broadcast('media_acquisition.evaluation.created', { id, decision });
    if (approval) this.realtime.broadcast('media_acquisition.approval.required', { id });
    else if (decision === 'download' || decision === 'upgrade_existing') this.realtime.broadcast('media_acquisition.download.recommended', { id, decision });
    else if (decision === 'wait') this.realtime.broadcast('media_acquisition.waiting', { id });
    else if (decision === 'skip') this.realtime.broadcast('media_acquisition.download.skipped', { id });
  }
}
