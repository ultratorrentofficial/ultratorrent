import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  MediaAttentionAction,
  MediaAttentionDisposition,
  MediaAttentionEvent,
} from '@ultratorrent/shared';

import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { attentionPriority } from './priority';

/**
 * The write side of the Attention Center.
 *
 * Everything here records what a PERSON decided. Nothing here touches
 * `resolvedAt`, `severity` or `evidence` — those belong to the evaluator, and
 * a disposition that could rewrite them would let "I don't want to see this"
 * masquerade as "this is fixed".
 */

/** What actually happened to one finding. Reported, never silently dropped. */
export type DispositionOutcome = 'applied' | 'skipped_resolved' | 'unknown';

export interface DispositionResult {
  applied: number;
  /** Ids that named nothing. Reported so a stale selection is visible. */
  unknown: string[];
  /**
   * Findings the evaluator resolved between the operator selecting them and
   * the request arriving. Skipped rather than resurrected: a disposition must
   * never drag a closed finding back open.
   */
  skippedResolved: string[];
}

const EVENT_FOR: Record<MediaAttentionAction, MediaAttentionEvent> = {
  acknowledge: 'acknowledged',
  snooze: 'snoozed',
  dismiss: 'dismissed',
  reset: 'disposition_reset',
};

/**
 * The state each verb leaves behind.
 *
 * A plain map rather than something derived from {@link EVENT_FOR}: the event
 * name and the resulting state are two different vocabularies that merely
 * look alike today, and inferring one from the other would break silently the
 * first time a verb is renamed.
 */
const DISPOSITION_FOR: Record<MediaAttentionAction, MediaAttentionDisposition> = {
  acknowledge: 'acknowledged',
  snooze: 'snoozed',
  dismiss: 'dismissed',
  reset: 'unreviewed',
};

@Injectable()
export class AttentionDispositionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Apply one disposition to a set of findings.
   *
   * Single and bulk share this path: a "bulk" operation of one is not a
   * different operation, and two code paths would eventually disagree about
   * concurrency or history.
   */
  async apply(
    action: MediaAttentionAction,
    findingIds: readonly string[],
    actorUserId: string,
    opts: { reason?: string; snoozedUntil?: string } = {},
  ): Promise<DispositionResult> {
    // Duplicates collapse: selecting a row twice is one decision.
    const unique = [...new Set(findingIds.filter((id) => typeof id === 'string' && id))];
    if (!unique.length) throw new BadRequestException('No findings selected.');

    let snoozedUntil: Date | null = null;
    if (action === 'snooze') {
      if (!opts.snoozedUntil) throw new BadRequestException('A snooze needs an expiry.');
      snoozedUntil = new Date(opts.snoozedUntil);
      if (Number.isNaN(snoozedUntil.getTime())) throw new BadRequestException('Invalid snooze expiry.');
      if (snoozedUntil.getTime() <= Date.now()) {
        // An expiry in the past would be read as "already elapsed" by the
        // query-time interpretation and silently do nothing.
        throw new BadRequestException('The snooze expiry must be in the future.');
      }
    }

    const rows = await this.prisma.mediaIntelligenceFinding.findMany({
      where: { id: { in: unique } },
      select: { id: true, severity: true, disposition: true, resolvedAt: true },
    });
    const found = new Map(rows.map((r) => [r.id, r]));
    const unknown = unique.filter((id) => !found.has(id));

    const actionable = rows.filter((r) => r.resolvedAt == null);
    const skippedResolved = rows.filter((r) => r.resolvedAt != null).map((r) => r.id);
    if (!actionable.length) {
      return { applied: 0, unknown, skippedResolved };
    }

    const now = new Date();
    const disposition = DISPOSITION_FOR[action];

    /*
     * Grouped by severity so the recomputed rank is right for each row while
     * still issuing a handful of statements rather than one per finding.
     * `resolvedAt: null` in the filter is the concurrency guard: a finding
     * the evaluator closed a millisecond ago is left closed.
     */
    const bySeverity = new Map<string, string[]>();
    for (const r of actionable) {
      const list = bySeverity.get(r.severity) ?? [];
      list.push(r.id);
      bySeverity.set(r.severity, list);
    }

    let applied = 0;
    for (const [severity, ids] of bySeverity) {
      const res = await this.prisma.mediaIntelligenceFinding.updateMany({
        where: { id: { in: ids }, resolvedAt: null },
        data: {
          disposition,
          snoozedUntil: action === 'snooze' ? snoozedUntil : null,
          dispositionAt: action === 'reset' ? null : now,
          dispositionBy: action === 'reset' ? null : actorUserId,
          dispositionReason: action === 'reset' ? null : (opts.reason ?? null),
          // Clearing the escalation marker is part of deciding: the operator
          // has now seen why it came back.
          escalationReason: null,
          attentionPriority: attentionPriority(severity, disposition),
        },
      });
      applied += res.count;
    }

    // History records the decision, once per finding, with the actor.
    await this.prisma.mediaIntelligenceFindingEvent.createMany({
      data: actionable.map((r) => ({
        findingId: r.id,
        event: EVENT_FOR[action],
        actorUserId,
        detail: {
          from: r.disposition,
          to: disposition,
          ...(snoozedUntil ? { snoozedUntil: snoozedUntil.toISOString() } : {}),
          ...(opts.reason ? { reason: opts.reason } : {}),
        },
      })),
    });

    return { applied, unknown, skippedResolved };
  }
}
