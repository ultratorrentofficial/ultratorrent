import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const SETTINGS_KEY = 'media_acquisition.settings';
const DEFAULT_SETTINGS = {
  autoEvaluateRss: false,
  defaultProfileId: null as string | null,
  approvalExpiryHours: 72,
  notifyOnApprovalRequired: true,
  // Missing-episode auto-acquire bridge (opt-in, default OFF).
  autoSearchMissing: false,
  searchIntervalMinutes: 60,
  missingSearchProfileId: null as string | null,
  maxSearchesPerSweep: 50,
};

/** Aggregation: overview, evaluations list, recommendations, history, settings, export. */
@Injectable()
export class MediaAcquisitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async overview() {
    const ev = this.prisma.mediaAcquisitionEvaluation;
    const [
      activeWatchlist, pendingApprovals, recommended, skipped, upgrades, waiting,
      approved, rejected, missingEpisodes, missingMovies, recent,
    ] = await Promise.all([
      this.prisma.mediaAcquisitionWatchlistItem.count({ where: { status: 'active' } }),
      ev.count({ where: { approvalStatus: 'pending' } }),
      ev.count({ where: { decision: 'download' } }),
      ev.count({ where: { decision: 'skip' } }),
      ev.count({ where: { decision: { in: ['upgrade_existing', 'replace_existing'] } } }),
      ev.count({ where: { decision: 'wait' } }),
      ev.count({ where: { approvalStatus: 'approved' } }),
      ev.count({ where: { approvalStatus: 'rejected' } }),
      this.prisma.wantedEpisode.count({ where: { status: 'missing' } }),
      this.prisma.wantedMovie.count({ where: { status: 'missing' } }),
      ev.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    return {
      watchlist: { active: activeWatchlist },
      approvals: { pending: pendingApprovals, approved, rejected },
      decisions: { recommended, skipped, upgrades, waiting },
      missing: { episodes: missingEpisodes, movies: missingMovies },
      recent: recent.map((e) => ({ id: e.id, releaseName: e.releaseName, decision: e.decision, reason: e.decisionReason, createdAt: e.createdAt })),
    };
  }

  /** Rejected releases: evaluations that were rejected or skipped. */
  rejected() {
    return this.prisma.mediaAcquisitionEvaluation.findMany({
      where: { OR: [{ approvalStatus: 'rejected' }, { decision: 'skip' }] },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  listEvaluations(filter?: { decision?: string; approvalStatus?: string }) {
    return this.prisma.mediaAcquisitionEvaluation.findMany({
      where: { decision: filter?.decision, approvalStatus: filter?.approvalStatus },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async getEvaluation(id: string) {
    const ev = await this.prisma.mediaAcquisitionEvaluation.findUnique({ where: { id }, include: { actions: true } });
    if (!ev) throw new NotFoundException(`Unknown evaluation: ${id}`);
    return ev;
  }

  /** Waiting queue: releases held while a better one is awaited. */
  waiting() {
    return this.prisma.mediaAcquisitionEvaluation.findMany({
      where: { decision: 'wait' },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
  }

  /** Upgrade queue: upgrade decisions whose download hasn't completed yet. */
  async upgrades() {
    const evals = await this.prisma.mediaAcquisitionEvaluation.findMany({
      where: { decision: { in: ['upgrade_existing', 'replace_existing'] } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { actions: true },
    });
    // Surface whether the upgrade has been executed (an action completed).
    return evals.map((e) => ({
      ...e,
      upgradeStatus: e.actions?.some((a) => a.status === 'completed') ? 'completed' : 'pending',
    }));
  }

  history(limit = 100) {
    return this.prisma.mediaAcquisitionHistory.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(limit, 500) });
  }

  /** Intelligent suggestions derived from the current state. */
  async recommendations() {
    const [pending, upgrades, idleWatchlist] = await Promise.all([
      this.prisma.mediaAcquisitionEvaluation.findMany({ where: { approvalStatus: 'pending' }, take: 25, orderBy: { priority: 'asc' } }),
      this.prisma.mediaAcquisitionEvaluation.findMany({ where: { decision: 'upgrade_existing', approvalStatus: { in: ['not_required', 'pending'] } }, take: 25, orderBy: { createdAt: 'desc' } }),
      this.prisma.mediaAcquisitionWatchlistItem.findMany({ where: { status: 'active' }, take: 50 }),
    ]);
    const evaluated = new Set((await this.prisma.mediaAcquisitionEvaluation.findMany({ where: { watchlistItemId: { in: idleWatchlist.map((w) => w.id) } }, select: { watchlistItemId: true } })).map((e) => e.watchlistItemId));
    return {
      pendingApprovals: pending.map((e) => ({ id: e.id, releaseName: e.releaseName, reason: e.decisionReason })),
      qualityUpgrades: upgrades.map((e) => ({ id: e.id, releaseName: e.releaseName })),
      watchlistWithNoMatches: idleWatchlist.filter((w) => !evaluated.has(w.id)).map((w) => ({ id: w.id, title: w.title })),
    };
  }

  async getSettings() {
    const row = await this.prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
    return { ...DEFAULT_SETTINGS, ...((row?.value as object) ?? {}) };
  }

  async updateSettings(patch: Record<string, unknown>, userId?: string) {
    const current = await this.getSettings();
    const next = { ...current, ...patch };
    await this.prisma.setting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: next as object }, update: { value: next as object } });
    await this.audit.record({ userId, action: 'media_acquisition.settings.updated', objectType: 'setting', objectId: SETTINGS_KEY });
    return next;
  }

  async export(scope: { evaluations?: boolean; watchlist?: boolean; profiles?: boolean }, userId?: string) {
    const out: Record<string, unknown> = { exportedAt: new Date().toISOString() };
    if (scope.evaluations !== false) out.evaluations = await this.prisma.mediaAcquisitionEvaluation.findMany({ take: 1000, orderBy: { createdAt: 'desc' } });
    if (scope.watchlist !== false) out.watchlist = await this.prisma.mediaAcquisitionWatchlistItem.findMany();
    if (scope.profiles !== false) out.profiles = await this.prisma.mediaAcquisitionProfile.findMany();
    await this.audit.record({ userId, action: 'media_acquisition.exported', objectType: 'media_acquisition', metadata: { keys: Object.keys(out) } });
    return out;
  }
}
