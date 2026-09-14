import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { TorrentRejectedError } from '../../domain/engine/engine-errors';

/** What an evaluation's download action needs in order to actually acquire. */
export interface DownloadActionPayload {
  releaseName?: string;
  downloadUrl?: string; // magnet: or .torrent URL — required to execute
  savePath?: string;
  supersedeHash?: string; // existing torrent to remove on an upgrade/replace
  override?: boolean;
  /**
   * When set, the download is staged for Media Intake under this storage profile
   * (rather than filed straight into the library). After the add, an `IntakeIntent`
   * keyed on `(engineId, hash)` is written so the completion trigger imports it —
   * the rule-free intake path a Backfill-Only add (no RSS rule) relies on.
   */
  intakeProfileId?: string | null;
}

export interface ExecutionResult {
  status: 'completed' | 'failed' | 'skipped';
  torrentHash?: string | null;
  removedHash?: string | null;
  error?: string;
  /**
   * The engine refused THIS RELEASE (as opposed to being unreachable). Callers
   * that pick releases use it to stop re-offering the same one: a refusal is a
   * fact about the release, an outage is not. See {@link TorrentRejectedError}.
   */
  refused?: boolean;
}

/**
 * The execution half of Smart Download. The decision engine produces a
 * `download_torrent` action (a recommendation); this service turns it into a
 * real acquisition — adding the release to the torrent engine and, on an
 * upgrade/replace decision, removing the superseded torrent + data. It is
 * idempotent per action (a non-pending action is a no-op), so evaluate/approve/
 * override can all safely drive it. This closes the long-standing gap where a
 * `download` decision recorded a pending action that nothing ever executed.
 */
@Injectable()
export class SmartDownloadExecutorService {
  private readonly logger = new Logger(SmartDownloadExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Execute the pending `download_torrent` action for an evaluation, if any.
   * Used by the approval/override paths where the action already exists.
   */
  async executeForEvaluation(evaluationId: string, userId?: string): Promise<ExecutionResult> {
    const action = await this.prisma.mediaAcquisitionAction.findFirst({
      where: { evaluationId, actionType: 'download_torrent', status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    if (!action) return { status: 'skipped', error: 'no pending download action' };
    return this.executeAction(action.id, userId);
  }

  /** Execute a single pending download action. Safe to call more than once. */
  async executeAction(actionId: string, userId?: string): Promise<ExecutionResult> {
    const action = await this.prisma.mediaAcquisitionAction.findUnique({ where: { id: actionId } });
    if (!action) return { status: 'skipped', error: 'action not found' };
    if (action.actionType !== 'download_torrent') return { status: 'skipped', error: 'not a download action' };
    if (action.status !== 'pending') return { status: 'skipped', error: `already ${action.status}` };

    const evaluation = await this.prisma.mediaAcquisitionEvaluation.findUnique({
      where: { id: action.evaluationId },
    });

    const payload = (action.payload ?? {}) as DownloadActionPayload;
    if (!payload.downloadUrl) {
      // A decision with no release URL (e.g. a missing-episode candidate that has
      // no available release yet) is advisory only — record it and stop.
      await this.markFailed(actionId, 'no download URL — advisory only');
      return { status: 'failed', error: 'no download URL' };
    }

    await this.prisma.mediaAcquisitionAction.update({ where: { id: actionId }, data: { status: 'running' } });

    try {
      const provider = await this.registry.getDefault();
      const url = payload.downloadUrl;
      const hash = url.startsWith('magnet:')
        ? await provider.addMagnet(url, { savePath: payload.savePath })
        : await provider.addTorrentURL(url, { savePath: payload.savePath });

      // A staged-for-intake grab (a Backfill-Only add, which has no RSS rule) records
      // an intake intent so the completion trigger recognises the download as one of
      // its own and runs the pipeline — the rule-free provenance path. Best-effort:
      // the torrent is already added, so a failure here must not fail the grab.
      if (payload.intakeProfileId) {
        await this.recordIntakeIntent(payload.intakeProfileId, hash, userId);
      }

      const decision = evaluation?.decision;
      const isUpgrade = decision === 'upgrade_existing' || decision === 'replace_existing';
      let removedHash: string | null = null;
      if (isUpgrade && payload.supersedeHash && payload.supersedeHash !== hash) {
        await provider.removeTorrentAndData(payload.supersedeHash);
        removedHash = payload.supersedeHash;
      }

      await this.prisma.mediaAcquisitionAction.update({
        where: { id: actionId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          result: { torrentHash: hash, removedHash } as object,
        },
      });
      await this.prisma.mediaAcquisitionEvaluation
        .update({ where: { id: action.evaluationId }, data: { actionTaken: removedHash ? 'upgraded' : 'downloaded' } })
        .catch(() => undefined);
      await this.prisma.mediaAcquisitionHistory
        .create({
          data: {
            evaluationId: action.evaluationId,
            watchlistItemId: evaluation?.watchlistItemId ?? undefined,
            eventType: removedHash ? 'download.upgraded' : 'download.started',
            message: removedHash
              ? `Upgrade acquired ${hash}; removed superseded ${removedHash}`
              : `Download started (${hash})`,
          },
        })
        .catch(() => undefined);

      this.realtime.broadcast(
        removedHash ? 'media_acquisition.upgrade.completed' : 'media_acquisition.download.started',
        { evaluationId: action.evaluationId, actionId, torrentHash: hash, removedHash },
      );
      await this.audit.record({
        userId,
        action: removedHash ? 'media_acquisition.upgrade.executed' : 'media_acquisition.download.executed',
        objectType: 'media_acquisition_action',
        objectId: actionId,
        metadata: { torrentHash: hash, removedHash, releaseName: payload.releaseName },
      });
      return { status: 'completed', torrentHash: hash, removedHash };
    } catch (e) {
      const msg = (e as Error).message;
      const refused = e instanceof TorrentRejectedError;
      await this.markFailed(actionId, msg);
      this.realtime.broadcast('media_acquisition.download.failed', {
        evaluationId: action.evaluationId,
        actionId,
        error: msg,
      });
      await this.audit.record({
        userId,
        action: 'media_acquisition.download.failed',
        objectType: 'media_acquisition_action',
        objectId: actionId,
        result: 'failure',
        metadata: { error: msg, refused, releaseName: payload.releaseName },
      });
      this.logger.warn(`Smart Download execution failed for action ${actionId}: ${msg}`);
      return { status: 'failed', error: msg, refused };
    }
  }

  private async markFailed(actionId: string, errorMessage: string): Promise<void> {
    await this.prisma.mediaAcquisitionAction
      .update({ where: { id: actionId }, data: { status: 'failed', completedAt: new Date(), errorMessage } })
      .catch(() => undefined);
  }

  /**
   * Record an intake intent for a staged download, keyed on the engine it was added
   * to plus its hash. Mirrors the torrent client's own intent record — the trigger's
   * first, rule-free provenance source. Best-effort by design: the torrent is already
   * in the engine, so a failure is logged and the file simply waits in staging.
   */
  private async recordIntakeIntent(profileId: string, hash: string, userId?: string): Promise<void> {
    try {
      const engineId = await this.registry.getDefaultEngineId();
      await this.prisma.intakeIntent.upsert({
        where: { engineId_hash: { engineId, hash } },
        create: { engineId, hash, profileId, createdById: userId ?? null },
        update: { profileId, createdById: userId ?? null, consumedAt: null },
      });
    } catch (err) {
      this.logger.error(
        `Grab ${hash} was added but its intake intent could not be recorded: ${(err as Error).message}. ` +
          `It will download to the staging root and wait there.`,
      );
    }
  }
}
