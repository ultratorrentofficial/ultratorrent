import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AcquisitionDecision } from './decision.engine';
import { SmartDownloadExecutorService } from './smart-download-executor.service';

/**
 * Approval queue: approve / reject / override held evaluations. Approving (or
 * overriding to a download) executes the evaluation's pending download action
 * through the Smart Download executor — adding the release to the engine and,
 * on an upgrade, removing the superseded torrent. All actions are audited.
 */
@Injectable()
export class AcquisitionApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly executor: SmartDownloadExecutorService,
  ) {}

  queue() {
    return this.prisma.mediaAcquisitionEvaluation.findMany({
      where: { approvalStatus: 'pending' },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
  }

  private async getPending(id: string) {
    const ev = await this.prisma.mediaAcquisitionEvaluation.findUnique({ where: { id } });
    if (!ev) throw new NotFoundException(`Unknown evaluation: ${id}`);
    return ev;
  }

  async approve(id: string, userId?: string) {
    const ev = await this.getPending(id);
    if (ev.approvalStatus !== 'pending') throw new BadRequestException(`Evaluation is ${ev.approvalStatus}, not pending`);
    const updated = await this.prisma.mediaAcquisitionEvaluation.update({
      where: { id },
      data: { approvalStatus: 'approved', actionTaken: 'approved' },
    });
    // Approving executes the pending download action recorded at evaluation time.
    const exec = await this.executor.executeForEvaluation(id, userId);
    await this.record(
      id,
      ev.watchlistItemId,
      'evaluation.approved',
      exec.torrentHash ? `Approved — acquiring ${exec.torrentHash}` : 'Approved by operator',
      userId,
    );
    await this.audit.record({ userId, action: 'media_acquisition.evaluation.approved', objectType: 'media_acquisition_evaluation', objectId: id });
    this.realtime.broadcast('media_acquisition.evaluation.approved', { id });
    return updated;
  }

  async reject(id: string, reason: string | undefined, userId?: string) {
    const ev = await this.getPending(id);
    if (ev.approvalStatus !== 'pending') throw new BadRequestException(`Evaluation is ${ev.approvalStatus}, not pending`);
    const updated = await this.prisma.mediaAcquisitionEvaluation.update({
      where: { id },
      data: { approvalStatus: 'rejected', actionTaken: 'rejected', decisionReason: reason ?? ev.decisionReason },
    });
    await this.record(id, ev.watchlistItemId, 'evaluation.rejected', reason ?? 'Rejected by operator', userId);
    await this.audit.record({ userId, action: 'media_acquisition.evaluation.rejected', objectType: 'media_acquisition_evaluation', objectId: id, metadata: { reason } });
    this.realtime.broadcast('media_acquisition.evaluation.rejected', { id });
    return updated;
  }

  /** Override forces a decision (requires the stronger override permission). */
  async override(id: string, decision: AcquisitionDecision, reason: string | undefined, userId?: string) {
    const ev = await this.getPending(id);
    const updated = await this.prisma.mediaAcquisitionEvaluation.update({
      where: { id },
      data: {
        decision,
        decisionReason: `OVERRIDE: ${reason ?? decision}`,
        approvalStatus: decision === 'skip' ? 'rejected' : 'approved',
        actionTaken: 'overridden',
      },
    });
    if (decision === 'download' || decision === 'upgrade_existing' || decision === 'replace_existing') {
      // Execute the pending action (present when the original decision carried a
      // download intent, e.g. hold_for_approval); no-op if there is none.
      await this.executor.executeForEvaluation(id, userId);
    }
    await this.record(id, ev.watchlistItemId, 'evaluation.overridden', `Overridden to ${decision}`, userId);
    await this.audit.record({ userId, action: 'media_acquisition.evaluation.overridden', objectType: 'media_acquisition_evaluation', objectId: id, metadata: { decision, reason } });
    return updated;
  }

  private async record(evaluationId: string, watchlistItemId: string | null, eventType: string, message: string, _userId?: string) {
    await this.prisma.mediaAcquisitionHistory
      .create({ data: { evaluationId, watchlistItemId: watchlistItemId ?? undefined, eventType, message } })
      .catch(() => undefined);
  }
}
