import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AcquisitionDecision } from './decision.engine';

/**
 * Approval queue: approve / reject / override held evaluations. Approving a held
 * download records a PENDING download action (a recommendation) — this module
 * never executes downloads or file operations itself. All actions are audited.
 */
@Injectable()
export class AcquisitionApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
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
    // Approving routes the held release to a pending download recommendation.
    await this.prisma.mediaAcquisitionAction.create({
      data: { evaluationId: id, actionType: 'download_torrent', status: 'pending', payload: { releaseName: ev.releaseName } as object, createdBy: userId },
    });
    await this.record(id, ev.watchlistItemId, 'evaluation.approved', 'Approved by operator', userId);
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
      await this.prisma.mediaAcquisitionAction.create({
        data: { evaluationId: id, actionType: 'download_torrent', status: 'pending', payload: { releaseName: ev.releaseName, override: true } as object, createdBy: userId },
      });
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
