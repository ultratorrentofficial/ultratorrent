import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * How much automatic monitoring a template has left.
 *
 * The limits exist to PACE acquisition, not to filter it. A title over budget is
 * held for review and stays in the inbox until somebody acts on it — losing it
 * would be a different feature, and a worse one: the operator asked for less at
 * once, not for less overall.
 *
 * Two decisions shape the counting.
 *
 * **Rolling windows, not calendar days.** "10 per day" means "no more than ten in
 * any day", and a calendar boundary lets twenty land in two minutes across
 * midnight — which is precisely the burst the limit exists to prevent. Rolling
 * also needs no timezone, so the answer cannot change because an operator moved
 * the app's `app.timezone` setting.
 *
 * **Only additions that actually happened count.** A decision of `auto_monitor`
 * whose rule generation then failed produced no monitoring, so it must not spend
 * budget — otherwise a run of failures would silently exhaust the allowance and
 * the titles that could have succeeded would be held behind them. The counter is
 * therefore `watchlistItemId IS NOT NULL`, which is the record that something was
 * really created.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface BudgetState {
  perDay: number;
  perWeek: number;
  usedToday: number;
  usedThisWeek: number;
  remainingToday: number;
  remainingThisWeek: number;
  exhausted: boolean;
  /** Present when exhausted, naming which limit bit. */
  reason?: string;
}

export interface BudgetLimits {
  autoAddLimitPerDay: number;
  autoAddLimitPerWeek: number;
}

@Injectable()
export class DiscoveryBudgetService {
  constructor(private readonly prisma: PrismaService) {}

  /** What this template may still auto-monitor. */
  async state(templateId: string, limits: BudgetLimits, now = new Date()): Promise<BudgetState> {
    const [usedToday, usedThisWeek] = await Promise.all([
      this.countSince(templateId, new Date(now.getTime() - DAY_MS)),
      this.countSince(templateId, new Date(now.getTime() - WEEK_MS)),
    ]);

    const perDay = limits.autoAddLimitPerDay;
    const perWeek = limits.autoAddLimitPerWeek;
    const remainingToday = Math.max(0, perDay - usedToday);
    const remainingThisWeek = Math.max(0, perWeek - usedThisWeek);

    /*
     * A limit of zero means NO automatic additions, not unlimited.
     *
     * It is the literal reading, and the safe one: an operator who typed 0
     * expecting "no cap" gets a template that adds nothing and will notice
     * immediately, where the opposite mistake adds everything and is noticed
     * after the fact.
     */
    const reason =
      remainingToday <= 0
        ? `Automatic-add threshold reached: ${usedToday} of ${perDay} in the last 24 hours`
        : remainingThisWeek <= 0
          ? `Automatic-add threshold reached: ${usedThisWeek} of ${perWeek} in the last 7 days`
          : undefined;

    return {
      perDay,
      perWeek,
      usedToday,
      usedThisWeek,
      remainingToday,
      remainingThisWeek,
      exhausted: reason !== undefined,
      ...(reason ? { reason } : {}),
    };
  }

  /**
   * Additions this template really made since `since`.
   *
   * `watchlistItemId: { not: null }` is the whole point — see the class comment.
   * A decision that failed on its way to becoming monitoring is not an addition.
   */
  private countSince(templateId: string, since: Date): Promise<number> {
    return this.prisma.discoveryEvaluation.count({
      where: {
        templateId,
        decision: 'auto_monitor',
        watchlistItemId: { not: null },
        createdAt: { gte: since },
      },
    });
  }
}
